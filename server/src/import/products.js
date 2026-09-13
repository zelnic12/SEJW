// ---- Bulk product import: spreadsheet parsing + row normalisation ----
// Pure logic, no DB and no HTTP: the routes orchestrate, this module decides what
// a spreadsheet row *means*. Preview and commit both run through normalizeRows()
// so what the admin approves is exactly what gets inserted.
//
// exceljs (not xlsx/SheetJS) reads the file: the newest `xlsx` on npm carries a
// high-severity prototype-pollution advisory in its parse path, which is the one
// path that handles untrusted uploads here.
import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import path from "node:path";

// A single import is capped so a stray 100k-row export can't tie up the server.
export const MAX_ROWS = 5000;
export const PREVIEW_ROWS = 20;

// The product fields an admin can map a column onto. `required` is about the
// mapping itself: a name and a price are the minimum needed to create a product.
export const IMPORT_FIELDS = [
  {
    key: "name", label: "Product name", required: true,
    hint: "Used to detect duplicates",
    aliases: ["name", "product name", "product", "item name", "title", "nama", "nama produk",
      "nama barang", "produk", "judul", "product_name", "nama_produk"],
  },
  {
    key: "category", label: "Category", required: false,
    hint: "Defaults to “Uncategorized”",
    aliases: ["category", "categories", "product category", "kategori", "kategori produk",
      "jenis", "tipe produk", "category name", "product_category"],
  },
  {
    key: "brand", label: "Brand", required: false,
    aliases: ["brand", "brand name", "merek", "merk", "manufacturer", "produsen", "brand_name"],
  },
  {
    key: "price", label: "Price", required: true,
    hint: "“Rp 285.000” and “1.250.500,00” are cleaned automatically",
    aliases: ["price", "harga", "harga jual", "sale price", "selling price", "unit price",
      "harga satuan", "price idr", "harga produk", "product_price"],
  },
  {
    key: "stock", label: "Stock", required: false,
    hint: "Defaults to 0",
    aliases: ["stock", "stok", "quantity", "qty", "jumlah", "inventory", "kuantitas",
      "stock quantity", "jumlah stok", "product_stock"],
  },
  {
    key: "description", label: "Description", required: false,
    aliases: ["description", "deskripsi", "detail", "details", "keterangan",
      "product description", "deskripsi produk", "product_description"],
  },
  {
    key: "imageUrl", label: "Image URL", required: false,
    hint: "Fetched and uploaded to Cloudinary when present",
    aliases: ["image", "image url", "image link", "photo", "picture", "gambar", "foto",
      "link gambar", "url gambar", "image_url", "images", "main image", "gambar utama"],
  },
];

const FIELD_KEYS = IMPORT_FIELDS.map(f => f.key);

// ---------------------------------------------------------------------------
// Cell + value helpers
// ---------------------------------------------------------------------------

// exceljs cells aren't always primitives: rich text, hyperlinks, formulas and
// dates all show up. Flatten anything to a plain string.
export function cellToString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map(t => t.text || "").join("").trim();
    if (value.text !== undefined) return cellToString(value.text);        // hyperlink cell
    if (value.result !== undefined) return cellToString(value.result);    // formula cell
    if (value.hyperlink !== undefined) return String(value.hyperlink).trim();
    if (value.error !== undefined) return "";                             // #REF! etc.
  }
  return String(value).trim();
}

/**
 * Parse a number out of messy spreadsheet text.
 *
 * Handles "Rp 285.000" (dot thousands), "1.250.500,00" (dot thousands + comma
 * decimals), "1,299.00" (US style), "3 pcs" and plain numbers. The rule for a
 * lone separator: a trailing group of exactly 3 digits is a thousands separator,
 * anything else is a decimal point — so "285.000" is 285000 while "12.5" is 12.5.
 * Genuinely ambiguous cases are why the preview shows the raw value next to the
 * parsed one.
 *
 * @returns {number|null} null when there's no number in there at all.
 */
export function parseMessyNumber(input) {
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  let text = cellToString(input);
  if (!text) return null;

  const negative = /^\s*[-(]/.test(text);
  // Drop currency words/symbols and anything else that isn't part of a number.
  text = text.replace(/[^\d.,-]/g, "");
  text = text.replace(/(?!^)-/g, "");          // keep only a leading minus
  if (!/\d/.test(text)) return null;

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");

  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: whichever comes last is the decimal separator.
    const decimalSep = lastComma > lastDot ? "," : ".";
    const thousandsSep = decimalSep === "," ? "." : ",";
    text = text.split(thousandsSep).join("");
    text = text.replace(decimalSep, ".");
  } else if (lastComma !== -1 || lastDot !== -1) {
    const sep = lastComma !== -1 ? "," : ".";
    const parts = text.split(sep);
    const tail = parts[parts.length - 1];
    // Several separators, or a trailing group of exactly 3 digits → thousands.
    if (parts.length > 2 || (tail.length === 3 && parts[0].length > 0)) {
      text = parts.join("");
    } else {
      text = `${parts.slice(0, -1).join("")}.${tail}`;
    }
  }

  const value = Number(text.replace(/^-/, ""));
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

// A URL we're willing to fetch an image from.
export function normalizeImageUrl(input) {
  const text = cellToString(input);
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.href;
  } catch {
    return null;
  }
}

const normalizeHeader = h => cellToString(h).toLowerCase().replace(/[\s_\-./]+/g, " ").trim();

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Read an uploaded .xlsx/.xls/.csv buffer into { headers, rows }.
// The first non-empty row is treated as the header row.
export async function parseSpreadsheet(buffer, filename = "") {
  const ext = path.extname(String(filename)).toLowerCase();
  const workbook = new ExcelJS.Workbook();
  let sheet;

  if (ext === ".csv") {
    sheet = await workbook.csv.read(Readable.from(buffer));
  } else {
    await workbook.xlsx.load(buffer);
    // Shopee exports sometimes carry template/instruction sheets — take the
    // first sheet that actually has rows.
    sheet = workbook.worksheets.find(ws => ws.rowCount > 0) || workbook.worksheets[0];
  }
  if (!sheet) throw new Error("That file doesn't contain any readable sheets.");

  const table = [];
  sheet.eachRow({ includeEmpty: true }, row => {
    // row.values is 1-based; index 0 is always empty.
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    table.push(values.map(cellToString));
  });

  // Find the header row: the first row with at least two non-empty cells.
  const headerIndex = table.findIndex(r => r.filter(Boolean).length >= 2);
  if (headerIndex === -1) throw new Error("Couldn't find a header row with column names in that file.");

  const rawHeaders = table[headerIndex];
  const width = Math.max(rawHeaders.length, ...table.map(r => r.length), 0);
  const headers = Array.from({ length: width }, (_, i) => rawHeaders[i] || `Column ${i + 1}`);

  const body = table.slice(headerIndex + 1);
  const truncated = body.length > MAX_ROWS;
  const rows = body.slice(0, MAX_ROWS)
    // Pad short rows so every row lines up with the headers.
    .map(r => Array.from({ length: width }, (_, i) => r[i] ?? ""));

  return {
    sheetName: sheet.name,
    headers,
    rows,
    totalRows: rows.length,
    truncated,
    // Spreadsheet row number of the first data row, so preview/report row
    // numbers match what the admin sees in Excel.
    firstDataRow: headerIndex + 2,
  };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

// Best-effort guesses so the admin usually just confirms. Exact alias match
// first, then "header contains alias", never guessing the same column twice.
export function suggestMapping(headers) {
  const normalized = headers.map(normalizeHeader);
  const mapping = {};
  const taken = new Set();

  for (const pass of ["exact", "partial"]) {
    for (const field of IMPORT_FIELDS) {
      if (mapping[field.key] !== undefined && mapping[field.key] !== null) continue;
      const index = normalized.findIndex((header, i) => {
        if (!header || taken.has(i)) return false;
        return pass === "exact"
          ? field.aliases.includes(header)
          : field.aliases.some(a => header.includes(a) || a.includes(header));
      });
      if (index !== -1) {
        mapping[field.key] = index;
        taken.add(index);
      }
    }
  }
  for (const field of IMPORT_FIELDS) {
    if (mapping[field.key] === undefined) mapping[field.key] = null;
  }
  return mapping;
}

// Reject nonsense before it reaches the normaliser.
export function validateMapping(mapping, headerCount) {
  const errors = [];
  if (!mapping || typeof mapping !== "object") return ["mapping must be an object"];
  for (const field of IMPORT_FIELDS) {
    const value = mapping[field.key];
    if (value === null || value === undefined || value === "") {
      if (field.required) errors.push(`${field.label} must be mapped to a column`);
      continue;
    }
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index >= headerCount) {
      errors.push(`${field.label} is mapped to a column that doesn't exist`);
    }
  }
  for (const key of Object.keys(mapping)) {
    if (!FIELD_KEYS.includes(key)) errors.push(`Unknown field "${key}" in mapping`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Row normalisation
// ---------------------------------------------------------------------------

const at = (row, index) => (index === null || index === undefined || index === "" ? "" : cellToString(row[Number(index)]));

/**
 * Turn raw rows into import candidates.
 *
 * Every row comes back with a status so nothing fails silently:
 *   ready     → will be inserted
 *   duplicate → a product with that name already exists (or repeats in the file)
 *   error     → can't be imported (reasons in `errors`)
 *   empty     → blank row or a repeated header row, skipped quietly
 *
 * @param {string[][]} rows
 * @param {object} mapping field key → column index
 * @param {object} options
 * @param {Set<string>} options.existingNames lower-cased product names already in the DB
 * @param {string[]} options.headers used to spot repeated header rows
 * @param {number} options.firstDataRow spreadsheet row number of rows[0]
 */
export function normalizeRows(rows, mapping, { existingNames = new Set(), headers = [], firstDataRow = 2 } = {}) {
  const headerSignature = headers.map(normalizeHeader).filter(Boolean).join("|");
  const seenNames = new Map();   // lower name → row number, for in-file duplicates
  const out = [];

  rows.forEach((row, i) => {
    const rowNumber = firstDataRow + i;
    const errors = [];
    const warnings = [];

    // A row is empty if every cell is blank — exceljs gives both [] and [""…].
    if (!row || row.every(cell => cellToString(cell) === "")) {
      out.push({ rowNumber, status: "empty", raw: {}, values: null, errors, warnings });
      return;
    }

    // Exports (and copy-paste) often repeat the header row mid-file.
    const signature = row.map(normalizeHeader).filter(Boolean).join("|");
    if (headerSignature && signature === headerSignature) {
      out.push({
        rowNumber, status: "empty", raw: {}, values: null, errors,
        warnings: ["Looks like a repeated header row — skipped"],
      });
      return;
    }

    const raw = {
      name: at(row, mapping.name),
      category: at(row, mapping.category),
      brand: at(row, mapping.brand),
      price: at(row, mapping.price),
      stock: at(row, mapping.stock),
      description: at(row, mapping.description),
      imageUrl: at(row, mapping.imageUrl),
    };

    // ---- name (also the duplicate key) ----
    const name = raw.name;
    if (!name) errors.push("Missing product name");
    else if (name.length < 2) errors.push(`Product name “${name}” is too short (minimum 2 characters)`);

    // ---- price ----
    let price = null;
    if (!raw.price) {
      errors.push("Missing price");
    } else {
      price = parseMessyNumber(raw.price);
      if (price === null) errors.push(`Couldn't read a price from “${raw.price}”`);
      else if (price < 0) errors.push(`Price can't be negative (“${raw.price}”)`);
    }

    // ---- stock (optional, defaults to 0) ----
    let stock = 0;
    if (raw.stock) {
      const parsed = parseMessyNumber(raw.stock);
      if (parsed === null) warnings.push(`Couldn't read stock from “${raw.stock}” — importing as 0`);
      else if (parsed < 0) warnings.push(`Negative stock “${raw.stock}” — importing as 0`);
      else {
        stock = Math.trunc(parsed);
        if (stock !== parsed) warnings.push(`Stock “${raw.stock}” rounded down to ${stock}`);
      }
    } else if (mapping.stock !== null && mapping.stock !== undefined && mapping.stock !== "") {
      warnings.push("No stock value — importing as 0");
    }

    // ---- category / brand / description ----
    let category = raw.category;
    if (!category) {
      category = "Uncategorized";
      if (mapping.category !== null && mapping.category !== undefined && mapping.category !== "") {
        warnings.push("No category — importing as “Uncategorized”");
      }
    }

    // ---- image ----
    let imageUrl = null;
    if (raw.imageUrl) {
      imageUrl = normalizeImageUrl(raw.imageUrl);
      if (!imageUrl) warnings.push(`“${raw.imageUrl}” isn't a valid http(s) image URL — importing without an image`);
    }

    const values = {
      name, category, brand: raw.brand, price, stock,
      description: raw.description, imageUrl,
    };

    if (errors.length) {
      out.push({ rowNumber, status: "error", raw, values, errors, warnings });
      return;
    }

    // ---- duplicates: against the catalog, then within the file ----
    const key = name.toLowerCase();
    if (existingNames.has(key)) {
      out.push({
        rowNumber, status: "duplicate", raw, values, errors,
        warnings: [...warnings, "A product with this name already exists — skipped"],
      });
      return;
    }
    if (seenNames.has(key)) {
      out.push({
        rowNumber, status: "duplicate", raw, values, errors,
        warnings: [...warnings, `Same name as row ${seenNames.get(key)} in this file — skipped`],
      });
      return;
    }
    seenNames.set(key, rowNumber);
    out.push({ rowNumber, status: "ready", raw, values, errors, warnings });
  });

  return out;
}

// Counts for the preview/results headline.
export function summarize(normalized) {
  const summary = { total: normalized.length, ready: 0, duplicates: 0, errors: 0, empty: 0, warnings: 0 };
  for (const row of normalized) {
    if (row.status === "ready") summary.ready++;
    else if (row.status === "duplicate") summary.duplicates++;
    else if (row.status === "error") summary.errors++;
    else summary.empty++;
    if (row.warnings.length) summary.warnings++;
  }
  return summary;
}
