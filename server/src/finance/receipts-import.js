// ---- Barang masuk from Excel ----
// Pure logic: read rows of a spreadsheet (usually the template from
// GET /api/admin/finance/receipts/template) into receipts, and match each row
// to a product. Rows without a quantity are skipped, so the template can list
// every product and the admin fills in only what arrived.
import { parseMessyNumber } from "../import/products.js";
import { suggestProduct } from "./shopee.js";

export const TEMPLATE_COLUMNS = [
  { key: "productId", header: "ID produk", width: 11 },
  { key: "product", header: "Produk", width: 34 },
  { key: "stock", header: "Stok sekarang", width: 14 },
  { key: "date", header: "Tanggal", width: 14 },
  { key: "qty", header: "Jumlah", width: 10 },
  { key: "cost", header: "Harga beli / unit", width: 18 },
  { key: "supplier", header: "Supplier", width: 22 },
  { key: "note", header: "Catatan", width: 24 },
];

const ALIASES = {
  productId: ["id produk", "id", "product id"],
  product: ["produk", "nama produk", "nama barang", "barang", "tipe", "model", "product"],
  date: ["tanggal", "tgl", "tanggal masuk", "date"],
  qty: ["jumlah", "qty", "jumlah masuk", "unit", "quantity"],
  cost: ["harga beli / unit", "harga beli/unit", "harga beli", "modal", "harga modal", "harga", "hpp", "cost"],
  supplier: ["supplier", "pemasok", "vendor"],
  note: ["catatan", "keterangan", "no. faktur", "faktur", "note"],
};

export const MAX_RECEIPT_ROWS = 2000;

/** Rupiah with Indonesian shorthand: "250rb" → 250000, "3,1 jt" → 3100000, else parseMessyNumber. */
export function parseRupiahText(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/^rp\.?\s*/, "");
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)$/);
  if (m) {
    const n = Number(m[1].replace(",", "."));
    return Math.round(n * (/^(jt|juta)$/.test(m[2]) ? 1_000_000 : 1_000));
  }
  return parseMessyNumber(text);
}

const collapse = s => String(s ?? "").replace(/\s+/g, " ").trim();
const norm = s => collapse(s).toLowerCase();

export function locateReceiptColumns(headers) {
  const h = headers.map(norm);
  const index = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const i = h.findIndex(x => names.includes(x));
    if (i !== -1) index[field] = i;
  }
  const missing = [];
  if (index.product === undefined && index.productId === undefined) missing.push("Produk");
  if (index.qty === undefined) missing.push("Jumlah");
  if (index.cost === undefined) missing.push("Harga beli / unit");
  return { index, missing };
}

/**
 * Spreadsheet date → "YYYY-MM-DD", or null when unreadable.
 * Accepts Excel dates (arrive as ISO strings), "2026-11-07", "07/11/2026",
 * "7-11-2026" (day first, Indonesian) and bare Excel serials ("46333").
 */
export function parseSheetDate(value) {
  const s = collapse(value);
  if (!s) return null;
  let y, m, d;
  let mt;
  if ((mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [, y, m, d] = mt;
  else if ((mt = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/))) { [, d, m, y] = mt; if (y.length === 2) y = `20${y}`; }
  else if (/^\d{5}(\.\d+)?$/.test(s)) {
    const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
    return t.toISOString().slice(0, 10);
  } else return null;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Match a row to a product. products: [{ id, name, shortName }].
 * Order: the ID produk column, then the short or full name, then a model code
 * ("TAC-05CSD") through the same matcher the Shopee import uses.
 */
export function matchProduct({ productId, product }, products, byShort, byName) {
  const id = Number(productId);
  if (Number.isInteger(id) && id > 0) {
    const p = products.find(x => x.id === id);
    if (p) return { productId: p.id, via: "id" };
  }
  const t = norm(product);
  if (!t) return null;
  if (byShort.has(t)) return { productId: byShort.get(t), via: "nama" };
  if (byName.has(t)) return { productId: byName.get(t), via: "nama" };
  const s = suggestProduct({ name: product, variation: "" }, products.map(p => ({ id: p.id, name: p.name })));
  return s ? { productId: s.productId, via: "kode model" } : null;
}

/**
 * rows → [{ row, productText, productId, via, receivedOn, quantity, unitCost, supplier, note, problems }]
 * plus { skipped } = rows with no quantity (normal for the template).
 */
export function normalizeReceiptRows(headers, rows, products, { firstDataRow = 2 } = {}) {
  const { index, missing } = locateReceiptColumns(headers);
  if (missing.length) {
    const err = new Error(`Kolom berikut tidak ditemukan: ${missing.join(", ")}. Pakai template dari tombol "Unduh template".`);
    err.expose = true;
    throw err;
  }
  const cell = (r, f) => (index[f] === undefined ? "" : collapse(r[index[f]]));
  const byShort = new Map(products.map(p => [norm(p.shortName || p.name), p.id]));
  const byName = new Map(products.map(p => [norm(p.name), p.id]));

  const out = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    const qtyText = cell(r, "qty");
    if (!qtyText || qtyText === "0") { skipped += 1; return; }
    const problems = [];
    const qty = parseMessyNumber(qtyText);
    const cost = parseRupiahText(cell(r, "cost"));
    const dateText = cell(r, "date");
    const receivedOn = dateText ? parseSheetDate(dateText) : null;
    if (!Number.isInteger(qty) || qty < 1) problems.push("Jumlah harus bilangan bulat ≥ 1");
    if (cost == null || !Number.isFinite(cost) || cost < 0) problems.push("Harga beli kosong atau tidak terbaca");
    if (dateText && !receivedOn) problems.push(`Tanggal "${dateText}" tidak terbaca`);
    const productText = cell(r, "product");
    const match = matchProduct({ productId: cell(r, "productId"), product: productText }, products, byShort, byName);
    if (!match) problems.push("Produk tidak ditemukan");
    out.push({
      row: firstDataRow + i,
      productText: productText || cell(r, "productId"),
      productId: match ? match.productId : null,
      via: match ? match.via : null,
      receivedOn,
      quantity: Number.isInteger(qty) ? qty : null,
      unitCost: cost != null && Number.isFinite(cost) ? Math.round(cost) : null,
      supplier: cell(r, "supplier").slice(0, 120),
      note: cell(r, "note").slice(0, 300),
      problems,
    });
  });
  if (out.length > MAX_RECEIPT_ROWS) {
    const err = new Error(`Maksimal ${MAX_RECEIPT_ROWS} baris per import.`);
    err.expose = true;
    throw err;
  }
  return { rows: out, skipped };
}
