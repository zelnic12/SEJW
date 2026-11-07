// ---- AC installation (jasa pasang) ----
// Pure logic: what an installation costs the store, and reading the install
// package from a Shopee variation such as "AC + PASANG +PIPA 5M".

export const INSTALL_TYPES = ["none", "full", "service", "material"];

export const INSTALL_LABELS = {
  none: "Tanpa pasang",
  full: "Pasang + material",
  service: "Pasang saja",
  material: "Material saja",
};

// Defaults; the live values are in finance_settings('install_rates').
export const DEFAULT_RATES = {
  service: 250000,        // jasa pasang, per AC
  pipePerMeter: 75000,    // pipa, per meter
  cablePerMeter: 13500,   // kabel listrik, per meter
  ductTape: 5000,         // per pemasangan
  drainHose: 5000,        // selang pembuangan 2 m, per pemasangan
  bracket: 34000,         // per pemasangan
};

export const MAX_METERS = 50;

export const needsMeters = type => type === "full" || type === "material";

export function materialCost(meters, rates) {
  return meters * (rates.pipePerMeter + rates.cablePerMeter) + rates.ductTape + rates.drainHose + rates.bracket;
}

/** Cost of one installation package, in rupiah. */
export function installCost(type, meters, rates = DEFAULT_RATES) {
  switch (type) {
    case "service":  return rates.service;
    case "full":     return rates.service + materialCost(meters, rates);
    case "material": return materialCost(meters, rates);
    default:         return 0;
  }
}

/** Validate { installType, installMeters } from a request. Throws a message string. */
export function cleanInstall(type, meters) {
  const t = INSTALL_TYPES.includes(type) ? type : "none";
  if (!needsMeters(t)) return { type: t, meters: null };
  const m = Number(meters);
  if (!Number.isInteger(m) || m < 1 || m > MAX_METERS) throw `Panjang pipa harus 1–${MAX_METERS} meter.`;
  return { type: t, meters: m };
}

/** Validate a rates object (all non-negative whole rupiah). */
export function cleanRates(input) {
  const out = {};
  for (const k of Object.keys(DEFAULT_RATES)) {
    const v = Number(input?.[k]);
    if (!Number.isFinite(v) || v < 0 || v > 100_000_000) throw `Tarif "${k}" tidak valid.`;
    out[k] = Math.round(v);
  }
  return out;
}

/**
 * Read the install package from a Shopee variation (or listing name):
 *   "AC + PASANG +PIPA 5M"  → full, 5 m        "AC +JASA PASANG SAJA" → service
 *   "Paket Tanpa Pasang 3"  → material, 3 m    "AC SAJA"              → none
 */
export function detectInstall(text) {
  const s = String(text ?? "").toLowerCase();
  const m = s.match(/(\d{1,2})\s*(?:m\b|meter|mtr)/) || s.match(/(?:pipa|paket)[^\d]*(\d{1,2})\b/) || s.match(/\b(\d{1,2})\s*$/);
  const meters = m ? Number(m[1]) : null;
  if (/tanpa\s+pasang/.test(s)) return meters ? { type: "material", meters } : { type: "none", meters: null };
  if (/pasang\s*saja|jasa\s*pasang\s*saja/.test(s)) return { type: "service", meters: null };
  if (/pasang/.test(s)) return meters ? { type: "full", meters } : { type: "service", meters: null };
  return { type: "none", meters: null };
}
