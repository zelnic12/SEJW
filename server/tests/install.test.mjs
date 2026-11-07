// AC installation (jasa pasang) costs and reading packages from Shopee variations.
//   node tests/install.test.mjs
import assert from "node:assert/strict";
import { installCost, detectInstall, cleanInstall, cleanRates, DEFAULT_RATES } from "../src/finance/install.js";

// 250.000 jasa + 3 × (75.000 pipa + 13.500 kabel) + 5.000 duct tape + 5.000 selang + 34.000 bracket
assert.equal(installCost("full", 3), 559500);
assert.equal(installCost("full", 5), 736500);
assert.equal(installCost("service"), 250000);
assert.equal(installCost("material", 3), 309500);
assert.equal(installCost("none"), 0);
// AC 1/2 PK sold at 3.500.000 with installation and 3 m of materials
assert.equal(3500000 - installCost("full", 3), 2940500);

const cases = {
  "AC SAJA": ["none", null],
  "AC + PASANG +PIPA 5M": ["full", 5],
  "AC +Pasang + Pipa 3M": ["full", 3],
  "AC +JASA PASANG SAJA": ["service", null],
  "Paket Tanpa Pasang 5": ["material", 5],
  "FS40-19K-A": ["none", null],
};
for (const [text, [type, meters]] of Object.entries(cases)) assert.deepEqual(detectInstall(text), { type, meters }, text);

assert.deepEqual(cleanInstall("full", "7"), { type: "full", meters: 7 });
assert.deepEqual(cleanInstall("service", 9), { type: "service", meters: null });
assert.deepEqual(cleanInstall("bogus"), { type: "none", meters: null });
assert.throws(() => cleanInstall("full", 0));
assert.deepEqual(cleanRates({ ...DEFAULT_RATES, service: "300000" }), { ...DEFAULT_RATES, service: 300000 });
assert.throws(() => cleanRates({ ...DEFAULT_RATES, bracket: -1 }));

console.log("install: all assertions passed");
