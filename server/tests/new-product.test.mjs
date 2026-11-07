// New website product proposed from a Shopee listing.
//   node tests/new-product.test.mjs
import assert from "node:assert/strict";
import { proposeNewProduct, newProductName, guessBrand, guessCategory } from "../src/finance/new-product.js";

const brands = ["TCL", "Midea", "Toshiba", "Philips"];
const categories = ["AC", "TV", "Kulkas", "Freezer", "Mesin Cuci", "Air Cooler"];

assert.deepEqual(
  proposeNewProduct({ name: "Philips DST0510 Setrika Kering Dry Iron . Baru & Bergaransi", variation: "" }, { brands, categories, price: 289999 }),
  { name: "Philips DST0510 Setrika Kering Dry Iron . Baru & Bergaransi", brand: "Philips", category: "Setrika", price: 289999 });

// Install packages and "AC SAJA" are how it was sold, not a variant; the seller prefix goes.
const ac = "KHUSUS INSTANT Midea MSFT-05CRN8 . R32 AC 1/2 PK Low Watt 360 Watt. Baru & Bergaransi";
for (const v of ["AC SAJA", "AC + PASANG +PIPA 5M", "AC +JASA PASANG SAJA", "Paket Tanpa Pasang 3"]) {
  assert.equal(newProductName(ac, v), "Midea MSFT-05CRN8 . R32 AC 1/2 PK Low Watt 360 Watt. Baru & Bergaransi");
}
// A real variant stays, in the catalogue's "Name - Variant" form
assert.equal(newProductName("Cosmos Kipas Angin 16 SAE", "Blue"), "Cosmos Kipas Angin 16 SAE - Blue");

assert.equal(guessCategory("Midea MSFT-05CRN8 AC 1/2 PK", categories), "AC");
assert.equal(guessCategory("Midea Tower Fan Air Cooler 4 Liter", categories), "Air Cooler");
assert.equal(guessCategory("Philips HD3003 Magic Com Rice Cooker", categories), "Rice Cooker");
assert.equal(guessCategory("Sesuatu yang lain", categories), "Lainnya");
assert.equal(guessBrand("Selang Gas Quantum + Regulator", brands), "");
assert.equal(guessBrand("MIDEA FS40-19K Kipas Angin", brands), "Midea");

console.log("new product: all assertions passed");
