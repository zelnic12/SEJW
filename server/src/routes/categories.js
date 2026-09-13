// ---- Categories: /api/categories ----
//
//   GET    /api/categories               public — name, product count, custom icon
//   PUT    /api/categories/:name/icon    admin  — upload/replace the icon (multipart)
//   DELETE /api/categories/:name/icon    admin  — clear it, back to the generic icon
//
// Categories are still just the distinct products.category values; category_icons
// only carries an optional image override per name. Uploads reuse the shared
// Cloudinary pipeline (memory storage → uploadBuffer → secure_url) — same
// validation as product and banner images.
import { Router } from "express";
import * as store from "../store.js";
import { requireAuth } from "../auth.js";
import { uploadBuffer, destroyImage, FOLDERS } from "../cloudinary.js";
import { imageUpload, runUpload, uploadErrorMessage, validateImageFile, assetId } from "../upload.js";

const router = Router();

// A filesystem/URL-safe fragment of the category name, only for readability in
// the Cloudinary media library — uniqueness comes from assetId().
const slug = name => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// GET /api/categories — drives the storefront tile row and the admin screen.
router.get("/", async (req, res, next) => {
  try {
    res.json(await store.listCategoriesWithIcons());
  } catch (err) { next(err); }
});

// PUT /api/categories/:name/icon — multipart, field name "icon".
router.put("/:name/icon", requireAuth, async (req, res, next) => {
  const name = String(req.params.name || "").trim();
  if (!name) return res.status(400).json({ error: "A category name is required." });

  // 1) Parse the upload into memory (nothing touches the disk).
  try {
    await runUpload(imageUpload.single("icon"), req, res);
  } catch (err) {
    return res.status(400).json({ error: uploadErrorMessage(err) });
  }
  if (!req.file) return res.status(400).json({ error: "No image file provided (field name: 'icon')." });

  const problem = validateImageFile(req.file);
  if (problem) return res.status(400).json({ error: problem });

  try {
    // 2) Only allow icons for categories the catalog actually uses — otherwise a
    //    typo would leave an orphan row nothing ever reads.
    if (!(await store.categoryExists(name))) {
      return res.status(404).json({ error: `No products are in a category called “${name}”.` });
    }

    // 3) Upload, then record. A failed write deletes the asset we just created.
    const asset = await uploadBuffer(req.file.buffer, {
      folder: FOLDERS.categories,
      publicId: assetId(`cat-${slug(name)}`),
    });

    let result;
    try {
      result = await store.upsertCategoryIcon(name, {
        iconUrl: asset.url,
        cloudinaryPublicId: asset.publicId,
      });
    } catch (dbErr) {
      await destroyImage(asset.publicId);
      throw dbErr;
    }

    // 4) The icon that was replaced is now unreferenced — best effort cleanup.
    if (result.previous?.cloudinaryPublicId) {
      await destroyImage(result.previous.cloudinaryPublicId);
    }
    res.json(result.icon);
  } catch (err) {
    // Storage not configured (503) or Cloudinary refused the upload (502).
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/categories/:name/icon — revert to the generic icon.
router.delete("/:name/icon", requireAuth, async (req, res, next) => {
  try {
    const removed = await store.deleteCategoryIcon(req.params.name);
    if (!removed) return res.status(404).json({ error: "That category doesn't have a custom icon." });
    await destroyImage(removed.cloudinaryPublicId);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
