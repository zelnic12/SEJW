// Reusable modal. openModal({ title, bodyHTML, footHTML, onMount }) returns a
// controller with { close, el }. A confirm() helper is built on top.
import { esc } from "./format.js";

// `className` adds modifier classes to the dialog itself — e.g. "modal-lg" for
// content that needs more than the default 560px (the order detail view).
export function openModal({ title = "", bodyHTML = "", footHTML = "", className = "", onMount } = {}) {
  const host = document.getElementById("modalHost");

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal ${esc(className)}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        <button class="icon-btn" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body">${bodyHTML}</div>
      ${footHTML ? `<div class="modal-foot">${footHTML}</div>` : ""}
    </div>`;

  host.appendChild(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) { if (e.key === "Escape") close(); }

  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  overlay.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", close));
  document.addEventListener("keydown", onKey);

  if (onMount) onMount(overlay, close);
  return { el: overlay, close };
}

// Promise-based confirmation dialog.
export function confirmDialog({ title = "Are you sure?", message = "", confirmText = "Confirm", danger = false } = {}) {
  return new Promise(resolve => {
    const { close } = openModal({
      title,
      bodyHTML: `<p style="color:var(--muted)">${esc(message)}</p>`,
      footHTML: `
        <button class="btn btn-ghost" data-cancel>Cancel</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-ok>${esc(confirmText)}</button>`,
      onMount(overlay, closeFn) {
        overlay.querySelector("[data-cancel]").addEventListener("click", () => { closeFn(); resolve(false); });
        overlay.querySelector("[data-ok]").addEventListener("click", () => { closeFn(); resolve(true); });
      },
    });
  });
}
