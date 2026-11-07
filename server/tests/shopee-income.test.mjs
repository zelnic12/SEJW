// Shopee income report (Laporan Penghasilan) parsing.
//   node tests/shopee-income.test.mjs
import assert from "node:assert/strict";
import { parseIncomeTable } from "../src/finance/shopee-income.js";

// Shape of the "Penghasilan" sheet: two header bands, the header row, then an
// Order row per order followed by its Sku rows.
const header = ["No.", "Lihat berdasarkan", "No. Pesanan", "No. Pengajuan", "ID Produk", "Nama Produk", "Waktu Pesanan Dibuat",
  "Tanggal Dana Dilepaskan", "Metode Pelepasan Dana", "Tipe Pesanan", "Total Penghasilan", "Harga Produk",
  "Biaya Administrasi", "Biaya Proses Pesanan", "Biaya Layanan Promo XTRA", "PPh 22"];
const table = [
  ["Informasi Pesanan", "", "", "", "", "", "", "", "", "", "Rincian Jumlah Pelepasan Dana"],
  ["", "", "", "", "", "", "", "", "", "", "Total Penghasilan", "Subtotal Pesanan"],
  header,
  ["1", "Order", "261104E8M3QMTF", "-", "-", "", "2026-11-04", "2026-11-06", "Saldo Penjual", "Normal Order", "503699", "619999", "-40300", "-1250", "-27900", "-3100"],
  ["2", "Sku", "261104E8M3QMTF", "-", "23825318583", "Maspion MD-19 PAS", "2026-11-04", "2026-11-06", "Saldo Penjual", "Normal Order", "503699", "619999", "-40300", "-1250", "-27900", "-3100"],
  ["3", "Order", "261104E3PV4HM9", "-", "-", "", "2026-11-04", "06/11/2026", "Saldo Penjual", "Normal Order", "68949", "84999", "-5525", "-1250", "-3825", "-425"],
];
const r = parseIncomeTable(table);
assert.equal(r.length, 2);                       // Sku rows ignored
assert.deepEqual(r[0], {
  ref: "261104E8M3QMTF", releasedOn: "2026-11-06", productPrice: 619999, payout: 503699,
  fees: { "Biaya Administrasi": 40300, "Biaya Proses Pesanan": 1250, "Biaya Layanan Promo XTRA": 27900, "PPh 22": 3100 },
});
assert.equal(r[1].releasedOn, "2026-11-06");
assert.throws(() => parseIncomeTable([["No. Pesanan", "Nama Produk"]]), /bukan laporan penghasilan/);

console.log("shopee income: all assertions passed");
