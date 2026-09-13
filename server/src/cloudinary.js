// ---- Cloudinary image storage ----
// Product and banner images live in Cloudinary rather than on the server's disk,
// so they survive redeploys on hosts with an ephemeral filesystem (Railway,
// Render, Fly…). The database only ever stores the returned HTTPS URL plus the
// public_id needed to delete the asset again.
//
// The SDK is configured once, here, from environment variables:
//   CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
// Nothing else in the app touches cloudinary.config().
import 'dotenv/config';
import { v2 as cloudinary } from "cloudinary";

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "";
const API_KEY = process.env.CLOUDINARY_API_KEY || "";
const API_SECRET = process.env.CLOUDINARY_API_SECRET || "";

// Root folder for everything this app uploads, so assets are easy to find and
// clean up in the Cloudinary media library.
const ROOT_FOLDER = process.env.CLOUDINARY_FOLDER || "sinar-elektronik";

export const FOLDERS = {
  products: `${ROOT_FOLDER}/products`,
  banners: `${ROOT_FOLDER}/banners`,
  // Evidence photos attached to warranty claims / return requests.
  aftersales: `${ROOT_FOLDER}/aftersales`,
  // Custom icons/photos for the homepage category tiles.
  categories: `${ROOT_FOLDER}/categories`,
};

// Uploads are only possible when all three credentials are present. When they
// aren't (typical local dev), the app still boots and serves everything else —
// upload routes just report that storage isn't configured.
export const isConfigured = Boolean(CLOUD_NAME && API_KEY && API_SECRET);

if (isConfigured) {
  cloudinary.config({
    cloud_name: CLOUD_NAME,
    api_key: API_KEY,
    api_secret: API_SECRET,
    secure: true,          // always hand back https:// URLs
  });
  console.log(`✓ Cloudinary configured (cloud: ${CLOUD_NAME}, folder: ${ROOT_FOLDER})`);
} else {
  console.warn(
    "⚠ Cloudinary is not configured — image uploads will be rejected. " +
    "Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET."
  );
}

// Thrown when an upload/delete is attempted without credentials. Routes turn
// this into a 503 rather than a generic 500.
export class CloudinaryNotConfiguredError extends Error {
  constructor() {
    super("Image storage is not configured. Set the CLOUDINARY_* environment variables.");
    this.name = "CloudinaryNotConfiguredError";
    this.statusCode = 503;
  }
}

// Thrown when Cloudinary rejects or drops an upload. Surfaced as 502 (a failure
// in an upstream service) so admins get a useful message instead of a bare 500.
export class CloudinaryUploadError extends Error {
  constructor(detail) {
    super(`Image upload failed: ${detail || "Cloudinary did not accept the file."}`);
    this.name = "CloudinaryUploadError";
    this.statusCode = 502;
  }
}

function assertConfigured() {
  if (!isConfigured) throw new CloudinaryNotConfiguredError();
}

/**
 * Upload an in-memory image buffer to Cloudinary.
 *
 * @param {Buffer} buffer   the file contents (multer memoryStorage gives us this)
 * @param {object} options
 * @param {string} options.folder    target folder, e.g. FOLDERS.products
 * @param {string} [options.publicId] optional explicit public_id (no extension)
 * @returns {Promise<{url: string, publicId: string, format: string, width: number, height: number, bytes: number}>}
 */
export function uploadBuffer(buffer, { folder, publicId } = {}) {
  assertConfigured();
  if (!buffer || !buffer.length) return Promise.reject(new Error("Empty image buffer."));

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id: publicId,
        resource_type: "image",   // never accept video/raw through this path
        overwrite: false,
      },
      (error, result) => {
        if (error) return reject(new CloudinaryUploadError(error.message));
        if (!result || !result.secure_url) return reject(new CloudinaryUploadError("no URL returned"));
        resolve({
          url: result.secure_url,       // stored in the DB (product_images.url / banners.image_url)
          publicId: result.public_id,   // stored so the asset can be deleted later
          format: result.format,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
        });
      }
    );
    // upload_stream returns a writable stream — hand it the buffer and close it.
    stream.end(buffer);
  });
}

/**
 * Delete an asset by public_id. Best effort: a failure here is logged but never
 * fails the request, because the DB row is already gone by the time we call it
 * (an orphaned Cloudinary asset is much less harmful than a 500 on delete).
 *
 * @param {string|null} publicId
 * @returns {Promise<boolean>} true when Cloudinary reported the asset removed
 */
export async function destroyImage(publicId) {
  if (!publicId) return false;
  if (!isConfigured) {
    console.warn(`⚠ Cannot delete Cloudinary asset "${publicId}" — storage is not configured.`);
    return false;
  }
  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
    // "not found" means it's already gone, which is fine for our purposes.
    if (result.result !== "ok" && result.result !== "not found") {
      console.warn(`⚠ Cloudinary delete for "${publicId}" returned: ${result.result}`);
      return false;
    }
    return result.result === "ok";
  } catch (err) {
    console.warn(`⚠ Cloudinary delete for "${publicId}" failed: ${err.message}`);
    return false;
  }
}

export { cloudinary };
export default cloudinary;
