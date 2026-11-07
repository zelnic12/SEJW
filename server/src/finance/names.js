// Short product names for the bookkeeping screens: "Brand + model", e.g.
//   "TCL TAC-05CSD/XSS AC 1/2 PK 0.5 PK Low Watt 330 Watt . Baru & Bergaransi" → "TCL TAC-05CSD/XSS"
//   "Toshiba Z570 Gaming Series SMART TV … - 75Z570RP"                       → "Toshiba 75Z570RP"
//   "Reiwa CW-0501RA AC Window 0,5PK / 1 PK . Baru & Bergaransi - 1/2 PK"     → "Reiwa CW-0501RA 1/2 PK"
// Display only: the product's real name on the website is never changed.
import { NOT_A_MODEL } from "./shopee.js";

const collapse = s => String(s ?? "").replace(/\s+/g, " ").trim();

/** Model-code-looking tokens in their original case, in order of appearance. */
function codes(text) {
  const out = [];
  for (const t of String(text ?? "").match(/[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+)*/g) || []) {
    if (t.length >= 5 && /[a-z]/i.test(t) && /\d/.test(t) && !NOT_A_MODEL.test(t)
        && !/^\d+\/\d+[a-z]*$/i.test(t)                    // "1/2PK" is a capacity, not a model
        && !out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

export function shortProductName({ name, brand }) {
  const full = collapse(name);
  const b = collapse(brand);

  // Variant names (from Shopee imports) sit after the last " - ".
  let base = full, variant = "";
  const cut = full.lastIndexOf(" - ");
  if (cut > 0) {
    const suffix = full.slice(cut + 3).trim();
    if (suffix && suffix.length <= 30 && !suffix.includes(" . ")) { base = full.slice(0, cut); variant = suffix; }
  }

  const variantCodes = codes(variant);
  let model;
  if (variantCodes.length) {
    model = variantCodes[0];                         // the variant names the exact model
  } else {
    const baseCodes = codes(base).filter(c => c.toLowerCase() !== b.toLowerCase());
    if (baseCodes.length) model = variant ? `${baseCodes[0]} ${variant}` : baseCodes[0];
  }

  if (!model) {
    // No model code (e.g. "Bracket Outdoor AC …"): the name up to the first " . ", kept short.
    const head = collapse(full.split(" . ")[0]);
    return head.length > 45 ? head.slice(0, 45).replace(/\s+\S*$/, "") + "…" : head;
  }
  return b && !model.toLowerCase().startsWith(b.toLowerCase()) ? `${b} ${model}` : model;
}

/**
 * Short names for a whole catalogue, made unique: clashes get the category,
 * then the product id, so every name picks out exactly one product.
 * products: [{ id, name, brand, category }] → Map(id → shortName)
 */
export function shortProductNames(products) {
  const first = products.map(p => ({ p, s: shortProductName(p) }));
  const count = list => list.reduce((m, x) => m.set(x.s.toLowerCase(), (m.get(x.s.toLowerCase()) || 0) + 1), new Map());
  let seen = count(first);
  const second = first.map(x => (seen.get(x.s.toLowerCase()) > 1 && x.p.category ? { ...x, s: `${x.s} (${x.p.category})` } : x));
  seen = count(second);
  return new Map(second.map(x => [x.p.id, seen.get(x.s.toLowerCase()) > 1 ? `${x.s} #${x.p.id}` : x.s]));
}
