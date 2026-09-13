// ---- Brand logos: /api/brand-logos (public) ----
// Reports which brands have a logo file on disk, as a { slug: url } map. The
// storefront's "Shop by Brand" row uses it to decide whether to render an <img>
// or fall back to a text pill — so it never requests an image that isn't there
// and never shows a broken-image icon.
//
// Zero configuration: drop "aero.svg" into /assets/brands and the Aero tile
// starts using it. The filename (minus extension) must match the brand slug —
// the brand name lowercased with non-alphanumerics collapsed to "-".
import { Router } from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// assets/ lives in the static frontend, one level above server/.
const BRANDS_DIR = path.join(__dirname, "..", "..", "..", "assets", "brands");
const PUBLIC_PREFIX = "/assets/brands";

const ALLOWED_EXT = new Set([".svg", ".png", ".webp", ".jpg", ".jpeg"]);
const CACHE_MS = 60_000;   // the folder changes rarely; don't stat it on every hit

let cache = { at: 0, map: null };

// The single source of truth for the slug rule (mirrored in brand-row.js).
export function brandSlug(name) {
  return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function readLogoMap() {
  if (cache.map && Date.now() - cache.at < CACHE_MS) return cache.map;
  const map = {};
  try {
    for (const file of await fs.readdir(BRANDS_DIR)) {
      const ext = path.extname(file).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) continue;               // skips README.md etc.
      const slug = brandSlug(path.basename(file, ext));
      // First match wins if a brand has several formats (readdir is sorted).
      if (slug && !map[slug]) map[slug] = `${PUBLIC_PREFIX}/${file}`;
    }
  } catch (err) {
    // No folder yet → every brand falls back to a text pill. Not an error.
    if (err.code !== "ENOENT") throw err;
  }
  cache = { at: Date.now(), map };
  return map;
}

const router = Router();

// GET /api/brand-logos → { "aero": "/assets/brands/aero.svg", ... }
router.get("/", async (req, res, next) => {
  try {
    res.json(await readLogoMap());
  } catch (err) { next(err); }
});

export default router;
