// ---- Shopee income report (Laporan Penghasilan) ----
// Pure logic for the "Penghasilan" sheet of Seller Centre's
// Keuangan → Penghasilan Saya → Sudah Dilepas → Export. The sheet has two
// header bands above the real header row, then one "Order" row per order
// followed by its "Sku" rows; only the Order rows are used.
import { parseMessyNumber } from "../import/products.js";

const collapse = s => String(s ?? "").replace(/\s+/g, " ").trim();
const norm = s => collapse(s).toLowerCase();

// Deductions worth showing separately (negative numbers in the sheet).
export const FEE_COLUMNS = [
  "Biaya Administrasi", "Biaya Proses Pesanan",
  "Biaya Gratis Ongkir XTRA - Ukuran Khusus (Kategori D)", "Biaya Gratis Ongkir XTRA - Ukuran Biasa (Kategori D)",
  "Biaya Transaksi", "Biaya Layanan Promo XTRA", "Biaya Kampanye", "Biaya Komisi AMS",
  "Biaya Isi Saldo Otomatis (dari Penghasilan)", "Premi", "FBS Fee", "PPh 22",
];

const num = v => {
  const n = parseMessyNumber(collapse(v));
  return n == null || !Number.isFinite(n) ? 0 : n;
};

/** "2026-11-06", "06/11/2026" or an Excel date (ISO string) → "YYYY-MM-DD" | null */
function day(v) {
  const s = collapse(v);
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

/**
 * table: rows of cell strings for the whole sheet.
 * Returns [{ ref, releasedOn, productPrice, payout, fees: { name: amount } }].
 */
export function parseIncomeTable(table) {
  const hi = table.findIndex(r => r.some(c => norm(c) === "no. pesanan") && r.some(c => norm(c) === "total penghasilan"));
  if (hi === -1) {
    const err = new Error('File ini bukan laporan penghasilan Shopee. Ekspor dari Keuangan → Penghasilan Saya → Sudah Dilepas.');
    err.expose = true;
    throw err;
  }
  const headers = table[hi].map(norm);
  const col = name => headers.indexOf(norm(name));
  const iRef = col("No. Pesanan"), iKind = col("Lihat berdasarkan"), iTotal = col("Total Penghasilan");
  const iPrice = col("Harga Produk"), iDate = col("Tanggal Dana Dilepaskan");

  const out = new Map();
  for (const r of table.slice(hi + 1)) {
    const ref = collapse(r[iRef]);
    if (!ref || ref === "-") continue;
    if (iKind !== -1 && norm(r[iKind]) !== "order") continue;
    if (out.has(ref)) continue;
    const fees = {};
    for (const name of FEE_COLUMNS) {
      const i = col(name);
      const v = i === -1 ? 0 : num(r[i]);
      if (v) fees[name] = -v;
    }
    out.set(ref, {
      ref,
      releasedOn: iDate === -1 ? null : day(r[iDate]),
      productPrice: iPrice === -1 ? 0 : Math.round(num(r[iPrice])),
      payout: Math.round(num(r[iTotal])),
      fees,
    });
  }
  return [...out.values()];
}
