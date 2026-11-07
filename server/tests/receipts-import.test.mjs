// Barang masuk from Excel: column detection, dates, numbers and product matching.
//   node tests/receipts-import.test.mjs
import assert from "node:assert/strict";
import { normalizeReceiptRows, parseSheetDate, locateReceiptColumns, parseRupiahText } from "../src/finance/receipts-import.js";

const products = [
  { id: 54, shortName: "TCL TAC-05CSD/XSS", name: "TCL TAC-05CSD/XSS AC 1/2 PK 0.5 PK Low Watt 330 Watt . Baru & Bergaransi" },
  { id: 11, shortName: "Midea MSFQ-05CRN8", name: "Midea MSFQ-05CRN8 AC Split 1/2 PK 360 Watt . Baru & Bergaransi" },
  { id: 124, shortName: "Toshiba 32S25KP", name: "LED TV Toshiba 32S25KP \"32\" Inch HD Resolution Digital Ready. Baru & Bergaransi" },
];

// Dates
assert.equal(parseSheetDate("2026-11-07T00:00:00.000Z"), "2026-11-07");   // Excel date cell
assert.equal(parseSheetDate("07/11/2026"), "2026-11-07");                  // day first
assert.equal(parseSheetDate("7-11-26"), "2026-11-07");
assert.equal(parseSheetDate("46333"), "2026-11-07");                       // Excel serial
assert.equal(parseSheetDate("31/02/2026"), null);
assert.equal(parseSheetDate("besok"), null);

// Rupiah shorthand
assert.equal(parseRupiahText("250rb"), 250000);
assert.equal(parseRupiahText("3,1 jt"), 3100000);
assert.equal(parseRupiahText("Rp 2.650.000"), 2650000);
assert.equal(parseRupiahText("2650000"), 2650000);

// The template layout
const headers = ["ID produk", "Produk", "Stok sekarang", "Tanggal", "Jumlah", "Harga beli / unit", "Supplier", "Catatan"];
const rows = [
  ["54", "TCL TAC-05CSD/XSS", "0", "07/11/2026", "10", "2.650.000", "CV Sinar", "INV-1"],
  ["11", "Midea MSFQ-05CRN8", "10", "", "", "", "", ""],                   // no qty → skipped
  ["", "toshiba 32s25kp", "", "", "5", "Rp 1.700.000", "", ""],             // short name, any case
  ["", "AC TCL TAC-05CSD", "", "", "2", "2650000", "", ""],                 // model code
  ["", "Kipas Cosmos", "", "kemarin", "1", "250000", "", ""],              // unknown product, bad date
  ["124", "", "", "", "1,5", "x", "", ""],                                  // bad qty and cost
];
const r = normalizeReceiptRows(headers, rows, products);
assert.equal(r.skipped, 1);
assert.equal(r.rows.length, 5);
assert.deepEqual(
  r.rows.map(x => [x.row, x.productId, x.via, x.receivedOn, x.quantity, x.unitCost]),
  [
    [2, 54, "id", "2026-11-07", 10, 2650000],
    [4, 124, "nama", null, 5, 1700000],
    [5, 54, "kode model", null, 2, 2650000],
    [6, null, null, null, 1, 250000],
    [7, 124, "id", null, null, null],
  ]);
assert.deepEqual(r.rows[3].problems, ['Tanggal "kemarin" tidak terbaca', "Produk tidak ditemukan"]);
assert.equal(r.rows[4].problems.length, 2);

// A supplier's own sheet with other header names
assert.deepEqual(locateReceiptColumns(["Nama Barang", "Qty", "Harga", "Tgl"]).missing, []);
assert.throws(() => normalizeReceiptRows(["Nama", "Total"], [], products), /Kolom berikut tidak ditemukan/);

console.log("receipts import: all assertions passed");
