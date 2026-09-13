// ---- Homepage hero banners ----
// Public:  GET /api/banners                 → active slides in display order.
// Admin:   GET/POST/PUT/DELETE + reorder + image upload (JWT at the mount point).
//
// Banner images are uploaded to Cloudinary (same mechanism as product images —
// see src/cloudinary.js) and served from its CDN. The DB stores the returned
// HTTPS URL plus the public_id needed to delete the asset. Admins can also paste
// an external image URL instead of uploading, in which case there is no
// public_id and nothing to clean up.
//
// Legacy support: banners created before this migration may hold a local
// "/uploads/banners/<file>" path; those keep working and are cleaned off disk.
import { Router } from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import * as store from "../store.js";
import { uploadBuffer, destroyImage, FOLDERS } from "../cloudinary.js";
import { imageUpload, runUpload, uploadErrorMessage, validateImageFile, assetId } from "../upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Only used to clean up pre-Cloudinary uploads.
const LEGACY_DIR = path.join(__dirname, "..", "..", "uploads", "banners");
const LEGACY_URL_PREFIX = "/uploads/banners/";

// ---------------------------------------------------------------------------
// Public router (mounted at /api/banners)
// ---------------------------------------------------------------------------
export const publicBannersRouter = Router();

// GET /api/banners — active slides only, ordered by position.
publicBannersRouter.get("/", async (req, res, next) => {
  try { res.json(await store.listActiveBanners()); }
  catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Admin router (mounted at /api/admin/banners — requireAuth at the mount)
// ---------------------------------------------------------------------------
export const adminBannersRouter = Router();

const DEFAULT_BG = "#C8102E"; // brand red — used when a slide has no image

// Allow relative links ("category.html?name=Audio", "/x", "#deals") and http(s)
// URLs. Anything with another scheme (javascript:, data:, file:…) is rejected.
function safeLink(value) {
  const link = String(value || "").trim();
  if (!link) return "";
  const scheme = link.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme) return /^https?$/i.test(scheme[1]) ? link : null;  // null = invalid
  return link;
}

function validateBannerInput(body, { partial = false } = {}) {
  const errors = [];
  const has = k => body[k] !== undefined && body[k] !== null;

  if (!partial || has("headline")) {
    const h = typeof body.headline === "string" ? body.headline.trim() : "";
    if (h.length < 2 || h.length > 120) errors.push("headline must be 2–120 characters");
  }
  if (has("subtext") && String(body.subtext).length > 300) errors.push("subtext must be 300 characters or fewer");
  if (has("ctaText") && String(body.ctaText).length > 40) errors.push("ctaText must be 40 characters or fewer");
  if (has("ctaLink") && safeLink(body.ctaLink) === null) {
    errors.push("ctaLink must be a relative link (e.g. category.html?name=Audio) or an http(s) URL");
  }
  if (has("imageUrl") && body.imageUrl !== "" && safeLink(body.imageUrl) === null) {
    errors.push("imageUrl must be a relative path (e.g. /uploads/banners/x.jpg) or an http(s) URL");
  }
  if (has("backgroundColor") && body.backgroundColor !== "" &&
      !/^#[0-9a-f]{3,8}$/i.test(String(body.backgroundColor).trim())) {
    errors.push("backgroundColor must be a hex colour like #C8102E");
  }
  if (has("position") && !Number.isInteger(Number(body.position))) {
    errors.push("position must be an integer");
  }
  return errors;
}

// Remove a legacy on-disk banner image (best effort, uploads dir only).
async function removeLegacyFile(url) {
  if (!url || !url.startsWith(LEGACY_URL_PREFIX)) return;
  const file = path.join(LEGACY_DIR, path.basename(url));
  if (path.dirname(file) === LEGACY_DIR) await fs.unlink(file).catch(() => {});
}

// Drop the asset backing a banner image: Cloudinary when we have a public_id,
// otherwise the legacy local file. Pasted external URLs are left alone.
async function removeStoredImage(banner) {
  if (!banner) return;
  if (banner.imagePublicId) await destroyImage(banner.imagePublicId);
  else await removeLegacyFile(banner.imageUrl);
}

// GET /api/admin/banners — all slides (active + inactive)
adminBannersRouter.get("/", async (req, res, next) => {
  try { res.json(await store.listBanners()); }
  catch (err) { next(err); }
});

// POST /api/admin/banners/upload — upload one image, returns { url, publicId }
// Multipart field name: "image". The admin form sends both values back when it
// creates/updates the banner.
adminBannersRouter.post("/upload", async (req, res, next) => {
  try {
    await runUpload(imageUpload.single("image"), req, res);
  } catch (err) {
    return res.status(400).json({ error: uploadErrorMessage(err) });
  }
  if (!req.file) return res.status(400).json({ error: "No image file provided (field name: 'image')." });

  const problem = validateImageFile(req.file);
  if (problem) return res.status(400).json({ error: problem });

  try {
    const asset = await uploadBuffer(req.file.buffer, {
      folder: FOLDERS.banners,
      publicId: assetId("banner"),
    });
    res.status(201).json({ url: asset.url, publicId: asset.publicId });
  } catch (err) {
    // Storage not configured (503) or Cloudinary refused the upload (502).
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// PUT /api/admin/banners/reorder — body: { order: [id, ...] }
// Declared before /:id so "reorder" is never treated as an id.
adminBannersRouter.put("/reorder", async (req, res, next) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!order) return res.status(400).json({ error: "order must be an array of banner ids" });
    if (order.some(id => !Number.isInteger(Number(id)))) {
      return res.status(400).json({ error: "order must contain numeric banner ids" });
    }
    res.json(await store.reorderBanners(order));
  } catch (err) { next(err); }
});

// POST /api/admin/banners — create
adminBannersRouter.post("/", async (req, res, next) => {
  try {
    const errors = validateBannerInput(req.body, { partial: false });
    if (errors.length) return res.status(400).json({ error: "Validation failed", details: errors });
    const imageUrl = String(req.body.imageUrl || "").trim() || null;
    const created = await store.createBanner({
      imageUrl,
      // Only meaningful for images we uploaded ourselves; null for pasted URLs.
      imagePublicId: imageUrl ? (String(req.body.imagePublicId || "").trim() || null) : null,
      // A slide with no image still needs something to render against.
      backgroundColor: String(req.body.backgroundColor || "").trim() || (imageUrl ? null : DEFAULT_BG),
      headline: String(req.body.headline).trim(),
      subtext: String(req.body.subtext || "").trim() || null,
      ctaText: String(req.body.ctaText || "").trim() || null,
      ctaLink: safeLink(req.body.ctaLink) || null,
      position: req.body.position === undefined || req.body.position === null || req.body.position === ""
        ? null : Number(req.body.position),
      isActive: req.body.isActive !== false,
    });
    res.status(201).json(created);
  } catch (err) { next(err); }
});

// PUT /api/admin/banners/:id — update (partial; also used for the active toggle)
adminBannersRouter.put("/:id", async (req, res, next) => {
  try {
    const existing = await store.getBanner(req.params.id);
    if (!existing) return res.status(404).json({ error: "Banner not found" });
    const errors = validateBannerInput(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ error: "Validation failed", details: errors });

    const data = {};
    if (req.body.headline !== undefined) data.headline = String(req.body.headline).trim();
    if (req.body.subtext !== undefined) data.subtext = String(req.body.subtext || "").trim() || null;
    if (req.body.ctaText !== undefined) data.ctaText = String(req.body.ctaText || "").trim() || null;
    if (req.body.ctaLink !== undefined) data.ctaLink = safeLink(req.body.ctaLink) || null;
    if (req.body.position !== undefined) data.position = Number(req.body.position);
    if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;
    if (req.body.imageUrl !== undefined) {
      data.imageUrl = String(req.body.imageUrl || "").trim() || null;
      // The public_id always travels with the URL: a new/cleared image must
      // never keep pointing at the previous asset.
      data.imagePublicId = data.imageUrl
        ? (String(req.body.imagePublicId || "").trim() || null)
        : null;
    }
    if (req.body.backgroundColor !== undefined) {
      data.backgroundColor = String(req.body.backgroundColor || "").trim() || null;
    }
    // Never end up with neither an image nor a background colour.
    const nextImage = data.imageUrl !== undefined ? data.imageUrl : existing.imageUrl;
    const nextBg = data.backgroundColor !== undefined ? data.backgroundColor : existing.backgroundColor;
    if (!nextImage && !nextBg) data.backgroundColor = DEFAULT_BG;

    const updated = await store.updateBanner(req.params.id, data);
    // The image was swapped out or removed → drop the asset it used to point at.
    if (data.imageUrl !== undefined && existing.imageUrl && existing.imageUrl !== data.imageUrl) {
      await removeStoredImage(existing);
    }
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/admin/banners/:id
adminBannersRouter.delete("/:id", async (req, res, next) => {
  try {
    const removed = await store.deleteBanner(req.params.id);
    if (!removed) return res.status(404).json({ error: "Banner not found" });
    await removeStoredImage(removed);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default publicBannersRouter;
