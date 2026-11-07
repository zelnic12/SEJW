// Shared bits for the bookkeeping (Pembukuan) views: the month being viewed,
// a searchable product picker, a confirm dialog and CSV download.
import { esc, money } from "./format.js";
import { openModal } from "./modal.js";

// ---- Month (shared across the Pembukuan views, so switching pages keeps it) ----
const jakartaToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });
let currentMonth = jakartaToday().slice(0, 7);
export const getMonth = () => currentMonth;
export const setMonth = m => { if (/^\d{4}-\d{2}$/.test(m)) currentMonth = m; };
export const today = jakartaToday;

const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
export const monthLabel = ym => { const [y, m] = ym.split("-"); return `${BULAN[Number(m) - 1]} ${y}`; };

/** Default date for a form: today in the viewed month, else that month's last day. */
export function defaultDate() {
  const t = today();
  if (t.startsWith(currentMonth)) return t;
  const [y, m] = currentMonth.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = `${currentMonth}-${String(last).padStart(2, "0")}`;
  return d > t ? t : d;
}

export function monthPicker(id = "finMonth") {
  return `<label class="fin-month"><span>Periode</span><input type="month" id="${id}" value="${esc(currentMonth)}" max="${today().slice(0, 7)}" /></label>`;
}

/** Wire a month picker to re-render the view. */
export function onMonthChange(root, rerender, id = "finMonth") {
  root.querySelector(`#${id}`)?.addEventListener("change", e => {
    if (!e.target.value) return;
    setMonth(e.target.value);
    rerender();
  });
}

// ---- Dates ----
export const tgl = s => {
  const d = new Date(String(s).length === 10 ? `${s}T00:00:00` : s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", ...(String(s).length === 10 ? {} : { timeZone: "Asia/Jakarta" }) });
};

// ---- Product picker ----
// A text input bound to a <datalist>. Options show the short "Brand + model"
// name (unique per product, made by the server) with category and stock as the
// option's hint; the typed or chosen short name maps back to the product id.
const pickerIds = new Map();   // lower-cased short name → product id

export function productDatalist(id, products) {
  for (const p of products) pickerIds.set(productOptionLabel(p).toLowerCase(), p.id);
  return `<datalist id="${id}">${products.map(p =>
    `<option value="${esc(productOptionLabel(p))}" label="${esc([p.category, `stok ${p.stock}`].filter(Boolean).join(" · "))}"></option>`).join("")}</datalist>`;
}
export const productOptionLabel = p => p.shortName || p.name;
export function pickedProductId(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return null;
  return pickerIds.get(v) ?? null;
}

// ---- Money input: accepts "1.500.000", "1500000", "Rp 1.500.000" ----
export function readRupiah(value) {
  const s = String(value ?? "").replace(/rp/i, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  if (s === "") return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

// ---- Confirm dialog (window.confirm is blocked in some admin browsers) ----
export function confirmAction({ title, message, confirmLabel = "Hapus", danger = true }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    openModal({
      title,
      bodyHTML: `<p>${esc(message)}</p>`,
      footHTML: `
        <button class="btn btn-ghost" data-close>Batal</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" id="finConfirm">${esc(confirmLabel)}</button>`,
      onMount(overlay, close) {
        overlay.querySelector("#finConfirm").addEventListener("click", () => { finish(true); close(); });
        // Any other way out of the modal counts as "no".
        const observer = new MutationObserver(() => {
          if (!overlay.isConnected) { observer.disconnect(); finish(false); }
        });
        observer.observe(overlay.parentNode || document.body, { childList: true });
      },
    });
  });
}

// ---- CSV ----
// Semicolon-separated with a BOM: opens correctly in Excel with Indonesian
// regional settings, where the comma is the decimal separator.
export function downloadCsv(filename, rows) {
  const cell = v => {
    if (v == null) return "";
    if (typeof v === "number") return String(Math.round(v));
    return `"${String(v).replace(/"/g, '""')}"`;
  };
  const text = "﻿sep=;\r\n" + rows.map(r => r.map(cell).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const signed = n => (n < 0 ? `<span class="fin-neg">−${money(Math.abs(n))}</span>` : money(n));
