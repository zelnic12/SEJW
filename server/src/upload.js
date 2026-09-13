// ---- Image upload middleware (multer, in memory) ----
// Shared by the product-image and banner upload routes so both enforce exactly
// the same rules. Files are kept in memory as a Buffer and streamed straight to
// Cloudinary — nothing is ever written to the server's disk.
import multer from "multer";
import crypto from "node:crypto";

// Accepted image types. The key is the declared mime type; the value is the
// canonical extension (used only for readable Cloudinary public_ids).
export const ALLOWED_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const MAX_BYTES = 5 * 1024 * 1024;   // 5 MB per file

const storage = multer.memoryStorage();

// One multer instance, reused by both routes.
export const imageUpload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 10 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES[file.mimetype]) cb(null, true);
    else cb(new Error("Unsupported file type. Allowed: JPG, PNG, WebP."));
  },
});

// ---- Spreadsheet uploads (bulk product import) ----
// Also memory-only: the file is parsed in-process and never persisted.
export const SPREADSHEET_EXTENSIONS = [".xlsx", ".xls", ".csv"];
export const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;   // 10 MB

// Browsers are wildly inconsistent about spreadsheet mime types (Excel files
// often arrive as application/octet-stream, CSVs as text/plain), so the
// extension is the gate and the mime type is only a sanity check.
const SPREADSHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/octet-stream",
  "text/csv", "application/csv", "text/plain", "text/x-csv", "application/x-csv",
  "", undefined,
]);

export const spreadsheetUpload = multer({
  storage,
  limits: { fileSize: MAX_SPREADSHEET_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = (file.originalname || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
    if (!SPREADSHEET_EXTENSIONS.includes(ext)) {
      return cb(new Error(`Unsupported file type “${ext || file.originalname}”. Upload an .xlsx, .xls or .csv file.`));
    }
    if (!SPREADSHEET_MIMES.has(file.mimetype)) {
      return cb(new Error(`Unexpected file content type “${file.mimetype}”. Upload an .xlsx, .xls or .csv file.`));
    }
    cb(null, true);
  },
});

// Run a multer middleware as a promise so routes can use async/await.
// Rejects with multer's error, which uploadErrorMessage() turns into copy.
export function runUpload(middleware, req, res) {
  return new Promise((resolve, reject) => {
    middleware(req, res, err => (err ? reject(err) : resolve()));
  });
}

// A user-facing message for any multer/validation failure (always a 400).
export function uploadErrorMessage(err) {
  if (!err) return "Upload failed.";
  if (err.code === "LIMIT_FILE_SIZE") return `File too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB).`;
  if (err.code === "LIMIT_FILE_COUNT") return "Too many files in one request.";
  if (err.code === "LIMIT_UNEXPECTED_FILE") return `Unexpected file field "${err.field}".`;
  return err.message || "Upload failed.";
}

// Magic-byte sniffing. A client controls the Content-Type header, so the mime
// type alone isn't proof: check the actual bytes before spending an API call.
function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * Validate a parsed file before it reaches Cloudinary.
 * @returns {string|null} an error message, or null when the file is acceptable.
 */
export function validateImageFile(file) {
  if (!file || !file.buffer || file.buffer.length === 0) return "The uploaded file is empty.";
  if (file.size > MAX_BYTES) return `File too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB).`;
  if (!ALLOWED_TYPES[file.mimetype]) return "Unsupported file type. Allowed: JPG, PNG, WebP.";
  const sniffed = sniffImageType(file.buffer);
  if (!sniffed) return "That file doesn't look like a JPG, PNG or WebP image.";
  if (sniffed !== file.mimetype) {
    return `File contents (${sniffed}) don't match the declared type (${file.mimetype}).`;
  }
  return null;
}

// A readable, collision-free public_id (no extension — Cloudinary adds one).
export function assetId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}
