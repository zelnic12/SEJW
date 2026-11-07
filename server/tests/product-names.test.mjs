// Short "Brand + model" names for the bookkeeping screens.
//   node tests/product-names.test.mjs
import assert from "node:assert/strict";
import { shortProductName, shortProductNames } from "../src/finance/names.js";

const cases = [
  [{ brand: "TCL", name: "TCL TAC-05CSD/XSS AC 1/2 PK 0.5 PK Low Watt 330 Watt . Baru & Bergaransi" }, "TCL TAC-05CSD/XSS"],
  [{ brand: "Toshiba", name: "Toshiba Z570 Gaming Series SMART TV 144Hz UHD 4K Dolby Vision . Baru & Bergaransi - 75Z570RP" }, "Toshiba 75Z570RP"],
  [{ brand: "TCL", name: "TCL 43P6K (4K) / 43V51C GOOGLE TV QLED TV 43 Inch Full HD HDR10 . Baru & Bergaransi - 43V51C" }, "TCL 43V51C"],
  [{ brand: "Reiwa", name: "Reiwa CW-0501RA AC Window 0,5PK / 1 PK . Baru & Bergaransi - 1/2 PK" }, "Reiwa CW-0501RA 1/2 PK"],
  [{ brand: "Toshiba", name: "4K UHD LED TV Toshiba 65C350RP LED TV 65\" SMART VIDAA TV HDR10 Dolby Vision . Baru & Bergaransi" }, "Toshiba 65C350RP"],
  [{ brand: "GREE", name: "FLIFE by GREE FAC09FLOO AC Split 1PK Standard Series 720Watt . Baru & Bergaransi" }, "GREE FAC09FLOO"],
  [{ brand: "LG", name: "AC LG 1/2 PK H05TN4 Low Watt . Baru & Bergaransi" }, "LG H05TN4"],
  [{ brand: "Maspion", name: "Maspion UFH 100C . Sliding Door Freezer 100 Liter . Baru & Bergaransi" }, "Maspion UFH 100C"],
];
for (const [p, want] of cases) assert.equal(shortProductName(p), want, p.name);

// Clashes are made unique: first with the category, then with the id.
const m = shortProductNames([
  { id: 1, brand: "Midea", category: "AC", name: "Midea ABC-123 AC" },
  { id: 2, brand: "Midea", category: "Kulkas", name: "Midea ABC-123 Kulkas" },
  { id: 3, brand: "Midea", category: "Kulkas", name: "Midea ABC-123 Kulkas lain" },
]);
assert.equal(m.get(1), "Midea ABC-123 (AC)");
assert.equal(m.get(2), "Midea ABC-123 (Kulkas) #2");
assert.equal(new Set(m.values()).size, 3);

console.log("product names: all assertions passed");
