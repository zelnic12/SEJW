// ---- One-off backfill: local /uploads images → Cloudinary ----
// Finds every product image and banner whose URL still points at the local
// uploads folder, uploads the file to Cloudinary, and rewrites the row to the
// returned HTTPS URL + public_id.
//
//   node src/db/migrate-images-to-cloudinary.js --dry-run   # report only
//   node src/db/migrate-images-to-cloudinary.js             # actually migrate
//   npm run migrate:images
//
// Safe to re-run: rows already on Cloudinary (or using the "emoji:<char>"
// placeholder scheme) are skipped, and the local files are left on disk so the
// legacy /uploads route keeps serving anything that failed.
import 'dotenv/config';
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pool } from "./pool.js";
import { uploadBuffer, destroyImage, isConfigured, FOLDERS } from "../cloudinary.js";
import { validateImageFile, assetId } from "../upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_ROOT = path.join(__dirname, "..", "..", "uploads");
const LOCAL_PREFIX = "/uploads/";

// Map a stored URL back to a file on disk, refusing anything outside uploads/.
function localPathFor(url) {
  const relative = url.slice(LOCAL_PREFIX.length);
  const file = path.resolve(UPLOADS_ROOT, relative);
  if (file !== UPLOADS_ROOT && !file.startsWith(UPLOADS_ROOT + path.sep)) return null;
  return file;
}

// Guess a mime type from the extension so the shared validator can run.
const MIME_BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

async function readLocalImage(url) {
  const file = localPathFor(url);
  if (!file) return { error: "path outside the uploads folder" };
  let buffer;
  try {
    buffer = await fs.readFile(file);
  } catch (err) {
    return { error: err.code === "ENOENT" ? "file no longer on disk" : err.message };
  }
  const mimetype = MIME_BY_EXT[path.extname(file).toLowerCase()];
  if (!mimetype) return { error: `unsupported extension "${path.extname(file)}"` };
  const problem = validateImageFile({ buffer, size: buffer.length, mimetype });
  if (problem) return { error: problem };
  return { buffer, mimetype };
}

// One table's worth of work: rows with a local URL, uploaded then rewritten.
async function migrateTable({ table, urlColumn, idPrefix, folder, dryRun }) {
  const { rows } = await pool.query(
    `SELECT id, ${urlColumn} AS url FROM ${table}
      WHERE ${urlColumn} LIKE $1 AND cloudinary_public_id IS NULL
      ORDER BY id`,
    [`${LOCAL_PREFIX}%`]
  );
  const stats = { total: rows.length, migrated: 0, skipped: 0 };
  if (rows.length === 0) {
    console.log(`  ${table}: nothing to migrate`);
    return stats;
  }

  for (const row of rows) {
    const label = `${table}#${row.id} ${row.url}`;
    const file = await readLocalImage(row.url);
    if (file.error) {
      console.warn(`  ⚠ skipped ${label} — ${file.error}`);
      stats.skipped++;
      continue;
    }
    if (dryRun) {
      console.log(`  would migrate ${label} (${file.buffer.length} bytes)`);
      stats.migrated++;
      continue;
    }
    let asset;
    try {
      asset = await uploadBuffer(file.buffer, { folder, publicId: assetId(`${idPrefix}${row.id}`) });
    } catch (err) {
      console.warn(`  ⚠ skipped ${label} — upload failed: ${err.message}`);
      stats.skipped++;
      continue;
    }
    try {
      await pool.query(
        `UPDATE ${table} SET ${urlColumn} = $1, cloudinary_public_id = $2 WHERE id = $3`,
        [asset.url, asset.publicId, row.id]
      );
      console.log(`  ✓ ${label} → ${asset.url}`);
      stats.migrated++;
    } catch (err) {
      // Don't leave an asset behind that no row points at.
      await destroyImage(asset.publicId);
      console.warn(`  ⚠ skipped ${label} — DB update failed: ${err.message}`);
      stats.skipped++;
    }
  }
  return stats;
}

export async function migrateImages({ dryRun = false } = {}) {
  if (!isConfigured && !dryRun) {
    throw new Error(
      "Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY " +
      "and CLOUDINARY_API_SECRET before running this migration."
    );
  }
  console.log(dryRun ? "Dry run — no uploads, no DB writes." : "Migrating local images to Cloudinary…");

  const results = [
    await migrateTable({ table: "product_images", urlColumn: "url", idPrefix: "p", folder: FOLDERS.products, dryRun }),
    await migrateTable({ table: "banners", urlColumn: "image_url", idPrefix: "banner", folder: FOLDERS.banners, dryRun }),
  ];

  const total = results.reduce((s, r) => s + r.total, 0);
  const migrated = results.reduce((s, r) => s + r.migrated, 0);
  const skipped = results.reduce((s, r) => s + r.skipped, 0);
  console.log(`\nDone: ${migrated}/${total} ${dryRun ? "would be migrated" : "migrated"}, ${skipped} skipped.`);
  if (!dryRun && migrated > 0) {
    console.log(
      "Local files were left in server/uploads. Once you've confirmed the new URLs " +
      "render, you can delete that folder and the /uploads route in src/index.js."
    );
  }
  return { total, migrated, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateImages({ dryRun: process.argv.includes("--dry-run") })
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(err => {
      console.error("Image migration failed:", err.message);
      process.exit(1);
    });
}
