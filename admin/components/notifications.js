// Notification bell: badge, dropdown, polling, and the "something arrived" cues.
//
// Polling rather than WebSockets, to match how the chat feature already works.
// Everything here is best-effort: a failed poll, a blocked sound or a denied
// browser-notification permission must never disturb the dashboard.
import { api } from "./api.js";
import { esc, timeAgo } from "./format.js";
import { toast } from "./toast.js";

const POLL_MS = 12000;
const LIST_LIMIT = 20;
const MUTE_KEY = "voltedge_admin_notif_muted";

const ICONS = { new_order: "🧾", new_message: "💬" };

let pollTimer = null;
let items = [];              // most recent slice, newest first
let unreadCount = 0;
// Highest notification id seen so far. Comparing ids (rather than the unread
// count) is what makes "something new arrived" reliable: a count can stay flat
// when one notification is read while another arrives.
let highWaterMark = 0;
let started = false;
let onNavigate = null;       // (notification) => void, supplied by the shell

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------
const el = {};
function cacheEls() {
  el.root = document.getElementById("notifRoot");
  el.bell = document.getElementById("notifBell");
  el.count = document.getElementById("notifCount");
  el.panel = document.getElementById("notifPanel");
  el.list = document.getElementById("notifList");
  el.markAll = document.getElementById("notifMarkAll");
  el.mute = document.getElementById("notifMute");
  return !!el.root;
}

// ---------------------------------------------------------------------------
// Sound — a short two-note chime synthesised on the fly, so there's no asset to
// ship and nothing to 404. Muting is remembered across sessions.
// ---------------------------------------------------------------------------
const isMuted = () => localStorage.getItem(MUTE_KEY) === "1";

let audioCtx = null;
function chime() {
  if (isMuted()) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    // Browsers suspend audio contexts created before any user gesture; if this
    // one is still suspended there's nothing we can (or should) do about it.
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});

    const now = audioCtx.currentTime;
    [
      { freq: 880, at: 0 },      // A5
      { freq: 1174.7, at: 0.12 }, // D6
    ].forEach(({ freq, at }) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      // Quick fade in/out so it reads as a soft blip rather than a click.
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(0.09, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.28);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.3);
    });
  } catch {
    /* Audio is a nicety; never surface a failure. */
  }
}

function syncMuteButton() {
  if (!el.mute) return;
  const muted = isMuted();
  el.mute.textContent = muted ? "🔇" : "🔊";
  el.mute.setAttribute("aria-label", muted ? "Unmute notification sound" : "Mute notification sound");
  el.mute.title = muted ? "Sound off — click to unmute" : "Sound on — click to mute";
  el.mute.classList.toggle("muted", muted);
}

// ---------------------------------------------------------------------------
// Browser (OS-level) notifications — only while the tab is in the background,
// and only if the browser supports them and the admin allowed them.
// ---------------------------------------------------------------------------
function requestBrowserPermission() {
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") Notification.requestPermission().catch(() => {});
  } catch {
    /* Unsupported or blocked by policy — skip silently. */
  }
}

function showBrowserNotification(list) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (!document.hidden) return;   // they're looking at the dashboard already
    const [first] = list;
    if (!first) return;
    const more = list.length - 1;
    const n = new Notification(first.title, {
      body: more > 0 ? `${first.body} · and ${more} more` : first.body,
      // A stable tag collapses a burst into one OS notification.
      tag: "voltedge-admin-notifications",
      icon: "assets/logo.svg",
    });
    n.onclick = () => {
      try { window.focus(); n.close(); } catch { /* ignore */ }
    };
  } catch {
    /* Never let a notification failure bubble. */
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function setBadge(count) {
  unreadCount = count;
  if (!el.count) return;
  el.count.textContent = count > 99 ? "99+" : String(count);
  el.count.hidden = count === 0;
  el.bell?.classList.toggle("has-unread", count > 0);
  el.bell?.setAttribute(
    "aria-label",
    count > 0 ? `Notifications (${count} unread)` : "Notifications"
  );
}

function flashBell() {
  if (!el.bell) return;
  el.bell.classList.remove("ring");
  // Force a reflow so the animation restarts even on back-to-back arrivals.
  void el.bell.offsetWidth;
  el.bell.classList.add("ring");
  setTimeout(() => el.bell?.classList.remove("ring"), 1200);
}

function renderList() {
  if (!el.list) return;
  if (items.length === 0) {
    el.list.innerHTML = `<p class="notif-empty">Nothing yet. New orders and customer messages show up here.</p>`;
    return;
  }
  el.list.innerHTML = items.map(n => `
    <button class="notif-item ${n.isRead ? "" : "unread"}" data-notif="${n.id}" type="button">
      <span class="notif-item-icon" aria-hidden="true">${ICONS[n.type] || "🔔"}</span>
      <span class="notif-item-text">
        <span class="notif-item-title">${esc(n.title)}</span>
        ${n.body ? `<span class="notif-item-body">${esc(n.body)}</span>` : ""}
        <span class="notif-item-time">${esc(timeAgo(n.createdAt))}</span>
      </span>
    </button>`).join("");

  el.list.querySelectorAll("[data-notif]").forEach(btn => {
    btn.addEventListener("click", () => activate(Number(btn.dataset.notif)));
  });
}

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------
function isOpen() { return el.panel && !el.panel.hidden; }

function openPanel() {
  if (!el.panel) return;
  el.panel.hidden = false;
  el.bell?.setAttribute("aria-expanded", "true");
  syncMuteButton();
  // Re-render so the relative timestamps are current, then refresh in the
  // background in case the panel was opened between polls.
  renderList();
  refresh({ quiet: true });
}

function closePanel() {
  if (!el.panel) return;
  el.panel.hidden = true;
  el.bell?.setAttribute("aria-expanded", "false");
}

function togglePanel() { isOpen() ? closePanel() : openPanel(); }

// Clicking a notification: mark it read, then hand it to the shell to navigate.
async function activate(id) {
  const item = items.find(n => n.id === id);
  closePanel();

  if (item && !item.isRead) {
    try {
      const res = await api.markNotificationRead(id);
      item.isRead = true;
      setBadge(res.unreadCount ?? Math.max(0, unreadCount - 1));
    } catch (err) {
      // Navigation is the point of the click, so don't abort on this.
      console.error("Could not mark notification read:", err?.message || err);
    }
  }

  if (item && onNavigate) onNavigate(item);
}

async function markAll() {
  try {
    await api.markAllNotificationsRead();
    items = items.map(n => ({ ...n, isRead: true }));
    setBadge(0);
    renderList();
  } catch (err) {
    toast(err.message, "error");
  }
}

/**
 * Fetch the latest feed and update the badge.
 * @param {object}  [opts]
 * @param {boolean} [opts.quiet] skip the sound/flash/OS cues (used on first load
 *   and when the admin opens the panel themselves)
 */
async function refresh({ quiet = false } = {}) {
  try {
    const { notifications, unreadCount: count } = await api.listNotifications({ limit: LIST_LIMIT });
    items = notifications;
    setBadge(count);

    // Anything unread with an id above the previous high-water mark is new.
    const fresh = notifications.filter(n => !n.isRead && n.id > highWaterMark);
    if (notifications.length) {
      highWaterMark = Math.max(highWaterMark, ...notifications.map(n => n.id));
    }

    if (!quiet && fresh.length) {
      flashBell();
      chime();
      showBrowserNotification(fresh);
    }
    if (isOpen()) renderList();
  } catch {
    /* Non-critical: keep whatever the badge already shows and try again next tick. */
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
/**
 * Wire up the bell and begin polling. Safe to call repeatedly (e.g. on re-login).
 * @param {object}   opts
 * @param {Function} opts.onNavigate called with the clicked notification so the
 *   shell can route to the order or conversation it refers to.
 */
export function startNotifications({ onNavigate: navigate } = {}) {
  if (!cacheEls()) return;      // markup missing → feature simply absent
  onNavigate = navigate || null;

  if (!started) {
    started = true;
    el.bell.addEventListener("click", e => { e.stopPropagation(); togglePanel(); });
    el.markAll.addEventListener("click", e => { e.stopPropagation(); markAll(); });
    el.mute.addEventListener("click", e => {
      e.stopPropagation();
      localStorage.setItem(MUTE_KEY, isMuted() ? "0" : "1");
      syncMuteButton();
      if (!isMuted()) chime();   // confirm it's back on
    });
    // Click-away and Escape close the panel.
    document.addEventListener("click", e => {
      if (isOpen() && !el.root.contains(e.target)) closePanel();
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && isOpen()) closePanel();
    });
    syncMuteButton();
    requestBrowserPermission();
  }

  el.root.hidden = false;
  // First load is quiet: a backlog of unread notifications from before this
  // session shouldn't set off a chime the moment someone signs in.
  refresh({ quiet: true });

  clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh(), POLL_MS);
}

/** Stop polling and hide the bell (logout / expired session). */
export function stopNotifications() {
  clearInterval(pollTimer);
  pollTimer = null;
  closePanel();
  items = [];
  highWaterMark = 0;
  setBadge(0);
  if (el.root) el.root.hidden = true;
}
