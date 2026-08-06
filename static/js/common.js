/* ChatWave — shared client runtime: socket, presence, toast, ringtone.
   Loaded on every authenticated page (base.html). */

(function () {
  "use strict";

  // ---- Socket.IO (signaling + presence) ---------------------------------
  // Reconnection is on by default; call.js listens for reconnects to
  // recover in-progress calls.
  window.cwSocket = io({
    transports: ["websocket", "polling"],
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  // Presence updates fan out to any page code that cares.
  window.cwPresenceHandlers = [];
  window.cwSocket.on("presence", (p) => {
    window.cwPresenceHandlers.forEach((fn) => fn(p));
  });

  // Legacy heartbeat kept as a fallback for last_seen freshness.
  setInterval(() => {
    fetch("/api/heartbeat", { method: "POST" }).catch(() => {});
  }, 25000);

  // ---- Toast ------------------------------------------------------------
  let toastTimer = null;
  window.cwToast = function (msg, ms = 3200) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
  };

  // ---- Ringtone (generated with WebAudio; no audio file needed) ---------
  let ringCtx = null;
  let ringNodes = [];
  let ringInterval = null;

  function ringBurst(freq1, freq2) {
    if (!ringCtx) return;
    const t0 = ringCtx.currentTime;
    [freq1, freq2].forEach((f) => {
      const osc = ringCtx.createOscillator();
      const gain = ringCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.12, t0 + 0.05);
      gain.gain.setValueAtTime(0.12, t0 + 0.9);
      gain.gain.linearRampToValueAtTime(0, t0 + 1.0);
      osc.connect(gain).connect(ringCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 1.05);
      ringNodes.push(osc);
    });
  }

  window.cwStartRingtone = function (incoming) {
    try {
      if (!ringCtx) ringCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (ringCtx.state === "suspended") ringCtx.resume();
      const f1 = incoming ? 740 : 425;   // incoming: bright ring; outgoing: ringback tone
      const f2 = incoming ? 880 : 480;
      ringBurst(f1, f2);
      clearInterval(ringInterval);
      ringInterval = setInterval(() => ringBurst(f1, f2), incoming ? 2000 : 3000);
    } catch (e) { /* audio unavailable — ring silently */ }
  };

  window.cwStopRingtone = function () {
    clearInterval(ringInterval);
    ringInterval = null;
    ringNodes.forEach((n) => { try { n.stop(); } catch (e) {} });
    ringNodes = [];
  };

  // ---- Small helpers ----------------------------------------------------
  window.cwAvatarSrc = function (photo, name) {
    if (photo) return photo;
    // Inline SVG initial avatar (no server round-trip)
    const letter = (name || "?").trim().charAt(0).toUpperCase() || "?";
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'>` +
      `<rect width='128' height='128' rx='64' fill='%238696a0'/>` +
      `<text x='64' y='82' font-family='Segoe UI,Arial' font-size='56' fill='white' text-anchor='middle'>${letter}</text></svg>`;
    return `data:image/svg+xml;utf8,${svg}`;
  };

  window.cwFmtTime = function (isoStr) {
    if (!isoStr) return "";
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  window.cwFmtDay = function (isoStr) {
    const d = new Date(isoStr);
    const today = new Date();
    const yest = new Date(); yest.setDate(today.getDate() - 1);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, today)) return "Today";
    if (same(d, yest)) return "Yesterday";
    return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  };

  window.cwEsc = function (s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  };
})();
