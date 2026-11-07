// ---- New website product from a Shopee listing ----
// Pure logic: when a Shopee listing has no matching website product, propose
// the product to create (name, brand, category, price) so the import can add
// it to the catalogue and record the sale against it.
import { detectInstall } from "./install.js";
import { modelCodes } from "./shopee.js";

const collapse = s => String(s ?? "").replace(/\s+/g, " ").trim();

// Keyword → category, checked in order. Existing category names are reused
// when one matches (case-insensitive), so "AC" stays "AC".
const CATEGORY_RULES = [
  [/air\s*cooler|tower\s*fan|\bac\s+portable|portable\s+ac|\bpendingin\s+ruangan/i, "Air Cooler"],
  [/\bfreezer\b/i, "Freezer"],
  [/kulkas|showcase|lemari\s+pendingin|refrigerator/i, "Kulkas"],
  [/mesin\s+cuci|washing/i, "Mesin Cuci"],
  [/\b(?:tv|televisi)\b/i, "TV"],
  [/\bac\b|air\s+conditioner/i, "AC"],
  [/kipas|stand\s*fan|wall\s*fan|desk\s*fan/i, "Kipas Angin"],
  [/rice\s*cooker|magic\s*com|penanak/i, "Rice Cooker"],
  [/setrika|iron\b/i, "Setrika"],
  [/blender|juicer|chopper|food\s+processor/i, "Blender"],
  [/kompor|regulator|selang\s+gas/i, "Kompor & Gas"],
  [/dispenser/i, "Dispenser"],
  [/speaker|soundbar|audio/i, "Audio"],
];

/** Name for the new product: the Shopee name without seller prefixes, plus a real variant. */
export function newProductName(name, variation) {
  const base = collapse(name).replace(/^khusus\s+instant\s+/i, "");
  const v = collapse(variation);
  // Install packages and "AC SAJA" describe how it was sold, not which product it is.
  const isPackage = !v || /^ac\s+saja$/i.test(v) || detectInstall(v).type !== "none" || /paket|pasang/i.test(v);
  return (isPackage ? base : `${base} - ${v}`).slice(0, 300);
}

/**
 * Category from keywords; failing that, from catalogue products whose model
 * shares the same series prefix ("MSCE-07CRF8" → the category of "MSCE-10CRFN8").
 * catalog: [{ name, category }] (optional).
 */
export function guessCategory(text, existing = [], catalog = []) {
  const found = CATEGORY_RULES.find(([re]) => re.test(text));
  if (!found && catalog.length) {
    const prefixes = modelCodes(text).map(c => c.match(/^[a-z]+/)?.[0]).filter(p => p && p.length >= 2);
    if (prefixes.length) {
      const votes = new Map();
      for (const p of catalog) {
        if (!p.category) continue;
        const codes = modelCodes(p.name).map(c => c.match(/^[a-z]+/)?.[0]);
        if (codes.some(c => prefixes.includes(c))) votes.set(p.category, (votes.get(p.category) || 0) + 1);
      }
      const best = [...votes].sort((a, b) => b[1] - a[1])[0];
      if (best) return best[0];
    }
  }
  const name = found ? found[1] : "Lainnya";
  return existing.find(c => c.toLowerCase() === name.toLowerCase()) || name;
}

const GENERIC_WORDS = new Set(["selang", "kipas", "pipa", "bracket", "led", "ac", "tv", "kulkas", "freezer", "mesin",
  "setrika", "kompor", "regulator", "paket", "lampu", "kabel", "remote", "rice", "magic", "air", "smart", "mini", "new", "promo"]);

export function guessBrand(text, brands = []) {
  const t = ` ${collapse(text).toLowerCase()} `;
  const known = brands
    .filter(b => b && t.includes(` ${b.toLowerCase()} `))
    .sort((a, b) => b.length - a.length)[0];
  if (known) return known;
  // Otherwise the first word, unless it's a generic product word ("Selang Gas …").
  const first = collapse(text).replace(/^khusus\s+instant\s+/i, "").split(" ")[0] || "";
  if (GENERIC_WORDS.has(first.toLowerCase())) return "";
  return /^[A-Za-z][A-Za-z0-9-]{1,20}$/.test(first) ? first : "";
}

/**
 * listing: { name, variation }, price: the price to list it at (Shopee price
 * without any installation package). Returns { name, brand, category, price }.
 */
export function proposeNewProduct(listing, { brands = [], categories = [], catalog = [], price = 0 } = {}) {
  const name = newProductName(listing.name, listing.variation);
  return {
    name,
    brand: guessBrand(name, brands),
    category: guessCategory(name, categories, catalog),
    price: Math.max(0, Math.round(price)),
  };
}
