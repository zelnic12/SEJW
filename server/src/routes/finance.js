// ---- Bookkeeping router: /api/admin/finance (admin only) ----
//
//   GET    /products                 products with stock + average cost (modal)
//   GET    /receipts?month=YYYY-MM   barang masuk         POST /receipts   DELETE /receipts/:id
//   GET    /receipts/last/:productId last purchase (prefills the form)
//   GET    /suppliers                recent supplier names
//   GET    /expenses?month=          pengeluaran          POST /expenses   DELETE /expenses/:id
//   GET    /expense-categories
//   GET    /sales?month=&channel=    toko + Shopee sales  POST /sales (toko) DELETE /sales/:id
//   POST   /shopee/parse             multipart Shopee export → orders + listing suggestions
//   POST   /shopee/commit            { orders, links, feePercent } → import report
//   GET    /report?month=            monthly profit & loss across website, toko and Shopee
import { Router } from "express";
import * as fin from "../finance/store.js";
import { normalizeShopeeRows, suggestProduct, sanitizeOrders, listingKey } from "../finance/shopee.js";
import { parseSpreadsheet } from "../import/products.js";
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

// ---- products ----
router.get("/products", wrap(async (req, res) => res.json(await fin.listCostedProducts())));

// ---- barang masuk ----
router.get("/receipts", wrap(async (req, res) => res.json(await fin.listReceipts(monthOf(req)))));
router.get("/receipts/last/:id", wrap(async (req, res) => res.json(await fin.lastReceiptFor(idParam(req)))));
router.get("/suppliers", wrap(async (req, res) => res.json(await fin.listSuppliers())));

router.post("/receipts", wrap(async (req, res) => {
  const b = req.body || {};
  const id = await fin.createReceipt({
    receivedOn: date(b.receivedOn, "Tanggal"),
    productId: int(b.productId, "Produk", { max: 2_147_483_647 }),
    quantity: int(b.quantity, "Jumlah"),
    unitCost: rupiah(b.unitCost, "Harga beli"),
    supplier: text(b.supplier, 120),
    note: text(b.note, 300),
  });
  res.status(201).json({ id });
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
  const items = b.items.map((i, k) => ({
    productId: int(i?.productId, `Produk baris ${k + 1}`, { max: 2_147_483_647 }),
    quantity: int(i?.quantity, `Jumlah baris ${k + 1}`, { max: 100_000 }),
    unitPrice: rupiah(i?.unitPrice, `Harga baris ${k + 1}`),
  }));
  const id = await fin.createStoreSale({
    soldAt, items,
    customer: text(b.customer, 120),
    note: text(b.note, 300),
    discount: rupiah(b.discount || 0, "Diskon"),
  });
  res.status(201).json({ id });
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
    const [products, links, existing] = await Promise.all([
      fin.listCostedProducts(),
      fin.getShopeeLinks(),
      fin.existingShopeeRefs(parsed.orders.map(o => o.ref)),
    ]);
    const listings = parsed.listings.map(l => {
      if (links.has(l.key)) return { ...l, productId: links.get(l.key), via: "tersimpan" };
      const s = suggestProduct(l, products);
      return { ...l, productId: s ? s.productId : null, via: s ? s.via : null };
    });
    res.json({
      fileName: req.file.originalname,
      orders: parsed.orders.map(o => ({ ...o, alreadyImported: existing.has(o.ref) })),
      skipped: parsed.skipped,
      listings,
      products: products.map(p => ({ id: p.id, name: p.name, shortName: p.shortName, category: p.category, stock: p.stock, avgCost: p.avgCost })),
    });
  } catch (err) { next(err); }
});

router.post("/shopee/commit", wrap(async (req, res) => {
  const b = req.body || {};
  const orders = sanitizeOrders(b.orders);
  const feePercent = Number(b.feePercent ?? 0);
  if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 50) throw fin.badRequest("Persentase biaya Shopee harus 0–50%.");

  // links: [{ name, variation, productId|null }] — one per Shopee listing.
  const rawLinks = Array.isArray(b.links) ? b.links : [];
  const links = new Map();
  const toSave = [];
  const products = new Set((await fin.listCostedProducts()).map(p => p.id));
  for (const l of rawLinks) {
    const name = text(l?.name, 500), variation = text(l?.variation, 300);
    if (!name) continue;
    const pid = l.productId == null || l.productId === "" ? null : Number(l.productId);
    if (pid != null && !products.has(pid)) throw fin.badRequest(`Produk #${l.productId} tidak ditemukan.`);
    links.set(listingKey(name, variation), pid);
    toSave.push({ name: name.toLowerCase(), variation: variation.toLowerCase(), productId: pid });
  }

  const result = await fin.importShopeeOrders({ orders, links, feePercent });
  await fin.saveShopeeLinks(toSave);
  res.json(result);
}));

// ---- report ----
router.get("/report", wrap(async (req, res) => res.json(await fin.financeReport(monthOf(req)))));

export default router;
