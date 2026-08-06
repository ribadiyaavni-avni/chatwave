/* ChatWave — home screen: chat list + call history tabs. */

(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = window.cwEsc;

  // ---- Tabs -------------------------------------------------------------
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      $("tab-chats").classList.toggle("hidden", btn.dataset.tab !== "chats");
      $("tab-calls").classList.toggle("hidden", btn.dataset.tab !== "calls");
      if (btn.dataset.tab === "calls") loadCalls();
    });
  });

  // ---- Chat list --------------------------------------------------------
  let users = [];

  function renderUsers() {
    const list = $("user-list");
    $("chats-empty").classList.toggle("hidden", users.length > 0);
    list.innerHTML = users.map((u) => {
      const last = u.last_message;
      const preview = last
        ? `${last.mine ? "You: " : ""}${esc(last.body)}`
        : `@${esc(u.username)} · ${esc(u.about || "")}`;
      const time = last ? window.cwFmtTime(last.created_at) : "";
      return `
        <li>
          <a class="chat-item" href="/chat/${u.id}">
            <span class="avatar-wrap">
              <img class="avatar" src="${window.cwAvatarSrc(u.photo, u.display_name)}" alt="">
              <span class="presence-dot ${u.online ? "online" : ""}" data-uid="${u.id}"></span>
            </span>
            <span class="chat-item-main">
              <span class="chat-item-top">
                <span class="chat-item-name">${esc(u.display_name)}</span>
                <span class="chat-item-time ${u.unread ? "unread-time" : ""}">${time}</span>
              </span>
              <span class="chat-item-bottom">
                <span class="chat-item-preview">${preview}</span>
                ${u.unread ? `<span class="unread-badge">${u.unread}</span>` : ""}
              </span>
            </span>
          </a>
        </li>`;
    }).join("");
  }

  async function loadUsers() {
    try {
      const r = await fetch("/api/users");
      if (!r.ok) return;
      users = (await r.json()).users;
      renderUsers();
    } catch (e) {}
  }

  // Live presence flips the dot instantly (no reload needed).
  window.cwPresenceHandlers.push((p) => {
    const u = users.find((x) => x.id === p.user_id);
    if (u) u.online = p.online;
    document.querySelectorAll(`.presence-dot[data-uid="${p.user_id}"]`)
      .forEach((el) => el.classList.toggle("online", p.online));
  });

  // ---- Call history -----------------------------------------------------
  const CALL_STATUS_LABEL = {
    completed: (c) => c.duration
      ? `${Math.floor(c.duration / 60)}:${String(c.duration % 60).padStart(2, "0")}`
      : "Completed",
    missed: () => "Missed",
    rejected: () => "Declined",
    cancelled: () => "Cancelled",
    failed: () => "Failed",
    ringing: () => "…",
    active: () => "Ongoing",
  };

  async function loadCalls() {
    try {
      const r = await fetch("/api/calls");
      if (!r.ok) return;
      const calls = (await r.json()).calls;
      $("calls-empty").classList.toggle("hidden", calls.length > 0);
      $("call-list").innerHTML = calls.map((c) => {
        const missed = !c.outgoing && (c.status === "missed" || c.status === "rejected");
        const arrow = c.outgoing
          ? `<svg class="arrow-out" viewBox="0 0 24 24"><path d="M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5z"/></svg>`
          : `<svg class="arrow-in" viewBox="0 0 24 24"><path d="M20 5.41 18.59 4 7 15.59V9H5v10h10v-2H8.41z"/></svg>`;
        const kindIcon = c.kind === "video"
          ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`
          : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>`;
        const label = (CALL_STATUS_LABEL[c.status] || (() => c.status))(c);
        const when = `${window.cwFmtDay(c.created_at)}, ${window.cwFmtTime(c.created_at)}`;
        return `
          <li>
            <span class="chat-item" style="cursor:default">
              <span class="avatar-wrap">
                <img class="avatar" src="${window.cwAvatarSrc(c.other_photo, c.other_name)}" alt="">
              </span>
              <span class="chat-item-main">
                <span class="chat-item-top">
                  <span class="chat-item-name" style="${missed ? "color:var(--danger)" : ""}">${esc(c.other_name)}</span>
                  <span class="chat-item-time">${when}</span>
                </span>
                <span class="call-row-meta ${missed ? "missed" : ""}">${arrow}${label}</span>
              </span>
              <button class="call-again-btn" data-id="${c.other_id}"
                      data-name="${esc(c.other_name)}" data-photo="${c.other_photo || ""}"
                      data-kind="${c.kind}" title="Call again">${kindIcon}</button>
            </span>
          </li>`;
      }).join("");

      document.querySelectorAll(".call-again-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          window.CWCall.start(
            { id: parseInt(btn.dataset.id, 10), name: btn.dataset.name, photo: btn.dataset.photo || null },
            btn.dataset.kind
          );
        });
      });
    } catch (e) {}
  }

  // Refresh history right after a call finishes.
  window.cwOnCallFinished = () => { loadCalls(); loadUsers(); };

  loadUsers();
  setInterval(loadUsers, 5000);
})();
