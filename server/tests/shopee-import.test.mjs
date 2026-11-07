// Shopee order export parsing + product matching (pure logic, no DB).
//   node tests/shopee-import.test.mjs
import assert from "node:assert/strict";
import {
  normalizeShopeeRows, suggestProduct, sanitizeOrders, parseRupiah, parseShopeeTime, listingKey,
} from "../src/finance/shopee.js";

const headers = [
  "No. Pesanan", "Status Pesanan", "Status Pembatalan/ Pengembalian", "Waktu Pesanan Dibuat",
  "Nama Produk", "Nomor Referensi SKU", "Nama Variasi", "Harga Setelah Diskon", "Jumlah",
  "Returned quantity", "Voucher Ditanggung Penjual", "Paket Diskon (Diskon dari Penjual)", "Username (Pembeli)",
];
const row = (o) => headers.map(h => o[h] ?? "");
const rows = [
  row({ "No. Pesanan": "A1", "Status Pesanan": "Selesai", "Waktu Pesanan Dibuat": "2026-11-01 14:03",
        "Nama Produk": "Midea MAC-400R0BPW / MAC-401ROBPK  Tower Fan Air Cooler 4 Liter . Baru & Bergaransi",
        "Nama Variasi": "MAC401 Putih", "Harga Setelah Diskon": "1.506.999", "Jumlah": "1", "Returned quantity": "0",
        "Voucher Ditanggung Penjual": "10.000", "Username (Pembeli)": "budi" }),
  // second line of the same order; order-level voucher repeats
  row({ "No. Pesanan": "A1", "Status Pesanan": "Selesai", "Waktu Pesanan Dibuat": "2026-11-01 14:03",
        "Nama Produk": "KHUSUS INSTANT TCL TAC-05CSD/XSS AC 1/2 PK 0.5 PK Low Watt 330 Watt . Baru & Bergaransi",
        "Nama Variasi": "AC SAJA", "Harga Setelah Diskon": "3.199.999", "Jumlah": "2", "Returned quantity": "1",
        "Voucher Ditanggung Penjual": "10.000" }),
  row({ "No. Pesanan": "B2", "Status Pesanan": "Batal", "Waktu Pesanan Dibuat": "2026-11-02 09:00",
        "Nama Produk": "Kipas", "Harga Setelah Diskon": "100.000", "Jumlah": "1" }),
  row({ "No. Pesanan": "C3", "Status Pesanan": "Selesai", "Waktu Pesanan Dibuat": "2026-11-03 10:00",
        "Nama Produk": "Cosmos Kipas Angin 16 SAE", "Harga Setelah Diskon": "289.999", "Jumlah": "1" }),
];

const products = [
  { id: 54, name: "TCL TAC-05CSD/XSS AC 1/2 PK 0.5 PK Low Watt 330 Watt . Baru & Bergaransi" },
  { id: 135, name: "Midea MAC-400R0BPW / MAC-401ROBPK  Tower Fan Air Cooler 4 Liter . Baru & Bergaransi - MAC400" },
  { id: 136, name: "Midea MAC-400R0BPW / MAC-401ROBPK  Tower Fan Air Cooler 4 Liter . Baru & Bergaransi - MAC401" },
  { id: 13, name: "TCL 50S5K GOOGLE TV QLED TV 50 Inch Full HD HDR10 . Baru & Bergaransi" },
];

// Money and time parsing
assert.equal(parseRupiah("1.506.999"), 1506999);
assert.equal(parseRupiah("Rp 1,506,999.50"), 1506999.5);
assert.equal(parseRupiah(""), 0);
assert.equal(parseShopeeTime("2026-11-01 14:03"), "2026-11-01T07:03:00.000Z");   // Jakarta → UTC

// Grouping, returns, cancellations
const r = normalizeShopeeRows(headers, rows);
assert.equal(r.orders.length, 2);
assert.deepEqual(r.skipped, [{ ref: "B2", reason: "Pesanan dibatalkan" }]);
const a1 = r.orders.find(o => o.ref === "A1");
assert.equal(a1.lines.length, 2);
assert.equal(a1.lines[1].qty, 1);                       // 2 sold, 1 returned
assert.equal(a1.subtotal, 1506999 + 3199999);
assert.equal(a1.discount, 10000);                       // counted once, not per line
assert.equal(r.listings.length, 3);

// Matching
const sug = l => suggestProduct(l, products)?.productId ?? null;
const byName = name => r.listings.find(l => l.name.startsWith(name));
assert.equal(sug(byName("Midea MAC")), 136);           // variation picks the MAC401 variant
assert.equal(sug(byName("KHUSUS INSTANT TCL")), 54);   // model code despite the "KHUSUS INSTANT" prefix
assert.equal(sug(byName("Cosmos")), null);             // not on the website
assert.equal(sug({ name: "TCL 50P7K (4K UHD QLED 120Hz) / 50S5K GOOGLE TV", variation: "50P7K" }), null); // variation model not stocked

// Missing columns are reported in plain words
assert.throws(() => normalizeShopeeRows(["No. Pesanan"], []), /Kolom yang hilang/);

// Commit payload is re-validated server side
const clean = sanitizeOrders(JSON.parse(JSON.stringify(r.orders)));
assert.equal(clean[0].lines[0].key, listingKey(r.orders[0].lines[0].name, r.orders[0].lines[0].variation));
assert.throws(() => sanitizeOrders([{ ref: "X", soldAt: "nope", lines: [] }]), /tidak valid/);

console.log("shopee import: all assertions passed");
