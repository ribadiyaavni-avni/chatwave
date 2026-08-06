/* ChatWave — one-to-one chat screen (polling, same API as before) + call buttons. */

(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = window.cwEsc;
  const other = window.OTHER;

  const messagesEl = $("messages");
  const input = $("msg-input");
  const sendBtn = $("btn-send");

  let lastId = 0;
  let lastDay = null;

  const CALL_NOTE_RE = /^(📞|📹)\s/;

  function tickSvg(seen) {
    return `<svg class="ticks ${seen ? "seen" : ""}" viewBox="0 0 24 24">
      <path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41 6 19l1.41-1.41L1.83 12 .41 13.41z"/>
    </svg>`;
  }

  function appendMessage(m) {
    const day = window.cwFmtDay(m.created_at);
    if (day !== lastDay) {
      lastDay = day;
      messagesEl.insertAdjacentHTML("beforeend", `<div class="day-chip">${day}</div>`);
    }
    const isCallNote = CALL_NOTE_RE.test(m.body);
    const cls = isCallNote ? "bubble call-note" : `bubble ${m.mine ? "mine" : ""}`;
    const meta = isCallNote
      ? `<span class="meta">${window.cwFmtTime(m.created_at)}</span>`
      : `<span class="meta">${window.cwFmtTime(m.created_at)}${m.mine ? tickSvg(m.seen) : ""}</span>`;
    messagesEl.insertAdjacentHTML(
      "beforeend",
      `<div class="${cls}" data-id="${m.id}">${esc(m.body)}${meta}</div>`
    );
  }

  function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  function setPresence(online) {
    $("peer-presence").textContent = online ? "online" : "offline";
  }

  async function poll() {
    try {
      const r = await fetch(`/api/messages/${other.id}?after=${lastId}`);
      if (!r.ok) return;
      const data = await r.json();
      const atBottom =
        messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
      let added = false;
      for (const m of data.messages) {
        appendMessage(m);
        lastId = Math.max(lastId, m.id);
        added = true;
      }
      if (added && (atBottom || data.messages.some((m) => m.mine))) scrollDown();
      setPresence(data.other.online);
    } catch (e) {}
  }

  window.cwPresenceHandlers.push((p) => {
    if (p.user_id === other.id) setPresence(p.online);
  });

  // ---- Sending ----------------------------------------------------------
  async function send() {
    const body = input.value.trim();
    if (!body) return;
    sendBtn.disabled = true;
    try {
      const r = await fetch(`/api/messages/${other.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (r.ok) {
        input.value = "";
        autoGrow();
        await poll();
        scrollDown();
      } else {
        const d = await r.json().catch(() => ({}));
        window.cwToast(d.error || "Message not sent. Check your connection.");
      }
    } catch (e) {
      window.cwToast("Message not sent. Check your connection.");
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }
  input.addEventListener("input", autoGrow);

  // ---- Calls ------------------------------------------------------------
  const peer = { id: other.id, name: other.name, photo: other.photo };
  $("btn-voice-call").addEventListener("click", () => window.CWCall.start(peer, "audio"));
  $("btn-video-call").addEventListener("click", () => window.CWCall.start(peer, "video"));

  // Refresh chat right after a call so the WhatsApp-style status line shows up.
  window.cwOnCallFinished = () => poll().then(scrollDown);

  poll().then(scrollDown);
  setInterval(poll, 2000);
})();
