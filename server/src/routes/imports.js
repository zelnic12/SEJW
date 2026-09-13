// ---- Bulk product import: /api/admin/imports/products (admin only) ----
//
//   POST .../parse    multipart spreadsheet → headers, rows, suggested mapping
//   POST .../preview  { mapping, rows }     → dry run: per-row status + counts
//   POST .../commit   { mapping, rows }     → inserts, then a full report
//
// The parsed rows travel back to the browser and return with the mapping, so the
// server keeps no per-import state and nothing is written to disk (which also
// means an import survives a redeploy mid-wizard). Preview and commit share
// normalizeRows(), so the preview is exactly what commit will do.
import { Router } from "express";
import * as store from "../store.js";
import {
  IMPORT_FIELDS, MAX_ROWS, PREVIEW_ROWS,
  parseSpreadsheet, suggestMapping, validateMapping, normalizeRows, summarize,
} from "../import/products.js";
import { uploadBuffer, destroyImage, FOLDERS } from "../cloudinary.js";
import {
  spreadsheetUpload, runUpload, uploadErrorMessage, validateImageFile,
  assetId, MAX_BYTES as MAX_IMAGE_BYTES,
} from "../upload.js";

const router = Router();

// Image fetching is best effort and bounded: a spreadsheet with hundreds of dead
// Shopee CDN links shouldn't keep the request open for minutes.
const IMAGE_TIMEOUT_MS = 8000;
const IMAGE_CONCURRENCY = 4;
const MAX_IMAGE_FETCHES = 250;

// The URLs come from an untrusted spreadsheet, so don't let one point our own
// server at internal addresses. (Hostname-level check; DNS rebinding is out of
// scope for an authenticated admin action.)
function isBlockedImageHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

/**
 * Fetch a remote image and hand it to the existing Cloudinary helper.
 * Throws with a short, admin-readable reason — callers treat any failure as
 * "import the product, flag it as needing an image".
 */
async function fetchImageToCloudinary(url, productId) {
  const parsed = new URL(url);
  if (isBlockedImageHost(parsed.hostname)) throw new Error("URL points at a private address");

  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      // Some CDNs (Shopee's included) refuse requests without a UA.
      headers: { "User-Agent": "SinarElektronik-ProductImport/1.0", Accept: "image/*" },
    });
  } catch (err) {
    throw new Error(err.name === "TimeoutError" ? "Image download timed out" : "Image download failed");
  }
  if (!res.ok) throw new Error(`Image URL returned HTTP ${res.status}`);

  const declared = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (declared && !declared.startsWith("image/")) throw new Error(`URL returned ${declared}, not an image`);

  const length = Number(res.headers.get("content-length") || 0);
  if (length && length > MAX_IMAGE_BYTES) throw new Error("Image is larger than 5 MB");

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Image is larger than 5 MB");

  // Same validation (and magic-byte check) as a hand-uploaded product image.
  const problem = validateImageFile({ buffer, size: buffer.length, mimetype: declared || "image/jpeg" });
  if (problem) throw new Error(problem);

  const asset = await uploadBuffer(buffer, {
    folder: FOLDERS.products,
    publicId: assetId(`p${productId}`),
  });
  return asset;
}

// Small concurrency limiter — keeps image fetching from going one-at-a-time
// without hammering the source with hundreds of parallel requests.
async function inBatches(items, size, worker) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(worker));
  }
}

// Shared payload validation for preview + commit.
function readPayload(req) {
  const rows = req.body?.rows;
  const headers = Array.isArray(req.body?.headers) ? req.body.headers : [];
  if (!Array.isArray(rows)) return { error: "rows must be an array of spreadsheet rows" };
  if (rows.length === 0) return { error: "There are no rows to import." };
  if (rows.length > MAX_ROWS) return { error: `Too many rows (${rows.length}). The limit is ${MAX_ROWS} per import.` };
  if (rows.some(r => !Array.isArray(r))) return { error: "Every row must be an array of cell values" };

  const headerCount = Math.max(headers.length, ...rows.map(r => r.length), 0);
  const mappingErrors = validateMapping(req.body?.mapping, headerCount);
  if (mappingErrors.length) return { error: "Mapping is incomplete", details: mappingErrors };

  const firstDataRow = Number.isInteger(req.body?.firstDataRow) ? req.body.firstDataRow : 2;
  return { rows, headers, mapping: req.body.mapping, firstDataRow };
}

// ---------------------------------------------------------------------------
// POST /api/admin/imports/products/parse — read the uploaded spreadsheet
// ---------------------------------------------------------------------------
router.post("/products/parse", async (req, res, next) => {
  try {
    await runUpload(spreadsheetUpload.single("file"), req, res);
  } catch (err) {
    return res.status(400).json({ error: uploadErrorMessage(err) });
  }
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: 'file')." });

  try {
    const parsed = await parseSpreadsheet(req.file.buffer, req.file.originalname);
    if (parsed.rows.length === 0) {
      return res.status(400).json({ error: "That file has column headers but no data rows." });
    }
    res.json({
      fileName: req.file.originalname,
      ...parsed,
      suggestedMapping: suggestMapping(parsed.headers),
      fields: IMPORT_FIELDS.map(({ key, label, required, hint }) => ({ key, label, required, hint })),
    });
  } catch (err) {
    // Corrupt/locked/foreign files land here — report, don't 500.
    res.status(400).json({ error: `Couldn't read that spreadsheet: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/imports/products/preview — dry run
// ---------------------------------------------------------------------------
router.post("/products/preview", async (req, res, next) => {
  try {
    const payload = readPayload(req);
    if (payload.error) return res.status(400).json({ error: payload.error, details: payload.details });

    const existingNames = new Set(await store.listProductNamesLower());
    const normalized = normalizeRows(payload.rows, payload.mapping, {
      existingNames, headers: payload.headers, firstDataRow: payload.firstDataRow,
    });

    const limit = Math.min(Number(req.body?.previewRows) || PREVIEW_ROWS, 100);
    res.json({
      summary: summarize(normalized),
      // The table the admin reviews: the first N rows exactly as they'd import.
      rows: normalized.slice(0, limit),
      // Everything that needs attention beyond that window, so problems further
      // down the file aren't invisible.
      problems: normalized
        .filter(r => r.status === "error" || r.status === "duplicate")
        .slice(0, 100),
      previewRows: limit,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/imports/products/commit — insert the ready rows
// ---------------------------------------------------------------------------
router.post("/products/commit", async (req, res, next) => {
  try {
    const payload = readPayload(req);
    if (payload.error) return res.status(400).json({ error: payload.error, details: payload.details });

    const existingNames = new Set(await store.listProductNamesLower());
    const normalized = normalizeRows(payload.rows, payload.mapping, {
      existingNames, headers: payload.headers, firstDataRow: payload.firstDataRow,
    });

    const fetchImages = req.body?.fetchImages !== false;
    const results = [];
    const imageJobs = [];

    // ---- 1. insert products (sequentially: order and row numbers stay honest) ----
    for (const row of normalized) {
      if (row.status === "empty") continue;

      if (row.status === "error") {
        results.push({
          rowNumber: row.rowNumber, name: row.raw.name || "(no name)",
          outcome: "failed", reasons: row.errors,
        });
        continue;
      }
      if (row.status === "duplicate") {
        results.push({
          rowNumber: row.rowNumber, name: row.values.name,
          outcome: "skipped", reasons: row.warnings.filter(w => w.includes("already exists") || w.includes("Same name")),
        });
        continue;
      }

      try {
        const product = await store.createProduct({
          name: row.values.name,
          brand: row.values.brand,
          category: row.values.category,
          price: row.values.price,
          stock: row.values.stock,
          description: row.values.description,
        });
        const result = {
          rowNumber: row.rowNumber, id: product.id, name: product.name,
          outcome: "imported", reasons: [...row.warnings], needsImage: false,
        };
        results.push(result);

        if (row.values.imageUrl && fetchImages) {
          imageJobs.push({ result, url: row.values.imageUrl, productId: product.id });
        } else if (row.values.imageUrl && !fetchImages) {
          result.needsImage = true;
          result.reasons.push("Image not fetched (image import was turned off)");
        } else if (row.raw.imageUrl) {
          // The spreadsheet had something in the image column but it wasn't a
          // usable URL (normalisation already explained why in the warnings) —
          // the product is still missing an image, so say so in the summary.
          result.needsImage = true;
        }
      } catch (err) {
        results.push({
          rowNumber: row.rowNumber, name: row.values.name,
          outcome: "failed", reasons: [`Database rejected the row: ${err.message}`],
        });
      }
    }

    // ---- 2. best-effort images: never let one failure fail its product ----
    const overflow = imageJobs.slice(MAX_IMAGE_FETCHES);
    for (const job of overflow) {
      job.result.needsImage = true;
      job.result.reasons.push(`Image not fetched — this import hit the ${MAX_IMAGE_FETCHES} image limit`);
    }

    await inBatches(imageJobs.slice(0, MAX_IMAGE_FETCHES), IMAGE_CONCURRENCY, async (job) => {
      try {
        const asset = await fetchImageToCloudinary(job.url, job.productId);
        try {
          await store.addProductImage(job.productId, asset.url, job.result.name, asset.publicId);
          job.result.imageUrl = asset.url;
        } catch (dbErr) {
          await destroyImage(asset.publicId);
          throw dbErr;
        }
      } catch (err) {
        // The product is already in the catalog — just flag the missing image.
        job.result.needsImage = true;
        job.result.reasons.push(`Needs an image — ${err.message}`);
      }
    });

    const summary = {
      imported: results.filter(r => r.outcome === "imported").length,
      skippedDuplicates: results.filter(r => r.outcome === "skipped").length,
      failed: results.filter(r => r.outcome === "failed").length,
      needsImage: results.filter(r => r.needsImage).length,
      emptyRowsSkipped: normalized.filter(r => r.status === "empty").length,
    };
    res.json({ summary, results });
  } catch (err) { next(err); }
});

export default router;
