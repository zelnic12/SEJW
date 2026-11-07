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

// ---- AC installation (jasa pasang) ----
// Mirrors server/src/finance/install.js so forms can show the cost while typing;
// the server recomputes it from the saved rates when the sale is stored.
export const INSTALL_LABELS = {
  none: "Tanpa pasang",
  full: "Pasang + material",
  service: "Pasang saja",
  material: "Material saja",
};
export const needsMeters = type => type === "full" || type === "material";
export function installCost(type, meters, r) {
  const material = m => m * (r.pipePerMeter + r.cablePerMeter) + r.ductTape + r.drainHose + r.bracket;
  if (type === "service") return r.service;
  if (type === "full") return r.service + material(meters);
  if (type === "material") return material(meters);
  return 0;
}
export const installText = (type, meters) =>
  type && type !== "none" ? `${INSTALL_LABELS[type]}${needsMeters(type) && meters ? ` ${meters} m` : ""}` : "";

/** Select + meters input for one line. prefix makes the ids unique. */
export function installControl(prefix, type = "none", meters = 3) {
  return `
    <div class="fin-install">
      <select id="${prefix}Type" data-f="installType" aria-label="Jasa pasang">
        ${Object.entries(INSTALL_LABELS).map(([v, l]) => `<option value="${v}" ${v === type ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <span class="fin-install-m" ${needsMeters(type) ? "" : "hidden"}>
        <input id="${prefix}Meters" data-f="installMeters" type="number" min="1" max="50" step="1" value="${meters || 3}" list="finMeterPresets" aria-label="Panjang pipa (meter)" />
        <span>m</span>
      </span>
    </div>`;
}
export const meterPresets = `<datalist id="finMeterPresets"><option value="3"></option><option value="5"></option></datalist>`;

/** Read an installControl inside el. */
export function readInstall(el) {
  const type = el.querySelector('[data-f="installType"]')?.value || "none";
  const m = Number(el.querySelector('[data-f="installMeters"]')?.value);
  el.querySelector(".fin-install-m")?.toggleAttribute("hidden", !needsMeters(type));
  return { type, meters: needsMeters(type) ? m : null, valid: !needsMeters(type) || (Number.isInteger(m) && m >= 1 && m <= 50) };
}

/** Editable rates panel. onSaved(rates) after a successful save. */
export const RATE_FIELDS = [
  ["service", "Jasa pasang (per AC)"],
  ["pipePerMeter", "Pipa (per meter)"],
  ["cablePerMeter", "Kabel listrik (per meter)"],
  ["ductTape", "Duct tape (per pasang)"],
  ["drainHose", "Selang pembuangan 2 m (per pasang)"],
  ["bracket", "Bracket (per pasang)"],
];
export function ratesPanelHTML(rates) {
  return `
    <details class="panel fin-rates">
      <summary><h2>Biaya pasang AC</h2><span class="fin-total">Pasang + material 3 m ${money(installCost("full", 3, rates))} · 5 m ${money(installCost("full", 5, rates))}</span></summary>
      <form id="ratesForm" class="fin-form" autocomplete="off">
        <p class="form-hint">Dipakai untuk memotong harga jual AC yang dijual dengan pemasangan. Perubahan hanya berlaku untuk penjualan berikutnya.</p>
        <div class="form-grid">
          ${RATE_FIELDS.map(([k, l]) => `<div class="form-field"><label for="rate_${k}">${l}</label>
            <input id="rate_${k}" data-rate="${k}" inputmode="numeric" value="${Number(rates[k]).toLocaleString("id-ID")}" /></div>`).join("")}
        </div>
        <p class="form-error" id="ratesErr" hidden></p>
        <button class="btn btn-ghost btn-sm" type="submit">Simpan tarif</button>
      </form>
    </details>`;
}
export function wireRatesPanel(root, api, toast, onSaved) {
  const form = root.querySelector("#ratesForm");
  form?.addEventListener("submit", async e => {
    e.preventDefault();
    const err = root.querySelector("#ratesErr");
    err.hidden = true;
    const rates = {};
    for (const input of form.querySelectorAll("[data-rate]")) {
      const v = readRupiah(input.value);
      if (!Number.isFinite(v) || v < 0) { err.textContent = "Isi semua tarif dengan angka."; err.hidden = false; return; }
      rates[input.dataset.rate] = v;
    }
    try {
      const saved = await api.finSaveInstallRates(rates);
      toast("Tarif pasang AC tersimpan", "success");
      onSaved(saved);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
}

/**
 * "Ubah pasang" dialog for a recorded sale line. Resolves true after a save.
 * item: { id, name, qty, unitPrice, installType, installMeters }
 */
export function editInstallDialog({ api, toast, saleId, item, rates }) {
  return new Promise(resolve => {
    let saved = false;
    openModal({
      title: "Ubah jasa pasang",
      bodyHTML: `
        <p class="form-hint">${esc(item.name)} · ${item.qty} unit · harga jual ${money(item.unitPrice)} / unit</p>
        ${meterPresets}
        <div id="eiCtl">${installControl("ei", item.installType || "none", item.installMeters || 3)}</div>
        <p class="fin-line-note" id="eiNote"></p>
        <p class="form-error" id="eiErr" hidden></p>`,
      footHTML: `<button class="btn btn-ghost" data-close>Batal</button><button class="btn btn-primary" id="eiSave">Simpan</button>`,
      onMount(overlay, close) {
        const ctl = overlay.querySelector("#eiCtl");
        const update = () => {
          const inst = readInstall(ctl);
          const cost = inst.valid ? installCost(inst.type, inst.meters, rates) : 0;
          overlay.querySelector("#eiNote").innerHTML = inst.type !== "none" && inst.valid
            ? `${money(item.unitPrice)} − ${esc(installText(inst.type, inst.meters).toLowerCase())} ${money(cost)} = <strong>${money(item.unitPrice - cost)}</strong> per unit`
            : "";
          return inst;
        };
        ctl.addEventListener("change", update);
        ctl.addEventListener("input", update);
        update();
        overlay.querySelector("#eiSave").addEventListener("click", async () => {
          const err = overlay.querySelector("#eiErr");
          err.hidden = true;
          const inst = update();
          if (!inst.valid) { err.textContent = "Isi panjang pipa 1–50 meter."; err.hidden = false; return; }
          try {
            await api.finUpdateSaleInstall(saleId, item.id, inst.type, inst.meters);
            saved = true;
            toast("Jasa pasang diperbarui", "success");
            close();
            resolve(true);
          } catch (ex) { err.textContent = ex.message; err.hidden = false; }
        });
        const observer = new MutationObserver(() => {
          if (!overlay.isConnected) { observer.disconnect(); if (!saved) resolve(false); }
        });
        observer.observe(overlay.parentNode || document.body, { childList: true });
      },
    });
  });
}
