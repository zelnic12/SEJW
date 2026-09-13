// ---- Homepage hero banners ----
// Public:  GET /api/banners                 → active slides in display order.
// Admin:   GET/POST/PUT/DELETE + reorder + image upload (JWT at the mount point).
//
// Banner images reuse the same multer disk-storage mechanism as product images
// (see routes/images.js): the file lands in server/uploads/<dir> and the DB only
// ever stores the URL. Admins can also paste an external image URL instead.
import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as store from "../store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads", "banners");

const ALLOWED = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try { await fs.mkdir(UPLOAD_DIR, { recursive: true }); cb(null, UPLOAD_DIR); }
    catch (err) { cb(err); }
  },
  // Random filename — the client's filename is never used for the path.
  filename: (req, file, cb) => {
    const ext = ALLOWED[file.mimetype] || ".bin";
    cb(null, `b-${Date.now()}-${crypto.randomBytes(12).toString("hex")}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED[file.mimetype]) cb(null, true);
    else cb(new Error("Unsupported file type. Allowed: JPG, PNG, WebP."));
  },
});

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

// Delete a previously uploaded banner file (best effort, uploads dir only).
async function removeUploadedImage(url) {
  if (!url || !url.startsWith("/uploads/banners/")) return;
  const file = path.join(UPLOAD_DIR, path.basename(url));
  if (path.dirname(file) === UPLOAD_DIR) await fs.unlink(file).catch(() => {});
}

// GET /api/admin/banners — all slides (active + inactive)
adminBannersRouter.get("/", async (req, res, next) => {
  try { res.json(await store.listBanners()); }
  catch (err) { next(err); }
});

// POST /api/admin/banners/upload — upload one image, returns { url }
// Multipart field name: "image". Used by the admin form before create/update.
adminBannersRouter.post("/upload", (req, res, next) => {
  upload.single("image")(req, res, (err) => {
    if (err) {
      const msg = err.code === "LIMIT_FILE_SIZE"
        ? "File too large (max 5 MB)."
        : err.message || "Upload failed.";
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: "No image file provided (field name: 'image')." });
    res.status(201).json({ url: `/uploads/banners/${req.file.filename}` });
  });
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
    if (req.body.imageUrl !== undefined) data.imageUrl = String(req.body.imageUrl || "").trim() || null;
    if (req.body.backgroundColor !== undefined) {
      data.backgroundColor = String(req.body.backgroundColor || "").trim() || null;
    }
    // Never end up with neither an image nor a background colour.
    const nextImage = data.imageUrl !== undefined ? data.imageUrl : existing.imageUrl;
    const nextBg = data.backgroundColor !== undefined ? data.backgroundColor : existing.backgroundColor;
    if (!nextImage && !nextBg) data.backgroundColor = DEFAULT_BG;

    const updated = await store.updateBanner(req.params.id, data);
    // If the image was swapped out, drop the old uploaded file.
    if (data.imageUrl !== undefined && existing.imageUrl && existing.imageUrl !== data.imageUrl) {
      await removeUploadedImage(existing.imageUrl);
    }
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/admin/banners/:id
adminBannersRouter.delete("/:id", async (req, res, next) => {
  try {
    const removed = await store.deleteBanner(req.params.id);
    if (!removed) return res.status(404).json({ error: "Banner not found" });
    await removeUploadedImage(removed.imageUrl);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default publicBannersRouter;
