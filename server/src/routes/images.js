// ---- Admin product image management: /api/admin/products/:id/images ----
// All routes are admin-only (requireAuth). Images are uploaded to Cloudinary and
// served from its CDN; the DB stores the returned HTTPS URL plus the public_id
// used to delete the asset again. Nothing is written to the server's disk, so
// uploads survive redeploys on hosts with an ephemeral filesystem.
//
// Legacy support: rows created before this migration still hold a local
// "/uploads/products/<file>" path and no public_id. Those keep rendering, and
// deleting one removes the local file instead of calling Cloudinary.
import { Router } from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import * as store from "../store.js";
import { requireAuth } from "../auth.js";
import { uploadBuffer, destroyImage, FOLDERS } from "../cloudinary.js";
import { imageUpload, runUpload, uploadErrorMessage, validateImageFile, assetId } from "../upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Only used to clean up pre-Cloudinary uploads (see LEGACY_URL_PREFIX below).
const LEGACY_DIR = path.join(__dirname, "..", "..", "uploads", "products");
const LEGACY_URL_PREFIX = "/uploads/products/";

const router = Router();

// Ensure the product exists before any image operation.
async function ensureProduct(req, res, next) {
  const product = await store.getProduct(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });
  req.product = product;
  next();
}

// Remove a legacy on-disk image (best effort, inside the uploads dir only).
async function removeLegacyFile(url) {
  if (!url || !url.startsWith(LEGACY_URL_PREFIX)) return;
  const file = path.join(LEGACY_DIR, path.basename(url));
  // path.basename strips any traversal; confirm the result stays in LEGACY_DIR.
  if (path.dirname(file) === LEGACY_DIR) await fs.unlink(file).catch(() => {});
}

// Delete the backing asset for an image row: Cloudinary when we have a
// public_id, otherwise the legacy local file.
async function removeStoredImage({ url, cloudinaryPublicId }) {
  if (cloudinaryPublicId) await destroyImage(cloudinaryPublicId);
  else await removeLegacyFile(url);
}

// GET /api/admin/products/:id/images — list images (admin)
router.get("/:id/images", requireAuth, ensureProduct, async (req, res, next) => {
  try {
    res.json(await store.getProductImages(req.params.id));
  } catch (err) { next(err); }
});

// POST /api/admin/products/:id/images — upload one or more images (admin)
// Multipart field name: "images" (accepts up to 10). Each file is validated,
// streamed to Cloudinary, and recorded in the DB.
router.post("/:id/images", requireAuth, ensureProduct, async (req, res, next) => {
  // 1) Parse the multipart body into memory (no disk writes).
  try {
    await runUpload(imageUpload.array("images", 10), req, res);
  } catch (err) {
    return res.status(400).json({ error: uploadErrorMessage(err) });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No image file provided (field name: 'images')." });
  }

  // 2) Validate everything up front so a bad file never reaches Cloudinary and
  //    we don't half-upload a batch.
  for (const file of req.files) {
    const problem = validateImageFile(file);
    if (problem) return res.status(400).json({ error: problem });
  }

  // 3) Upload, then record. If a DB write fails we delete the asset we just
  //    created, so Cloudinary never accumulates rows nothing points at.
  const alt = typeof req.body?.alt === "string" ? req.body.alt : req.product.name;
  const created = [];
  try {
    for (const file of req.files) {
      const asset = await uploadBuffer(file.buffer, {
        folder: FOLDERS.products,
        publicId: assetId(`p${req.product.id}`),
      });
      try {
        created.push(await store.addProductImage(req.params.id, asset.url, alt, asset.publicId));
      } catch (dbErr) {
        await destroyImage(asset.publicId);
        throw dbErr;
      }
    }
    res.status(201).json(created);
  } catch (err) {
    // Storage not configured (503) or Cloudinary refused the upload (502).
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/admin/products/:id/images/:imageId — delete image (admin)
router.delete("/:id/images/:imageId", requireAuth, ensureProduct, async (req, res, next) => {
  try {
    const removed = await store.deleteProductImage(req.params.id, req.params.imageId);
    if (!removed) return res.status(404).json({ error: "Image not found" });
    // The row is already gone; asset cleanup is best effort and never 500s.
    await removeStoredImage(removed);
    res.status(204).end();
  } catch (err) { next(err); }
});

// PUT /api/admin/products/:id/images/reorder — reorder (admin)
// Body: { order: [imageId, ...] }
router.put("/:id/images/reorder", requireAuth, ensureProduct, async (req, res, next) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : null;
    if (!order) return res.status(400).json({ error: "order must be an array of image ids" });
    await store.reorderImages(req.params.id, order);
    res.json(await store.getProductImages(req.params.id));
  } catch (err) { next(err); }
});

// PUT /api/admin/products/:id/images/:imageId/main — set primary (admin)
router.put("/:id/images/:imageId/main", requireAuth, ensureProduct, async (req, res, next) => {
  try {
    const ok = await store.setMainImage(req.params.id, req.params.imageId);
    if (!ok) return res.status(404).json({ error: "Image not found" });
    res.json(await store.getProductImages(req.params.id));
  } catch (err) { next(err); }
});

export default router;
