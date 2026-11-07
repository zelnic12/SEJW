// ---- Bookkeeping router: /api/admin/finance (admin only) ----
//
//   GET    /products                 products with stock + average cost (modal)
//   GET    /receipts?month=YYYY-MM   barang masuk         POST /receipts   DELETE /receipts/:id
//   GET    /receipts/last/:productId last purchase (prefills the form)
//   GET    /receipts/template        Excel template listing every product
//   POST   /receipts/parse           multipart Excel → rows matched to products (preview)
//   POST   /receipts/bulk            { rows } → save many receipts at once
//   GET    /suppliers                recent supplier names
//   GET    /expenses?month=          pengeluaran          POST /expenses   DELETE /expenses/:id
//   GET    /expense-categories
//   GET    /sales?month=&channel=    toko + Shopee sales  POST /sales (toko) DELETE /sales/:id
//   POST   /shopee/parse             multipart Shopee export → orders + listing suggestions
//   POST   /shopee/commit            { orders, links, feePercent } → import report
//   POST   /shopee/income            multipart income report (Penghasilan Saya) → real fees
//   GET    /shopee/fee-stats         average real Shopee fee %, for the next estimate
//   POST   /shopee/income/parse      multipart income report → orders to review (no order export needed)
//   POST   /shopee/income/commit     { orders, links, payouts } → import with real fees
//   GET    /report?month=            monthly profit & loss across website, toko and Shopee
//   GET    /install-rates            AC installation rates   PUT /install-rates
import { Router } from "express";
import * as fin from "../finance/store.js";
import { normalizeShopeeRows, suggestProduct, sanitizeOrders, listingKey } from "../finance/shopee.js";
import { cleanInstall, cleanRates, detectInstall, installCost } from "../finance/install.js";
import { proposeNewProduct, guessBrand, guessCategory } from "../finance/new-product.js";
import { parseSpreadsheet, cellToString } from "../import/products.js";
import { parseIncomeTable, incomeOrders, inferQty } from "../finance/shopee-income.js";
import { TEMPLATE_COLUMNS, normalizeReceiptRows, MAX_RECEIPT_ROWS } from "../finance/receipts-import.js";
import ExcelJS from "exceljs";
import { spreadsheetUpload, runUpload, uploadErrorMessage } from "../upload.js";

const router = Router();

// ---- helpers ----
const wrap = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (err) {
    if (err.status === 400 || err.expose) {
      return res.status(400).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    next(err);
  }
};

const thisMonth = () =>
  new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" }).slice(0, 7);
const todayJakarta = () =>
  new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Jakarta" });

const monthOf = req => fin.parseMonth(req.query.month || thisMonth());

function date(v, label) {
  const s = String(v || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw fin.badRequest(`${label} tidak valid.`);
  if (s > todayJakarta()) throw fin.badRequest(`${label} tidak boleh di masa depan.`);
  return s;
}
function int(v, label, { min = 1, max = 1_000_000 } = {}) {
  const x = Number(v);
  if (!Number.isInteger(x) || x < min || x > max) throw fin.badRequest(`${label} harus bilangan bulat ${min}–${max.toLocaleString("id-ID")}.`);
  return x;
}
function rupiah(v, label, { min = 0, max = 10_000_000_000 } = {}) {
  const x = Number(v);
  if (!Number.isFinite(x) || x < min || x > max) throw fin.badRequest(`${label} tidak valid.`);
  return Math.round(x);
}
const text = (v, max = 300) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const idParam = req => int(req.params.id, "ID", { max: 2_147_483_647 });
function install(type, meters, label) {
  try { return cleanInstall(type, meters); }
  catch (msg) { throw fin.badRequest(label ? `${label}: ${msg}` : msg); }
}

// ---- AC installation rates ----
router.get("/install-rates", wrap(async (req, res) => res.json(await fin.getInstallRates())));
router.put("/install-rates", wrap(async (req, res) => {
  let rates;
  try { rates = cleanRates(req.body); } catch (msg) { throw fin.badRequest(msg); }
  res.json(await fin.saveInstallRates(rates));
}));

// ---- products ----
router.get("/products", wrap(async (req, res) => res.json(await fin.listCostedProducts())));

// Brand and category guessed for a product about to be added from Barang masuk.
router.get("/new-product-proposal", wrap(async (req, res) => {
  const name = text(req.query.name, 300);
  const products = await fin.listCostedProducts();
  const brands = [...new Set(products.map(p => p.brand).filter(Boolean))];
  const categories = [...new Set(products.map(p => p.category).filter(Boolean))].sort();
  res.json({ name, brand: guessBrand(name, brands), category: guessCategory(name, categories, products), categories });
}));

/** { name, brand, category, price } for a product created from a form, or a 400. */
function newProductInput(np, label = "Produk baru") {
  const name = text(np?.name, 300);
  if (name.length < 2) throw fin.badRequest(`${label}: nama minimal 2 huruf.`);
  return {
    name,
    brand: text(np?.brand, 60),
    category: text(np?.category, 60) || "Lainnya",
    price: rupiah(np?.price ?? 0, `${label}: harga jual`, { max: 99_999_999 }),
  };
}

/** productId, or newProduct when the row asks to add one. */
function productRef(r, label) {
  return r?.newProduct && (r.productId == null || r.productId === "")
    ? { productId: null, newProduct: newProductInput(r.newProduct, label) }
    : { productId: int(r?.productId, `${label}: produk`, { max: 2_147_483_647 }) };
}

// ---- barang masuk ----
router.get("/receipts", wrap(async (req, res) => res.json(await fin.listReceipts(monthOf(req)))));
router.get("/receipts/last/:id", wrap(async (req, res) => res.json(await fin.lastReceiptFor(idParam(req)))));
router.get("/suppliers", wrap(async (req, res) => res.json(await fin.listSuppliers())));

router.post("/receipts", wrap(async (req, res) => {
  const b = req.body || {};
  const result = await fin.createReceipt({
    receivedOn: date(b.receivedOn, "Tanggal"),
    ...productRef(b, "Produk baru"),
    quantity: int(b.quantity, "Jumlah"),
    unitCost: rupiah(b.unitCost, "Harga beli"),
    supplier: text(b.supplier, 120),
    note: text(b.note, 300),
  });
  res.status(201).json(result);
}));

// ---- barang masuk from Excel ----
router.get("/receipts/template", wrap(async (req, res) => {
  const products = await fin.listCostedProducts();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Barang masuk", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = TEMPLATE_COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.width }));
  for (const p of products) ws.addRow({ productId: p.id, product: p.shortName, stock: p.stock });
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F1F1" } };
  ws.getColumn("date").numFmt = "dd/mm/yyyy";
  ws.getColumn("cost").numFmt = "#,##0";
  for (const key of ["productId", "product", "stock"]) ws.getColumn(key).font = { color: { argb: "FF6B7280" } };
  const help = wb.addWorksheet("Petunjuk");
  help.getColumn(1).width = 100;
  [
    "Cara mengisi:",
    "1. Isi kolom Jumlah dan Harga beli / unit hanya untuk barang yang datang. Baris dengan Jumlah kosong dilewati.",
    "2. Tanggal boleh dikosongkan; tanggal yang dipilih saat import akan dipakai. Format: 07/11/2026.",
    "3. Jangan ubah kolom ID produk. Produk baru bisa ditulis di kolom Produk dengan merek + tipe, mis. TCL TAC-05CSD/XSS.",
    "4. Satu produk boleh muncul di beberapa baris (mis. dari supplier berbeda).",
    "5. Simpan sebagai .xlsx lalu upload di Pembukuan → Barang masuk → Import Excel.",
  ].forEach(t => help.addRow([t]));
  help.getRow(1).font = { bold: true };
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="template-barang-masuk.xlsx"');
  res.end(Buffer.from(await wb.xlsx.writeBuffer()));
}));

router.post("/receipts/parse", async (req, res, next) => {
  try {
    await runUpload(spreadsheetUpload.single("file"), req, res);
  } catch (err) {
    return res.status(400).json({ error: uploadErrorMessage(err) });
  }
  if (!req.file) return res.status(400).json({ error: "Pilih file Excel barang masuk (.xlsx)." });
  try {
    const products = await fin.listCostedProducts();
    let parsed;
    try {
      const sheet = await parseSpreadsheet(req.file.buffer, req.file.originalname);
      parsed = normalizeReceiptRows(sheet.headers, sheet.rows, products);
    } catch (err) {
      return res.status(400).json({ error: err.expose ? err.message : `File tidak bisa dibaca: ${err.message}` });
    }
    // A row whose product isn't on the website can add it: suggest brand and category.
    const brands = [...new Set(products.map(p => p.brand).filter(Boolean))];
    const categories = [...new Set(products.map(p => p.category).filter(Boolean))].sort();
    for (const r of parsed.rows) {
      if (r.productId == null && r.productText) {
        r.proposal = { name: r.productText, brand: guessBrand(r.productText, brands), category: guessCategory(r.productText, categories, products), price: null };
      }
    }
    res.json({ fileName: req.file.originalname, ...parsed, categories, today: todayJakarta() });
  } catch (err) { next(err); }
});

router.post("/receipts/bulk", wrap(async (req, res) => {
  const list = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!list.length) throw fin.badRequest("Tidak ada barang masuk untuk disimpan.");
  if (list.length > MAX_RECEIPT_ROWS) throw fin.badRequest(`Maksimal ${MAX_RECEIPT_ROWS} baris per import.`);
  const receipts = list.map((r, k) => {
    const label = `Baris ${r?.row ?? k + 1}`;
    return {
      receivedOn: date(r?.receivedOn, `${label}: tanggal`),
      ...productRef(r, label),
      quantity: int(r?.quantity, `${label}: jumlah`),
      unitCost: rupiah(r?.unitCost, `${label}: harga beli`),
      supplier: text(r?.supplier, 120),
      note: text(r?.note, 300),
    };
  });
  res.status(201).json(await fin.createReceipts(receipts));
}));

router.delete("/receipts/:id", wrap(async (req, res) => {
  const ok = await fin.deleteReceipt(idParam(req));
  ok ? res.status(204).end() : res.status(404).json({ error: "Data barang masuk tidak ditemukan." });
}));

// ---- pengeluaran ----
router.get("/expense-categories", (req, res) => res.json(fin.EXPENSE_CATEGORIES));
router.get("/expenses", wrap(async (req, res) => res.json(await fin.listExpenses(monthOf(req)))));

router.post("/expenses", wrap(async (req, res) => {
  const b = req.body || {};
  const category = text(b.category, 60);
  if (!category) throw fin.badRequest("Pilih jenis pengeluaran.");
  const id = await fin.createExpense({
    spentOn: date(b.spentOn, "Tanggal"),
    category,
    amount: rupiah(b.amount, "Jumlah", { min: 1 }),
    note: text(b.note, 300),
  });
  res.status(201).json({ id });
}));

router.delete("/expenses/:id", wrap(async (req, res) => {
  const ok = await fin.deleteExpense(idParam(req));
  ok ? res.status(204).end() : res.status(404).json({ error: "Pengeluaran tidak ditemukan." });
}));

// ---- penjualan toko / Shopee ----
router.get("/sales", wrap(async (req, res) => {
  const channel = ["toko", "shopee"].includes(req.query.channel) ? req.query.channel : "";
  res.json(await fin.listSales(monthOf(req), channel));
}));

router.post("/sales", wrap(async (req, res) => {
  const b = req.body || {};
  const day = date(b.soldOn, "Tanggal");
  // Today's sales keep the real time; back-dated ones sit at midday Jakarta time.
  const soldAt = day === todayJakarta() ? new Date().toISOString() : new Date(`${day}T12:00:00+07:00`).toISOString();
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 100) {
    throw fin.badRequest("Tambahkan minimal satu barang.");
  }
  const items = b.items.map((i, k) => {
    const inst = install(i?.installType, i?.installMeters, `Baris ${k + 1}`);
    return {
      productId: int(i?.productId, `Produk baris ${k + 1}`, { max: 2_147_483_647 }),
      quantity: int(i?.quantity, `Jumlah baris ${k + 1}`, { max: 100_000 }),
      unitPrice: rupiah(i?.unitPrice, `Harga baris ${k + 1}`),
      installType: inst.type,
      installMeters: inst.meters,
    };
  });
  const id = await fin.createStoreSale({
    soldAt, items,
    customer: text(b.customer, 120),
    note: text(b.note, 300),
    discount: rupiah(b.discount || 0, "Diskon"),
  });
  res.status(201).json({ id });
}));

// Fix the installation package of a recorded sale line.
router.put("/sales/:id/items/:itemId/install", wrap(async (req, res) => {
  const saleId = idParam(req);
  const itemId = int(req.params.itemId, "ID barang", { max: 2_147_483_647 });
  const inst = install(req.body?.installType, req.body?.installMeters);
  const cost = await fin.updateSaleItemInstall(saleId, itemId, inst);
  cost == null ? res.status(404).json({ error: "Barang penjualan tidak ditemukan." }) : res.json({ installCost: cost });
}));

router.delete("/sales/:id", wrap(async (req, res) => {
  const ok = await fin.deleteSale(idParam(req));
  ok ? res.status(204).end() : res.status(404).json({ error: "Penjualan tidak ditemukan." });
}));

// ---- Shopee import ----
router.post("/shopee/parse", async (req, res, next) => {
  try {
    await runUpload(spreadsheetUpload.single("file"), req, res);
  } catch (err) {
    return res.status(400).json({ error: uploadErrorMessage(err) });
  }
  if (!req.file) return res.status(400).json({ error: "Pilih file export pesanan Shopee (.xlsx)." });

  let parsed;
  try {
    const sheet = await parseSpreadsheet(req.file.buffer, req.file.originalname);
    parsed = normalizeShopeeRows(sheet.headers, sheet.rows);
  } catch (err) {
    return res.status(400).json({ error: err.expose ? err.message : `File tidak bisa dibaca: ${err.message}` });
  }

  try {
    const [products, links, existing, rates] = await Promise.all([
      fin.listCostedProducts(),
      fin.getShopeeLinks(),
      fin.existingShopeeRefs(parsed.orders.map(o => o.ref)),
      fin.getInstallRates(),
    ]);
    const brands = [...new Set(products.map(p => p.brand).filter(Boolean))];
    const categories = [...new Set(products.map(p => p.category).filter(Boolean))].sort();
    // Highest price each listing sold at, for a new product's price.
    const topPrice = new Map();
    for (const o of parsed.orders) for (const ln of o.lines) topPrice.set(ln.key, Math.max(topPrice.get(ln.key) || 0, ln.unitPrice));
    const listings = parsed.listings.map(l => {
      const saved = links.get(l.key);
      let out;
      if (saved && (saved.productId == null || products.some(p => p.id === saved.productId))) out = { ...l, ...saved, via: "tersimpan" };
      else {
        const s = suggestProduct(l, products);
        // "AC + PASANG +PIPA 5M" → installation package read from the variation
        const inst = detectInstall(l.variation || l.name);
        out = { ...l, productId: s ? s.productId : null, via: s ? s.via : null, installType: inst.type, installMeters: inst.meters };
      }
      // What "+ Produk baru" would create; the price leaves out any install package.
      const price = (topPrice.get(l.key) || 0) - installCost(out.installType, out.installMeters, rates);
      out.proposal = proposeNewProduct(l, { brands, categories, catalog: products, price });
      return out;
    });
    res.json({
      fileName: req.file.originalname,
      orders: parsed.orders.map(o => ({ ...o, alreadyImported: existing.has(o.ref) })),
      skipped: parsed.skipped,
      listings,
      rates,
      categories,
      products: products.map(p => ({ id: p.id, name: p.name, shortName: p.shortName, category: p.category, stock: p.stock, avgCost: p.avgCost })),
    });
  } catch (err) { next(err); }
});

// Listing links from a commit: [{ name, variation, productId|null, installType, installMeters, newProduct? }].
// Returns the Map the import uses and a save() for after the import (new products get ids then).
async function commitLinks(rawInput) {
  // links: [{ name, variation, productId|null, installType, installMeters }] — one per Shopee listing.
  const rawLinks = Array.isArray(rawInput) ? rawInput : [];
  const links = new Map();
  const toSave = [];
  const products = new Set((await fin.listCostedProducts()).map(p => p.id));
  for (const l of rawLinks) {
    const name = text(l?.name, 500), variation = text(l?.variation, 300);
    if (!name) continue;
    const pid = l.productId == null || l.productId === "" ? null : Number(l.productId);
    if (pid != null && !products.has(pid)) throw fin.badRequest(`Produk #${l.productId} tidak ditemukan.`);
    const inst = install(l.installType, l.installMeters, name.slice(0, 40));
    const link = { productId: pid, installType: inst.type, installMeters: inst.meters };
    if (pid == null && l.newProduct) {
      const np = l.newProduct;
      const npName = text(np.name, 300);
      if (npName.length < 2) throw fin.badRequest(`Nama produk baru untuk "${name.slice(0, 40)}" terlalu pendek.`);
      link.newProduct = {
        name: npName,
        brand: text(np.brand, 60),
        category: text(np.category, 60) || "Lainnya",
        price: rupiah(np.price, `Harga produk baru "${npName.slice(0, 40)}"`, { max: 99_999_999 }),
      };
    }
    links.set(listingKey(name, variation), link);
    // Saved after the import, once new products have ids (the store fills link.productId).
    toSave.push({ name: name.toLowerCase(), variation: variation.toLowerCase(), link });
  }

  return {
    map: links,
    save: () => fin.saveShopeeLinks(toSave.map(({ name, variation, link }) => ({
      name, variation, productId: link.productId, installType: link.installType, installMeters: link.installMeters,
    }))),
  };
}

router.post("/shopee/commit", wrap(async (req, res) => {
  const b = req.body || {};
  const orders = sanitizeOrders(b.orders);
  const feePercent = Number(b.feePercent ?? 0);
  if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 50) throw fin.badRequest("Persentase biaya Shopee harus 0–50%.");

  const { map: links, save } = await commitLinks(b.links);

  const result = await fin.importShopeeOrders({ orders, links, feePercent });
  await save();
  res.json(result);
}));

// ---- Shopee income report ----
// The report's first sheet is a summary; the per-order table is the
// "Penghasilan" sheet, with its header a few rows down.
async function readIncomeTable(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets.find(w => /penghasilan|income/i.test(w.name))
    || wb.worksheets.find(w => w.rowCount > 0);
  if (!ws) throw Object.assign(new Error("File tidak berisi sheet yang bisa dibaca."), { expose: true });
  const table = [];
  ws.eachRow({ includeEmpty: true }, row => {
    table.push(Array.isArray(row.values) ? row.values.slice(1).map(cellToString) : []);
  });
  return table;
}

router.post("/shopee/income", async (req, res, next) => {
  try {
    await runUpload(spreadsheetUpload.single("file"), req, res);
  } catch (err) {
    return res.status(400).json({ error: uploadErrorMessage(err) });
  }
  if (!req.file) return res.status(400).json({ error: "Pilih file laporan penghasilan Shopee (.xlsx)." });
  let payouts;
  try {
    payouts = parseIncomeTable(await readIncomeTable(req.file.buffer));
  } catch (err) {
    return res.status(400).json({ error: err.expose ? err.message : `File tidak bisa dibaca: ${err.message}` });
  }
  if (!payouts.length) return res.status(400).json({ error: "Tidak ada pesanan di laporan penghasilan ini." });
  try {
    res.json({ fileName: req.file.originalname, ...(await fin.importShopeePayouts(payouts)) });
  } catch (err) { next(err); }
});

// The income report on its own: orders, products and real payouts in one file.
router.post("/shopee/income/parse", async (req, res, next) => {
  try {
    await runUpload(spreadsheetUpload.single("file"), req, res);
  } catch (err) {
    return res.status(400).json({ error: uploadErrorMessage(err) });
  }
  if (!req.file) return res.status(400).json({ error: "Pilih file laporan penghasilan Shopee (.xlsx)." });
  let parsed;
  try {
    parsed = incomeOrders(await readIncomeTable(req.file.buffer));
  } catch (err) {
    return res.status(400).json({ error: err.expose ? err.message : `File tidak bisa dibaca: ${err.message}` });
  }
  if (!parsed.orders.length) return res.status(400).json({ error: "Tidak ada pesanan di laporan penghasilan ini." });
  try {
    const [products, links, existing, rates] = await Promise.all([
      fin.listCostedProducts(), fin.getShopeeLinks(),
      fin.existingShopeeRefs(parsed.orders.map(o => o.ref)), fin.getInstallRates(),
    ]);
    const byId = new Map(products.map(p => [p.id, p]));
    const brands = [...new Set(products.map(p => p.brand).filter(Boolean))];
    const categories = [...new Set(products.map(p => p.category).filter(Boolean))].sort();

    // One listing per product name (the report has no variations).
    const listingMap = new Map();
    for (const o of parsed.orders) for (const ln of o.lines) {
      ln.key = listingKey(ln.name, "");
      const e = listingMap.get(ln.key) || { key: ln.key, name: ln.name, variation: "", orders: 0, qty: 0, minAmount: Infinity };
      e.orders += 1; e.minAmount = Math.min(e.minAmount, ln.amount);
      listingMap.set(ln.key, e);
    }
    const listings = [...listingMap.values()].map(l => {
      const saved = links.get(l.key);
      let out;
      if (saved && (saved.productId == null || byId.has(saved.productId))) out = { ...l, productId: saved.productId, via: "tersimpan" };
      else {
        const s = suggestProduct(l, products);
        out = { ...l, productId: s ? s.productId : null, via: s ? s.via : null };
      }
      out.installType = "none"; out.installMeters = null;
      out.proposal = proposeNewProduct(l, { brands, categories, catalog: products, price: l.minAmount });
      return out;
    });
    const listingBy = new Map(listings.map(l => [l.key, l]));

    // Quantity per line from a known unit price; a line well above the
    // product's price is flagged so the admin checks it.
    for (const o of parsed.orders) for (const ln of o.lines) {
      const l = listingBy.get(ln.key);
      const product = byId.get(l.productId);
      ln.qty = inferQty(ln.amount, [product?.price, l.minAmount < ln.amount ? l.minAmount : null]);
      ln.checkQty = ln.qty === 1 && product?.price > 0 && ln.amount > product.price * 1.6;
      ln.installType = "none"; ln.installMeters = null;
      l.qty += ln.qty;
    }
    res.json({
      source: "income",
      fileName: req.file.originalname,
      orders: parsed.orders.map(o => ({ ...o, alreadyImported: existing.has(o.ref) })),
      skipped: [],
      listings: listings.map(({ minAmount, ...l }) => l),
      rates, categories,
      products: products.map(p => ({ id: p.id, name: p.name, shortName: p.shortName, category: p.category, stock: p.stock, avgCost: p.avgCost, price: p.price })),
    });
  } catch (err) { next(err); }
});

router.post("/shopee/income/commit", wrap(async (req, res) => {
  const b = req.body || {};
  // Payouts first: they also correct orders imported earlier from an order export.
  const payouts = (Array.isArray(b.payouts) ? b.payouts : []).map(p => ({
    ref: text(p?.ref, 64),
    releasedOn: /^\d{4}-\d{2}-\d{2}$/.test(String(p?.releasedOn || "")) ? p.releasedOn : null,
    productPrice: rupiah(p?.productPrice || 0, "Harga produk"),
    payout: rupiah(p?.payout, "Dana diterima"),
    fees: p?.fees && typeof p.fees === "object" ? Object.fromEntries(Object.entries(p.fees).slice(0, 30).map(([k, v]) => [text(k, 80), Number(v) || 0])) : {},
  })).filter(p => p.ref);
  if (!payouts.length) throw fin.badRequest("Tidak ada data penghasilan untuk diimpor.");
  const payoutResult = await fin.importShopeePayouts(payouts);

  const fresh = Array.isArray(b.orders) ? b.orders : [];
  let result = { imported: 0, duplicates: 0, lines: 0, unlinkedLines: 0, revenue: 0, install: 0, fee: 0, warnings: [], createdProducts: [] };
  if (fresh.length) {
    const orders = sanitizeOrders(fresh);
    const links = await commitLinks(b.links);
    result = await fin.importShopeeOrders({ orders, links: links.map, feePercent: 0 });
    await links.save();
  }
  res.json({ ...result, payouts: payoutResult });
}));

router.get("/shopee/fee-stats", wrap(async (req, res) => res.json(await fin.shopeeFeeStats())));

// ---- report ----
router.get("/report", wrap(async (req, res) => res.json(await fin.financeReport(monthOf(req)))));

export default router;
