// Admin Messages view: conversation list + reply area. Polls every few seconds
// (v1, no WebSocket). Requires admin JWT (enforced by the API + api client).
import { api } from "../components/api.js";
import { esc, fmtDate } from "../components/format.js";
import { toast } from "../components/toast.js";

const POLL_MS = 4000;

let activeId = null;      // currently open conversation
let pollTimer = null;
let lastMsgId = 0;        // highest message id rendered in the open thread
// Set by openConversationById() so a notification click can land straight on a
// thread: the view opens it once the conversation list has rendered.
let pendingId = null;

/**
 * Ask the Messages view to open a specific conversation the next time it renders.
 * Used by the notification bell, which navigates to #messages right after.
 */
export function openConversationById(id) {
  pendingId = Number(id) || null;
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// Detach polling when the view is torn down / navigated away.
function attachCleanup(root) {
  const obs = new MutationObserver(() => {
    if (!root.querySelector("#chatAdmin")) { stopPolling(); obs.disconnect(); }
  });
  obs.observe(root, { childList: true, subtree: true });
}

function bubble(m) {
  const who = m.sender === "admin" ? "admin" : "customer";
  return `<div class="ac-msg ${who}"><span class="ac-msg-body">${esc(m.body)}</span>
    <span class="ac-msg-time">${fmtDate(m.createdAt, true)}</span></div>`;
}

function convItem(c) {
  const unread = c.adminUnread > 0 ? `<span class="ac-unread">${c.adminUnread}</span>` : "";
  return `
    <button class="ac-conv ${c.id === activeId ? "active" : ""}" data-conv="${c.id}">
      <div class="ac-conv-top">
        <span class="ac-conv-name">${esc(c.customerName)}</span>
        ${unread}
      </div>
      <span class="ac-conv-email">${esc(c.customerEmail)}</span>
      <span class="ac-conv-last">${esc(c.lastBody || "")}</span>
    </button>`;
}

async function refreshList(root) {
  let conversations;
  try {
    conversations = await api.listConversations();
  } catch (e) {
    root.querySelector("#acList").innerHTML = `<p class="admin-status error">${esc(e.message)}</p>`;
    return;
  }
  const listEl = root.querySelector("#acList");
  if (!listEl) return;
  listEl.innerHTML = conversations.length
    ? conversations.map(convItem).join("")
    : `<p class="admin-status">No conversations yet.</p>`;
  listEl.querySelectorAll("[data-conv]").forEach(b =>
    b.addEventListener("click", () => openConversation(root, Number(b.dataset.conv))));
}

async function openConversation(root, id) {
  activeId = id;
  lastMsgId = 0;
  root.querySelectorAll(".ac-conv").forEach(el => el.classList.toggle("active", Number(el.dataset.conv) === id));

  const pane = root.querySelector("#acThread");
  pane.innerHTML = `<div class="ac-thread-msgs" id="acMsgs"><p class="admin-status">Loading…</p></div>`;
  let data;
  try {
    data = await api.getConversation(id);
  } catch (e) {
    pane.innerHTML = `<p class="admin-status error">${esc(e.message)}</p>`;
    return;
  }
  const c = data.conversation;
  pane.innerHTML = `
    <div class="ac-thread-head">
      <strong>${esc(c.customerName)}</strong>
      <span class="ac-thread-email">${esc(c.customerEmail)}</span>
    </div>
    <div class="ac-thread-msgs" id="acMsgs"></div>
    <form class="ac-compose" id="acCompose">
      <input id="acInput" placeholder="Type a reply…" autocomplete="off" required />
      <button type="submit" class="btn btn-primary btn-sm">Send</button>
    </form>`;

  const msgsEl = pane.querySelector("#acMsgs");
  renderMessages(msgsEl, data.messages);

  pane.querySelector("#acCompose").addEventListener("submit", async e => {
    e.preventDefault();
    const input = pane.querySelector("#acInput");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    try {
      await api.replyConversation(id, text);
      await pollThread(root); // pull the new message (and any customer ones)
      refreshList(root);      // update the list preview/order
    } catch (e2) { toast(e2.message, "error"); }
  });

  // Refresh the list so the unread badge clears.
  refreshList(root);
}

function renderMessages(container, messages) {
  if (!container) return;
  if (messages.length) {
    container.insertAdjacentHTML("beforeend", messages.map(bubble).join(""));
    lastMsgId = Math.max(lastMsgId, ...messages.map(m => m.id));
    container.scrollTop = container.scrollHeight;
  } else if (!container.children.length) {
    container.innerHTML = `<p class="admin-status">No messages.</p>`;
  }
}

// Poll the open thread for new messages (incremental via ?after=).
async function pollThread(root) {
  if (!activeId) return;
  try {
    const data = await api.getConversation(activeId);
    const msgsEl = root.querySelector("#acMsgs");
    if (!msgsEl) return;
    const fresh = (data.messages || []).filter(m => m.id > lastMsgId);
    // Clear the "No messages" placeholder if present.
    if (fresh.length && msgsEl.querySelector(".admin-status")) msgsEl.innerHTML = "";
    renderMessages(msgsEl, fresh);
  } catch { /* transient */ }
}

export async function renderMessages_view(root) {
  activeId = null; lastMsgId = 0;
  root.innerHTML = `
    <div class="ac-layout" id="chatAdmin">
      <aside class="ac-sidebar">
        <div class="ac-sidebar-head">Conversations</div>
        <div class="ac-list" id="acList"><p class="admin-status">Loading…</p></div>
      </aside>
      <section class="ac-thread" id="acThread">
        <div class="ac-empty">Select a conversation to view and reply.</div>
      </section>
    </div>`;

  await refreshList(root);

  // Honour a conversation requested from outside (notification click).
  if (pendingId) {
    const wanted = pendingId;
    pendingId = null;
    // Only if it's still in the list — it may have been deleted since.
    if (root.querySelector(`[data-conv="${wanted}"]`)) await openConversation(root, wanted);
  }

  // Poll: refresh the list, and the open thread if any.
  stopPolling();
  pollTimer = setInterval(() => {
    refreshList(root);
    pollThread(root);
  }, POLL_MS);
  attachCleanup(root);
}
