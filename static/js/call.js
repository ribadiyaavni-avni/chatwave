/* ChatWave — WhatsApp-style WebRTC calling.
   Media is peer-to-peer (RTCPeerConnection). The Flask/Socket.IO server is
   used ONLY for signaling: call lifecycle + SDP offer/answer + ICE exchange.

   Public API (used by chat.js / home.js):
     CWCall.start(peer, kind)   peer = {id, name, photo}, kind = 'audio'|'video'
*/

(function () {
  "use strict";
  const socket = window.cwSocket;
  if (!socket) return;

  // ---- State ------------------------------------------------------------
  let call = null; // { id, kind, peer, role: 'caller'|'callee', state, startedAt }
  let pc = null;                 // RTCPeerConnection
  let localStream = null;
  let remoteStream = null;
  let pendingIce = [];           // ICE received before remoteDescription is set
  let rtcConfig = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
  let timerInterval = null;
  let facingMode = "user";       // front camera first on mobile
  let micOn = true, camOn = true, speakerOn = true;
  let makingOffer = false;

  // ---- DOM --------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const overlay = $("call-overlay");
  if (!overlay) return; // not an authenticated page

  const ringSec = $("call-ring"), activeSec = $("call-active");
  const remoteVideo = $("remote-video"), localVideo = $("local-video");
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;

  // Fetch ICE config (STUN + optional TURN) once.
  fetch("/api/rtc-config").then((r) => r.json()).then((cfg) => {
    if (cfg && cfg.iceServers) rtcConfig = cfg;
  }).catch(() => {});

  // ---- UI helpers -------------------------------------------------------
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  function openOverlay() { show(overlay); document.body.style.overflow = "hidden"; }
  function closeOverlay() {
    hide(overlay); hide(ringSec); hide(activeSec);
    document.body.style.overflow = "";
  }

  function setRingScreen(mode) { // 'incoming' | 'outgoing'
    openOverlay(); show(ringSec); hide(activeSec);
    $("ring-kind").textContent =
      `ChatWave ${call.kind === "video" ? "video" : "voice"} call`;
    $("ring-name").textContent = call.peer.name;
    $("ring-avatar").src = window.cwAvatarSrc(call.peer.photo, call.peer.name);

    const incoming = mode === "incoming";
    $("ring-status").textContent = incoming ? "Incoming call" : "Calling…";
    ringSec.querySelector(".ring-hint").style.visibility = incoming ? "visible" : "hidden";
    incoming ? show($("btn-accept")) : hide($("btn-accept"));
    incoming ? show($("btn-reject")) : hide($("btn-reject"));
    incoming ? hide($("btn-cancel")) : show($("btn-cancel"));
    window.cwStartRingtone(incoming);
  }

  function setActiveScreen() {
    openOverlay(); hide(ringSec); show(activeSec);
    window.cwStopRingtone();
    $("active-name").textContent = call.peer.name;
    $("active-avatar").src = window.cwAvatarSrc(call.peer.photo, call.peer.name);

    const video = call.kind === "video";
    video ? show($("video-stage")) : hide($("video-stage"));
    video ? hide($("voice-stage")) : show($("voice-stage"));
    video ? show($("btn-cam")) : hide($("btn-cam"));
    video ? show($("btn-flip")) : hide($("btn-flip"));
    updateControlStyles();
    startTimer();
  }

  function updateControlStyles() {
    $("btn-mute").classList.toggle("on", !micOn);
    $("btn-mute").title = micOn ? "Mute microphone" : "Unmute microphone";
    $("btn-cam").classList.toggle("on", !camOn);
    $("btn-cam").title = camOn ? "Turn camera off" : "Turn camera on";
    $("btn-speaker").classList.toggle("on", !speakerOn);
    $("btn-speaker").title = speakerOn ? "Speaker off" : "Speaker on";
  }

  function startTimer() {
    stopTimer();
    const el = $("active-timer");
    el.textContent = "00:00";
    if (!call.startedAt) return;
    timerInterval = setInterval(() => {
      const s = Math.max(0, Math.floor((Date.now() - call.startedAt) / 1000));
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      el.textContent = s >= 3600
        ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${ss}`
        : `${mm}:${ss}`;
    }, 500);
  }
  function stopTimer() { clearInterval(timerInterval); timerInterval = null; }

  function note(text) {
    const el = $("active-note");
    if (!text) { hide(el); return; }
    el.textContent = text; show(el);
  }

  // ---- Media ------------------------------------------------------------
  async function getMedia() {
    // Requests microphone permission (and camera permission for video calls).
    const constraints = {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: call.kind === "video"
        ? { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }
        : false,
    };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (call.kind === "video") {
      localVideo.srcObject = localStream;
      localVideo.classList.toggle("mirror", facingMode === "user");
    }
    micOn = true; camOn = true;
    updateControlStyles();
  }

  function mediaErrorMessage(err) {
    if (err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError"))
      return call.kind === "video"
        ? "Camera and microphone access was blocked. Allow both permissions in your browser and try again."
        : "Microphone access was blocked. Allow the microphone permission in your browser and try again.";
    if (err && err.name === "NotFoundError")
      return "No microphone or camera was found on this device.";
    if (err && err.name === "NotReadableError")
      return "Your camera or microphone is being used by another app.";
    return "Could not access your microphone/camera.";
  }

  function stopLocalMedia() {
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    localVideo.srcObject = null;
  }

  // ---- Peer connection ---------------------------------------------------
  function createPeer() {
    pc = new RTCPeerConnection(rtcConfig);
    remoteStream = new MediaStream();
    if (call.kind === "video") remoteVideo.srcObject = remoteStream;

    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    pc.ontrack = (ev) => {
      ev.streams[0].getTracks().forEach((t) => {
        if (!remoteStream.getTracks().includes(t)) remoteStream.addTrack(t);
      });
      if (call.kind === "video") remoteVideo.srcObject = remoteStream;
      // Audio always routed through a dedicated element (enables setSinkId)
      remoteAudio.srcObject = remoteStream;
      remoteAudio.play().catch(() => {});
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate && call) {
        socket.emit("webrtc:ice", { call_id: call.id, candidate: ev.candidate });
      }
    };

    // Network reconnect handling: on a drop, try an ICE restart (caller side
    // re-offers). "Reconnecting…" is shown until media flows again.
    pc.oniceconnectionstatechange = () => {
      if (!pc || !call) return;
      const st = pc.iceConnectionState;
      if (st === "connected" || st === "completed") {
        note(null);
      } else if (st === "disconnected") {
        note("Reconnecting…");
      } else if (st === "failed") {
        note("Reconnecting…");
        if (call.role === "caller") renegotiate({ iceRestart: true });
      }
    };

    pc.onnegotiationneeded = async () => {
      if (call && call.role === "caller" && call.state === "active") {
        await renegotiate();
      }
    };
  }

  async function renegotiate(opts = {}) {
    if (!pc || !call || makingOffer) return;
    try {
      makingOffer = true;
      const offer = await pc.createOffer(opts);
      await pc.setLocalDescription(offer);
      socket.emit("webrtc:offer", { call_id: call.id, sdp: pc.localDescription });
    } catch (e) { /* transient; ICE state handler retries */ }
    finally { makingOffer = false; }
  }

  async function flushPendingIce() {
    for (const c of pendingIce.splice(0)) {
      try { await pc.addIceCandidate(c); } catch (e) {}
    }
  }

  // ---- Teardown ---------------------------------------------------------
  function teardown() {
    window.cwStopRingtone();
    stopTimer();
    stopLocalMedia();
    if (pc) { try { pc.close(); } catch (e) {} }
    pc = null;
    remoteStream = null;
    remoteVideo.srcObject = null;
    remoteAudio.srcObject = null;
    pendingIce = [];
    makingOffer = false;
    micOn = true; camOn = true; speakerOn = true; facingMode = "user";
    note(null);
    hide($("peer-media-note"));
    call = null;
    closeOverlay();
  }

  function endedMessage(status, kind, duration) {
    const word = kind === "video" ? "Video call" : "Voice call";
    switch (status) {
      case "completed": {
        const mm = Math.floor(duration / 60), ss = String(duration % 60).padStart(2, "0");
        return `${word} ended · ${mm}:${ss}`;
      }
      case "rejected": return `${word} declined`;
      case "missed": return `Missed ${word.toLowerCase()}`;
      case "cancelled": return `${word} cancelled`;
      default: return `${word} ended`;
    }
  }

  // ---- Public: start a call ---------------------------------------------
  window.CWCall = {
    async start(peer, kind) {
      if (call) { window.cwToast("You're already in a call."); return; }
      call = { id: null, kind, peer, role: "caller", state: "starting", startedAt: null };
      try {
        await getMedia();
      } catch (err) {
        const msg = mediaErrorMessage(err);
        call = null;
        window.cwToast(msg, 5000);
        return;
      }
      setRingScreen("outgoing");
      socket.emit("call:start", { to: peer.id, kind });
    },
  };

  // ---- Socket: lifecycle events -----------------------------------------
  socket.on("call:ringing", (d) => {
    if (!call || call.role !== "caller") return;
    call.id = d.call_id;
    call.state = "ringing";
    if (!d.peer_online) $("ring-status").textContent = "Ringing… (they seem to be offline)";
  });

  socket.on("call:incoming", async (d) => {
    if (call) return; // busy in this tab; server also guards double-calls
    call = {
      id: d.call_id, kind: d.kind,
      peer: { id: d.from.id, name: d.from.display_name, photo: d.from.photo },
      role: "callee", state: "ringing", startedAt: null,
    };
    setRingScreen("incoming");
  });

  socket.on("call:accepted", async (d) => {
    if (!call || call.id !== d.call_id) return;
    call.state = "active";
    call.startedAt = d.started_at ? new Date(d.started_at).getTime() : Date.now();
    setActiveScreen();
    if (call.role === "caller") {
      // Caller drives the SDP offer/answer exchange.
      createPeer();
      await renegotiate();
    }
  });

  socket.on("call:ended", (d) => {
    if (!call || call.id !== d.call_id) return;
    const msg = endedMessage(d.status, call.kind, d.duration || 0);
    teardown();
    window.cwToast(msg);
    if (typeof window.cwOnCallFinished === "function") window.cwOnCallFinished();
  });

  socket.on("call:error", (d) => {
    window.cwToast(d.error || "Call failed.");
    if (call && call.state !== "active") teardown();
  });

  // Mid-call page refresh / socket reconnect: server tells us our live call.
  socket.on("call:rejoin", async (d) => {
    if (call) return; // this tab already tracks it
    if (d.status !== "active") return;
    call = {
      id: d.call_id, kind: d.kind,
      peer: { id: d.peer.id, name: d.peer.display_name, photo: d.peer.photo },
      role: d.caller === window.ME.id ? "caller" : "callee",
      state: "active",
      startedAt: d.started_at ? new Date(d.started_at).getTime() : Date.now(),
    };
    try { await getMedia(); } catch (e) { socket.emit("call:end", { call_id: call.id }); teardown(); return; }
    setActiveScreen();
    note("Reconnecting…");
    createPeer();
    if (call.role === "caller") await renegotiate({ iceRestart: true });
  });

  // ---- Socket: WebRTC signaling relay ------------------------------------
  socket.on("webrtc:offer", async (d) => {
    if (!call || call.id !== d.call_id) return;
    if (!pc) createPeer();
    await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
    await flushPendingIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("webrtc:answer", { call_id: call.id, sdp: pc.localDescription });
  });

  socket.on("webrtc:answer", async (d) => {
    if (!call || call.id !== d.call_id || !pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
    await flushPendingIce();
  });

  socket.on("webrtc:ice", async (d) => {
    if (!call || call.id !== d.call_id) return;
    const cand = d.candidate;
    if (pc && pc.remoteDescription) {
      try { await pc.addIceCandidate(cand); } catch (e) {}
    } else {
      pendingIce.push(cand);
    }
  });

  socket.on("peer:connection", (d) => {
    if (call && call.id === d.call_id && d.state === "unstable") note("Reconnecting…");
  });

  socket.on("call:media-state", (d) => {
    if (!call || call.id !== d.call_id) return;
    const el = $("peer-media-note");
    const bits = [];
    if (d.mic === false) bits.push("muted their microphone");
    if (call.kind === "video" && d.cam === false) bits.push("turned their camera off");
    if (bits.length) { el.textContent = `${call.peer.name} ${bits.join(" and ")}`; show(el); }
    else hide(el);
  });

  socket.io.on("reconnect", () => {
    // Server re-sends call:rejoin on connect if we belong to a live call.
    if (call && call.state === "active") note("Reconnecting…");
  });

  // ---- Buttons -----------------------------------------------------------
  $("btn-accept").addEventListener("click", async () => {
    if (!call || call.role !== "callee") return;
    try {
      await getMedia();   // asks for mic (and camera for video) permission
    } catch (err) {
      window.cwToast(mediaErrorMessage(err), 5000);
      socket.emit("call:reject", { call_id: call.id });
      teardown();
      return;
    }
    window.cwStopRingtone();
    socket.emit("call:accept", { call_id: call.id });
  });

  $("btn-reject").addEventListener("click", () => {
    if (!call) return;
    socket.emit("call:reject", { call_id: call.id });
    teardown();
  });

  $("btn-cancel").addEventListener("click", () => {
    if (!call) return;
    if (call.id) socket.emit("call:cancel", { call_id: call.id });
    teardown();
  });

  $("btn-end").addEventListener("click", () => {
    if (!call) return;
    socket.emit("call:end", { call_id: call.id });
    teardown();
  });

  $("btn-mute").addEventListener("click", () => {
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    updateControlStyles();
    if (call) socket.emit("call:media-state", { call_id: call.id, mic: micOn, cam: camOn });
  });

  $("btn-cam").addEventListener("click", () => {
    if (!localStream) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    localVideo.style.opacity = camOn ? "1" : "0.25";
    updateControlStyles();
    if (call) socket.emit("call:media-state", { call_id: call.id, mic: micOn, cam: camOn });
  });

  $("btn-flip").addEventListener("click", async () => {
    // Switch front/back camera (mobile). Uses facingMode + replaceTrack so
    // the call continues without renegotiation.
    if (!localStream || !pc || call.kind !== "video") return;
    facingMode = facingMode === "user" ? "environment" : "user";
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const newTrack = fresh.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) await sender.replaceTrack(newTrack);
      const old = localStream.getVideoTracks()[0];
      if (old) { localStream.removeTrack(old); old.stop(); }
      localStream.addTrack(newTrack);
      newTrack.enabled = camOn;
      localVideo.srcObject = localStream;
      localVideo.classList.toggle("mirror", facingMode === "user");
    } catch (e) {
      facingMode = facingMode === "user" ? "environment" : "user"; // revert
      window.cwToast("Couldn't switch camera on this device.");
    }
  });

  $("btn-speaker").addEventListener("click", async () => {
    speakerOn = !speakerOn;
    // Where the browser supports output routing (Chrome/Edge), switch the
    // audio sink; otherwise fall back to attenuating the remote audio the
    // way an earpiece would.
    let routed = false;
    if (typeof remoteAudio.setSinkId === "function") {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outs = devices.filter((d) => d.kind === "audiooutput");
        const earpiece = outs.find((d) => /earpiece|receiver/i.test(d.label));
        if (speakerOn) { await remoteAudio.setSinkId("default"); routed = true; }
        else if (earpiece) { await remoteAudio.setSinkId(earpiece.deviceId); routed = true; }
      } catch (e) { /* fall through */ }
    }
    if (!routed) remoteAudio.volume = speakerOn ? 1.0 : 0.35;
    updateControlStyles();
  });

  // Leaving the page mid-call: tell the server so the peer isn't left hanging.
  window.addEventListener("beforeunload", () => {
    if (call && call.id) {
      socket.emit(call.state === "active" ? "call:end"
        : call.role === "caller" ? "call:cancel" : "call:reject",
        { call_id: call.id });
    }
  });
})();
