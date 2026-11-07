// ---- Shopee order export → bookkeeping sales ----
// Pure logic, no DB and no HTTP (same split as import/products.js): this module
// decides what a row of Shopee Seller Centre's "Pesanan Saya → Export" file
// means, groups rows into orders, and suggests which website product each Shopee
// listing is. The routes do the I/O.
//
// One row in the export is one line item; order-level columns (vouchers, totals)
// repeat on every line of the same order.

// Header names as Shopee Indonesia writes them. A few have English twins in
// some exports, hence the arrays.
import { cleanInstall } from "./install.js";

export const SHOPEE_COLUMNS = {
  orderNo:        ["No. Pesanan", "Order ID"],
  status:         ["Status Pesanan", "Order Status"],
  cancelStatus:   ["Status Pembatalan/ Pengembalian", "Status Pembatalan/Pengembalian", "Return / Refund / Cancel Status"],
  createdAt:      ["Waktu Pesanan Dibuat", "Order Creation Date"],
  productName:    ["Nama Produk", "Product Name"],
  variation:      ["Nama Variasi", "Variation Name"],
  sku:            ["Nomor Referensi SKU", "SKU Reference No."],
  unitPrice:      ["Harga Setelah Diskon", "Deal Price"],
  qty:            ["Jumlah", "Quantity"],
  returnedQty:    ["Returned quantity", "Jumlah Dikembalikan"],
  sellerVoucher:  ["Voucher Ditanggung Penjual", "Seller Voucher"],
  sellerBundle:   ["Paket Diskon (Diskon dari Penjual)", "Bundle Discount (Seller)"],
  buyer:          ["Username (Pembeli)", "Username (Buyer)"],
};

const REQUIRED = ["orderNo", "createdAt", "productName", "qty", "unitPrice"];

// Statuses that are not (yet) a sale.
const SKIP_STATUS = [
  { test: /batal|cancel/i, reason: "Pesanan dibatalkan" },
  { test: /belum bayar|unpaid/i, reason: "Pesanan belum dibayar" },
];

export const MAX_ORDERS = 5000;

const collapse = s => String(s ?? "").replace(/\s+/g, " ").trim();
const normHeader = s => collapse(s).toLowerCase().replace(/\s*\/\s*/g, "/");
export const normText = s => collapse(s).toLowerCase();

/** Key that identifies one Shopee listing + variation (also the DB link key). */
export function listingKey(name, variation) {
  return `${normText(name)}\u0001${normText(variation)}`;
}

/** Map each field to its column index; report the required ones that are missing. */
export function locateColumns(headers) {
  const normalized = headers.map(normHeader);
  const index = {};
  for (const [field, names] of Object.entries(SHOPEE_COLUMNS)) {
    const i = normalized.findIndex(h => names.some(n => normHeader(n) === h));
    if (i !== -1) index[field] = i;
  }
  const missing = REQUIRED.filter(f => index[f] === undefined).map(f => SHOPEE_COLUMNS[f][0]);
  return { index, missing };
}

/**
 * Rupiah text → number. Shopee writes "1.506.999"; other tools write
 * "Rp 1.506.999", "1,506,999" or "1506999.00". Returns NaN when unreadable.
 */
export function parseRupiah(value) {
  if (typeof value === "number") return value;
  let s = String(value ?? "").replace(/rp/i, "").replace(/\s/g, "");
  if (s === "") return 0;
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");      // 1.506.999,00
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");                   // 1,506,999.00
  else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

/** "2026-11-01 14:03" (Jakarta wall-clock time) → ISO timestamp. */
export function parseShopeeTime(value) {
  const s = collapse(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, y, mo, d, h, mi, sec = "00"] = m;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec}+07:00`;
    return Number.isNaN(Date.parse(iso)) ? null : new Date(iso).toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Turn the sheet into orders.
 * Returns { orders, skipped, listings } where
 *   orders:   [{ ref, soldAt, buyer, status, discount, subtotal, lines: [{ key, name, variation, sku, qty, unitPrice }] }]
 *   skipped:  [{ ref, reason }]   (whole orders that aren't sales)
 *   listings: [{ key, name, variation, sku, orders, qty }]   (distinct Shopee listings, for matching)
 */
export function normalizeShopeeRows(headers, rows) {
  const { index, missing } = locateColumns(headers);
  if (missing.length) {
    const err = new Error(`File ini bukan export pesanan Shopee, atau kolomnya tidak lengkap. Kolom yang hilang: ${missing.join(", ")}.`);
    err.expose = true;
    throw err;
  }
  const cell = (row, field) => (index[field] === undefined ? "" : collapse(row[index[field]]));

  const byRef = new Map();
  const skipped = new Map();

  for (const row of rows) {
    const ref = cell(row, "orderNo");
    if (!ref) continue;

    const status = cell(row, "status");
    const skip = SKIP_STATUS.find(s => s.test.test(status));
    if (skip) { skipped.set(ref, skip.reason); continue; }

    let order = byRef.get(ref);
    if (!order) {
      const soldAt = parseShopeeTime(cell(row, "createdAt"));
      if (!soldAt) { skipped.set(ref, "Waktu pesanan tidak terbaca"); continue; }
      const voucher = parseRupiah(cell(row, "sellerVoucher"));
      const bundle = parseRupiah(cell(row, "sellerBundle"));
      order = {
        ref, soldAt, status,
        buyer: cell(row, "buyer"),
        discount: (Number.isFinite(voucher) ? voucher : 0) + (Number.isFinite(bundle) ? bundle : 0),
        lines: [],
        problems: [],
      };
      byRef.set(ref, order);
    }

    const name = cell(row, "productName");
    const variation = cell(row, "variation");
    const qty = Number(parseRupiah(cell(row, "qty")));
    const returned = Number(parseRupiah(cell(row, "returnedQty"))) || 0;
    const unitPrice = parseRupiah(cell(row, "unitPrice"));

    if (!name) { order.problems.push("Baris tanpa nama produk dilewati"); continue; }
    if (!Number.isInteger(qty) || qty < 1 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      order.problems.push(`Jumlah atau harga tidak terbaca untuk “${name}”`);
      continue;
    }
    const kept = qty - Math.max(0, Math.min(qty, returned));
    if (kept < 1) { order.problems.push(`“${name}” dikembalikan semua`); continue; }

    order.lines.push({
      key: listingKey(name, variation),
      name, variation,
      sku: cell(row, "sku"),
      qty: kept,
      unitPrice: Math.round(unitPrice),
    });
  }

  const orders = [];
  for (const o of byRef.values()) {
    if (o.lines.length === 0) {
      skipped.set(o.ref, o.problems[0] || "Tidak ada barang yang terjual");
      continue;
    }
    o.subtotal = o.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    o.discount = Math.min(Math.round(o.discount), o.subtotal);
    orders.push(o);
  }
  orders.sort((a, b) => a.soldAt.localeCompare(b.soldAt));

  const listingMap = new Map();
  for (const o of orders) {
    for (const l of o.lines) {
      const entry = listingMap.get(l.key) || { key: l.key, name: l.name, variation: l.variation, sku: l.sku, orders: 0, qty: 0 };
      entry.orders += 1;
      entry.qty += l.qty;
      listingMap.set(l.key, entry);
    }
  }

  return {
    orders,
    skipped: [...skipped].map(([ref, reason]) => ({ ref, reason })),
    listings: [...listingMap.values()].sort((a, b) => b.qty - a.qty),
  };
}

// ---------------------------------------------------------------------------
// Matching a Shopee listing to a website product
// ---------------------------------------------------------------------------

// Spec tokens that look like model codes but appear on many products.
export const NOT_A_MODEL = /^(hdr\d*|dvbt2|r32|r410a?|\d+(hz|pk|kg|gr|ml|l|w|watt|inch|btu|liter|ltr|mah|gb|tb|p|k)|(4k|8k)\w*)$/i;

/** Model-code-looking tokens: letters + digits, at least 5 characters. */
export function modelCodes(text) {
  const tokens = String(text ?? "").match(/[a-z0-9]+(?:[-/][a-z0-9]+)*/gi) || [];
  const out = new Set();
  for (const t of tokens) {
    const parts = [t, ...t.split("/")];
    for (const p of parts) {
      const code = p.toLowerCase();
      if (code.length >= 5 && /[a-z]/.test(code) && /\d/.test(code) && !NOT_A_MODEL.test(code)) out.add(code);
    }
  }
  return [...out];
}

/**
 * Suggest the website product for a Shopee listing.
 * products: [{ id, name }]. Returns { productId, via } or null.
 *
 *   1. same name (the website catalogue was imported from Shopee, so names
 *      usually match; variants carry the Shopee variation after " - ")
 *   2. same model code (e.g. "TAC-05CSD/XSS"); when the variation names a model
 *      ("MAC401 Putih", "50p7k"), the product must carry that model too
 */
export function suggestProduct(listing, products) {
  const name = normText(listing.name);
  const variation = normText(listing.variation);
  const prepared = products.map(p => ({ id: p.id, name: normText(p.name) }));

  // 1. Name match
  const exact = prepared.filter(p => p.name === name);
  const variants = prepared.filter(p => p.name.startsWith(name + " - "));
  if (variants.length) {
    const hits = variants.filter(p => {
      const suffix = p.name.slice(name.length + 3);
      return suffix && variation && (variation.includes(suffix) || suffix.includes(variation));
    });
    if (hits.length === 1) return { productId: hits[0].id, via: "nama" };
  }
  if (exact.length === 1 && !variants.length) return { productId: exact[0].id, via: "nama" };

  // 2. Model codes
  const nameCodes = modelCodes(listing.name);
  const varCodes = modelCodes(listing.variation);
  if (!nameCodes.length && !varCodes.length) return null;

  let best = null, bestScore = 0, tie = false;
  for (const p of prepared) {
    if (varCodes.length && !varCodes.some(c => p.name.includes(c))) continue;
    const score = [...nameCodes, ...varCodes].filter(c => p.name.includes(c)).length;
    if (score > bestScore) { best = p; bestScore = score; tie = false; }
    else if (score === bestScore && score > 0) tie = true;
  }
  if (best && !tie) return { productId: best.id, via: "kode model" };
  return null;
}

/** Validate the orders the browser sends back at commit time. */
export function sanitizeOrders(input) {
  if (!Array.isArray(input) || input.length === 0) throw Object.assign(new Error("Tidak ada pesanan untuk diimpor."), { expose: true });
  if (input.length > MAX_ORDERS) throw Object.assign(new Error(`Maksimal ${MAX_ORDERS} pesanan per import.`), { expose: true });
  const str = (v, max) => collapse(v).slice(0, max);
  return input.map(o => {
    const ref = str(o?.ref, 64);
    const soldAt = typeof o?.soldAt === "string" && !Number.isNaN(Date.parse(o.soldAt)) ? new Date(o.soldAt).toISOString() : null;
    if (!ref || !soldAt || !Array.isArray(o.lines) || o.lines.length === 0 || o.lines.length > 200) {
      throw Object.assign(new Error(`Data pesanan ${ref || "(tanpa nomor)"} tidak valid.`), { expose: true });
    }
    const lines = o.lines.map(l => {
      const qty = Number(l?.qty), unitPrice = Number(l?.unitPrice);
      const name = str(l?.name, 500);
      if (!name || !Number.isInteger(qty) || qty < 1 || qty > 100000 || !Number.isFinite(unitPrice) || unitPrice < 0) {
        throw Object.assign(new Error(`Baris barang pada pesanan ${ref} tidak valid.`), { expose: true });
      }
      const variation = str(l?.variation, 300);
      const line = { key: listingKey(name, variation), name, variation, qty, unitPrice: Math.round(unitPrice * 100) / 100 };
      // Per-line installation (income-report imports, where there's no variation to read it from).
      if (l.installType !== undefined && l.installType !== null) {
        try { const c = cleanInstall(l.installType, l.installMeters); line.installType = c.type; line.installMeters = c.meters; }
        catch (msg) { throw Object.assign(new Error(`Pesanan ${ref}: ${msg}`), { expose: true }); }
      }
      return line;
    });
    const subtotal = Math.round(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0) * 100) / 100;
    const discount = Math.min(Math.max(0, Math.round(Number(o.discount) || 0)), subtotal);
    return { ref, soldAt, buyer: str(o.buyer, 200), discount, subtotal, lines };
  });
}
