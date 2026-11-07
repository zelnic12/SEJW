// ---- Bookkeeping data access (pembukuan) ----
// Barang masuk, pengeluaran, penjualan toko/Shopee and the monthly report.
// Stock and moving-average cost (products.avg_cost) are always changed inside a
// transaction with the product rows locked, so two admins recording at the same
// time can't lose an update.
import { query, withTransaction } from "../db/pool.js";
import { listingKey } from "./shopee.js";
import { shortProductNames } from "./names.js";
import { DEFAULT_RATES, installCost } from "./install.js";

const TZ = "Asia/Jakarta";
const n = v => (v == null ? 0 : Number(v));

/** "YYYY-MM" or throws a 400-able error. */
export function parseMonth(month) {
  const m = String(month || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw badRequest("Bulan harus berformat YYYY-MM.");
  return m;
}

export function badRequest(message, details) {
  const e = new Error(message);
  e.status = 400;
  if (details) e.details = details;
  return e;
}

// ---------------------------------------------------------------------------
// Products (with cost — admin only)
// ---------------------------------------------------------------------------
export async function listCostedProducts() {
  const { rows } = await query(
    `SELECT id, name, brand, category, price, sale_price, stock, avg_cost
       FROM products ORDER BY lower(name)`
  );
  // shortName ("Brand + model") is what the bookkeeping screens show and pick by.
  const short = shortProductNames(rows);
  return rows
    .map(r => {
    const price = n(r.price);
    const sale = r.sale_price == null ? null : n(r.sale_price);
    return {
      id: r.id, name: r.name, shortName: short.get(r.id), brand: r.brand, category: r.category,
      price: sale != null && sale >= 0 && sale < price ? sale : price,
      stock: r.stock, avgCost: n(r.avg_cost),
    };
    })
    .sort((a, b) => a.shortName.localeCompare(b.shortName, "id"));
}

// ---------------------------------------------------------------------------
// Barang masuk
// ---------------------------------------------------------------------------
const mapReceipt = r => ({
  id: r.id, receivedOn: r.received_on, productId: r.product_id, productName: r.product_name,
  quantity: r.quantity, unitCost: n(r.unit_cost), total: r.quantity * n(r.unit_cost),
  supplier: r.supplier, note: r.note, createdAt: r.created_at,
});

export async function listReceipts(month) {
  const { rows } = await query(
    `SELECT sr.id, to_char(sr.received_on, 'YYYY-MM-DD') AS received_on, sr.product_id, sr.quantity,
            sr.unit_cost, sr.supplier, sr.note, sr.created_at, p.name AS product_name
       FROM stock_receipts sr JOIN products p ON p.id = sr.product_id
      WHERE to_char(sr.received_on, 'YYYY-MM') = $1
      ORDER BY sr.received_on DESC, sr.id DESC`, [month]);
  return rows.map(mapReceipt);
}

export async function listSuppliers() {
  const { rows } = await query(
    `SELECT supplier FROM stock_receipts WHERE supplier <> ''
      GROUP BY supplier ORDER BY max(created_at) DESC LIMIT 100`);
  return rows.map(r => r.supplier);
}

/** Last purchase of a product — prefills the form. */
export async function lastReceiptFor(productId) {
  const { rows } = await query(
    `SELECT unit_cost, supplier FROM stock_receipts WHERE product_id = $1
      ORDER BY received_on DESC, id DESC LIMIT 1`, [productId]);
  return rows[0] ? { unitCost: n(rows[0].unit_cost), supplier: rows[0].supplier } : null;
}

// One receipt inside an open transaction: lock the product, add stock, update avg cost.
async function applyReceipt(client, { receivedOn, productId, quantity, unitCost, supplier = "", note = "" }) {
  const { rows } = await client.query("SELECT stock, avg_cost FROM products WHERE id = $1 FOR UPDATE", [productId]);
  if (!rows[0]) throw badRequest(`Produk #${productId} tidak ditemukan.`);
  const stock = Math.max(0, rows[0].stock);
  const avg = n(rows[0].avg_cost);
  // Moving average: what's on the shelf at the old cost + what arrived at the new cost.
  // avg_cost 0 means "cost never recorded" (stock that existed before
  // bookkeeping started), not "free": those units take the new purchase
  // price instead of dragging the average toward zero.
  const newAvg = avg > 0
    ? (stock * avg + quantity * unitCost) / (stock + quantity)
    : unitCost;
  await client.query("UPDATE products SET stock = stock + $1, avg_cost = $2 WHERE id = $3",
    [quantity, newAvg.toFixed(2), productId]);
  const { rows: ins } = await client.query(
    `INSERT INTO stock_receipts (received_on, product_id, quantity, unit_cost, supplier, note)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [receivedOn, productId, quantity, unitCost, supplier, note]);
  return ins[0].id;
}

export async function createReceipt(receipt) {
  return withTransaction(client => applyReceipt(client, receipt));
}

/** Many receipts at once (Excel import): all are saved, or none are. */
export async function createReceipts(receipts) {
  return withTransaction(async client => {
    // Oldest first, so the moving average follows the order goods arrived in.
    const ordered = receipts.map((r, i) => ({ r, i }))
      .sort((a, b) => a.r.receivedOn.localeCompare(b.r.receivedOn) || a.i - b.i);
    for (const { r } of ordered) await applyReceipt(client, r);
    return {
      count: receipts.length,
      units: receipts.reduce((s, r) => s + r.quantity, 0),
      total: receipts.reduce((s, r) => s + r.quantity * r.unitCost, 0),
    };
  });
}

/**
 * Undo a mistaken receipt: take the units back out of stock and back their cost
 * out of the average. Refused when those units have already been sold.
 */
export async function deleteReceipt(id) {
  return withTransaction(async client => {
    const { rows } = await client.query("SELECT * FROM stock_receipts WHERE id = $1 FOR UPDATE", [id]);
    const r = rows[0];
    if (!r) return false;
    const { rows: prows } = await client.query("SELECT name, stock, avg_cost FROM products WHERE id = $1 FOR UPDATE", [r.product_id]);
    const p = prows[0];
    if (p.stock < r.quantity) {
      throw badRequest(`Tidak bisa dihapus: stok ${p.name} tinggal ${p.stock}, sebagian barang dari penerimaan ini sudah terjual.`);
    }
    const remaining = p.stock - r.quantity;
    const value = p.stock * n(p.avg_cost) - r.quantity * n(r.unit_cost);
    const newAvg = remaining > 0 ? Math.max(0, value / remaining) : n(p.avg_cost);
    await client.query("UPDATE products SET stock = $1, avg_cost = $2 WHERE id = $3",
      [remaining, newAvg.toFixed(2), r.product_id]);
    await client.query("DELETE FROM stock_receipts WHERE id = $1", [id]);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Pengeluaran
// ---------------------------------------------------------------------------
export const EXPENSE_CATEGORIES = [
  "Sewa tempat", "Gaji karyawan", "Listrik & air", "Internet & pulsa",
  "Transportasi & ongkir", "Perlengkapan toko", "Servis & perbaikan", "Pajak & retribusi", "Lain-lain",
];

export async function listExpenses(month) {
  const { rows } = await query(
    `SELECT id, to_char(spent_on, 'YYYY-MM-DD') AS spent_on, category, amount, note, created_at
       FROM expenses WHERE to_char(spent_on, 'YYYY-MM') = $1
      ORDER BY spent_on DESC, id DESC`, [month]);
  return rows.map(r => ({ id: r.id, spentOn: r.spent_on, category: r.category, amount: n(r.amount), note: r.note }));
}

export async function createExpense({ spentOn, category, amount, note = "" }) {
  const { rows } = await query(
    "INSERT INTO expenses (spent_on, category, amount, note) VALUES ($1,$2,$3,$4) RETURNING id",
    [spentOn, category, amount, note]);
  return rows[0].id;
}

export async function deleteExpense(id) {
  const { rowCount } = await query("DELETE FROM expenses WHERE id = $1", [id]);
  return rowCount > 0;
}

// ---------------------------------------------------------------------------
// Tarif jasa pasang AC
// ---------------------------------------------------------------------------
export async function getInstallRates(client = null) {
  const { rows } = await (client || { query }).query("SELECT value FROM finance_settings WHERE key = 'install_rates'");
  return { ...DEFAULT_RATES, ...(rows[0]?.value || {}) };
}

export async function saveInstallRates(rates) {
  await query(
    `INSERT INTO finance_settings (key, value, updated_at) VALUES ('install_rates', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(rates)]);
  return rates;
}

// ---------------------------------------------------------------------------
// Penjualan toko + Shopee
// ---------------------------------------------------------------------------
export async function listSales(month, channel = "") {
  const params = [month, TZ];
  let filter = "";
  if (channel) { params.push(channel); filter = "AND s.channel = $3"; }
  const { rows } = await query(
    `SELECT s.*,
            COALESCE(SUM(si.quantity * si.unit_price), 0) AS gross,
            COALESCE(SUM(si.quantity * si.unit_cost), 0)  AS cost,
            COALESCE(SUM(si.quantity * si.install_cost), 0) AS install,
            COUNT(si.id) FILTER (WHERE si.product_id IS NULL) AS unlinked,
            json_agg(json_build_object('name', si.product_name, 'qty', si.quantity, 'unitPrice', si.unit_price,
                     'productId', si.product_id, 'installType', si.install_type, 'installMeters', si.install_meters,
                     'installCost', si.install_cost) ORDER BY si.id) AS items
       FROM sales s JOIN sale_items si ON si.sale_id = s.id
      WHERE to_char(s.sold_at AT TIME ZONE $2, 'YYYY-MM') = $1 ${filter}
      GROUP BY s.id
      ORDER BY s.sold_at DESC, s.id DESC`, params);
  return rows.map(r => {
    // Installation cost comes off the selling price: revenue is what the goods earned.
    const revenue = n(r.subtotal) - n(r.discount) - n(r.install);
    return {
      id: r.id, channel: r.channel, ref: r.external_ref, soldAt: r.sold_at, customer: r.customer, note: r.note,
      subtotal: n(r.subtotal), discount: n(r.discount), install: n(r.install), fee: n(r.marketplace_fee),
      revenue, cost: n(r.cost), profit: revenue - n(r.marketplace_fee) - n(r.cost),
      unlinked: Number(r.unlinked),
      items: r.items.map(i => ({ ...i, unitPrice: n(i.unitPrice), installCost: n(i.installCost) })),
    };
  });
}

/**
 * Walk-in sale. items: [{ productId, quantity, unitPrice, installType, installMeters }].
 * unitPrice is the price the customer paid per unit, installation included;
 * the installation cost (from the current rates) is stored per unit and taken
 * off the revenue. Stock is checked and taken under row locks, like checkout.
 */
export async function createStoreSale({ soldAt, customer = "", note = "", discount = 0, items }) {
  return withTransaction(async client => {
    const ids = [...new Set(items.map(i => i.productId))].sort((a, b) => a - b);
    const { rows } = await client.query(
      "SELECT id, name, stock, avg_cost FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [ids]);
    const byId = new Map(rows.map(r => [r.id, r]));
    const need = new Map();
    for (const i of items) need.set(i.productId, (need.get(i.productId) || 0) + i.quantity);
    const problems = [];
    for (const [id, qty] of need) {
      const p = byId.get(id);
      if (!p) problems.push(`Produk #${id} tidak ditemukan`);
      else if (p.stock < qty) problems.push(`Stok ${p.name} hanya ${p.stock} (diminta ${qty})`);
    }
    if (problems.length) throw badRequest("Stok tidak cukup", problems);

    const rates = await getInstallRates(client);
    for (const i of items) {
      i.installCost = installCost(i.installType || "none", i.installMeters, rates);
      if (i.installCost > i.unitPrice) {
        throw badRequest(`Harga jual ${byId.get(i.productId).name} lebih kecil dari biaya pasang (Rp ${i.installCost.toLocaleString("id-ID")}).`);
      }
    }
    const subtotal = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
    const { rows: ins } = await client.query(
      `INSERT INTO sales (channel, sold_at, customer, subtotal, discount, note)
       VALUES ('toko', $1, $2, $3, $4, $5) RETURNING id`,
      [soldAt, customer, subtotal, Math.min(discount, subtotal), note]);
    const saleId = ins[0].id;
    for (const i of items) {
      const p = byId.get(i.productId);
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit_cost,
                                 install_type, install_meters, install_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [saleId, p.id, p.name, i.quantity, i.unitPrice, p.avg_cost, i.installType || "none", i.installMeters ?? null, i.installCost]);
      await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [i.quantity, p.id]);
    }
    return saleId;
  });
}

/** Void a sale (toko or Shopee): delete it and put linked units back in stock. */
export async function deleteSale(id) {
  return withTransaction(async client => {
    const { rows } = await client.query("SELECT id FROM sales WHERE id = $1 FOR UPDATE", [id]);
    if (!rows[0]) return false;
    const { rows: items } = await client.query(
      "SELECT product_id, SUM(quantity)::int AS qty FROM sale_items WHERE sale_id = $1 AND product_id IS NOT NULL GROUP BY product_id ORDER BY product_id", [id]);
    for (const it of items) {
      await client.query("UPDATE products SET stock = stock + $1 WHERE id = $2", [it.qty, it.product_id]);
    }
    await client.query("DELETE FROM sales WHERE id = $1", [id]);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Shopee import
// ---------------------------------------------------------------------------
/** Saved listing → { productId, installType, installMeters }, keyed like listingKey(). */
export async function getShopeeLinks() {
  const { rows } = await query(
    "SELECT shopee_name, shopee_variation, product_id, install_type, install_meters FROM shopee_product_links");
  const map = new Map();
  for (const r of rows) {
    map.set(listingKey(r.shopee_name, r.shopee_variation),
      { productId: r.product_id, installType: r.install_type, installMeters: r.install_meters });
  }
  return map;
}

export async function existingShopeeRefs(refs) {
  if (!refs.length) return new Set();
  const { rows } = await query(
    "SELECT external_ref FROM sales WHERE channel = 'shopee' AND external_ref = ANY($1::text[])", [refs]);
  return new Set(rows.map(r => r.external_ref));
}

/**
 * Import sanitized orders. links: Map(listingKey → { productId|null, installType, installMeters }).
 * Shopee prices include any installation package; its cost is stored per unit.
 * Orders already imported are skipped. Stock never goes below zero (the sale
 * already happened on Shopee); shortfalls come back as warnings.
 */
export async function importShopeeOrders({ orders, links, feePercent }) {
  return withTransaction(async client => {
    const refs = orders.map(o => o.ref);
    const { rows: dupRows } = await client.query(
      "SELECT external_ref FROM sales WHERE channel = 'shopee' AND external_ref = ANY($1::text[])", [refs]);
    const dup = new Set(dupRows.map(r => r.external_ref));

    const productIds = [...new Set([...links.values()].map(v => v.productId).filter(v => v != null))].sort((a, b) => a - b);
    const rates = await getInstallRates(client);
    const { rows: prows } = await client.query(
      "SELECT id, name, stock, avg_cost FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [productIds]);
    const products = new Map(prows.map(p => [p.id, { ...p, stock: Number(p.stock) }]));

    const result = { imported: 0, duplicates: 0, lines: 0, unlinkedLines: 0, revenue: 0, install: 0, fee: 0, warnings: [] };
    const shortfall = new Map();

    for (const o of orders) {
      if (dup.has(o.ref)) { result.duplicates += 1; continue; }
      dup.add(o.ref);
      const revenue = o.subtotal - o.discount;
      const fee = Math.round(revenue * feePercent / 100);
      const { rows: ins } = await client.query(
        `INSERT INTO sales (channel, external_ref, sold_at, customer, subtotal, discount, marketplace_fee)
         VALUES ('shopee', $1, $2, $3, $4, $5, $6) RETURNING id`,
        [o.ref, o.soldAt, o.buyer, o.subtotal, o.discount, fee]);
      const saleId = ins[0].id;
      for (const l of o.lines) {
        const link = links.get(l.key) || { productId: null, installType: "none", installMeters: null };
        const p = link.productId != null ? products.get(link.productId) : null;
        const label = l.variation ? `${l.name} - ${l.variation}` : l.name;
        const iCost = Math.min(installCost(link.installType, link.installMeters, rates), l.unitPrice);
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, product_name, quantity, unit_price, unit_cost,
                                   install_type, install_meters, install_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [saleId, p ? p.id : null, label, l.qty, l.unitPrice, p ? p.avg_cost : 0, link.installType, link.installMeters, iCost]);
        result.install += iCost * l.qty;
        if (p) {
          if (p.stock < l.qty) shortfall.set(p.id, (shortfall.get(p.id) || 0) + (l.qty - Math.max(0, p.stock)));
          p.stock = Math.max(0, p.stock - l.qty);
        } else {
          result.unlinkedLines += 1;
        }
        result.lines += 1;
      }
      result.imported += 1;
      result.revenue += revenue;   // before installation; result.install is shown beside it
      result.fee += fee;
    }

    for (const p of products.values()) {
      await client.query("UPDATE products SET stock = $1 WHERE id = $2", [p.stock, p.id]);
    }
    for (const [id, missing] of shortfall) {
      result.warnings.push(`Stok ${products.get(id).name} kurang ${missing} unit, jadi stoknya sekarang 0. Catat barang masuknya agar stok kembali benar.`);
    }
    return result;
  });
}

export async function saveShopeeLinks(entries) {
  // entries: [{ name, variation, productId|null, installType, installMeters }]
  for (const e of entries) {
    await query(
      `INSERT INTO shopee_product_links (shopee_name, shopee_variation, product_id, install_type, install_meters, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (shopee_name, shopee_variation)
       DO UPDATE SET product_id = EXCLUDED.product_id, install_type = EXCLUDED.install_type,
                     install_meters = EXCLUDED.install_meters, updated_at = now()`,
      [e.name, e.variation, e.productId, e.installType || "none", e.installMeters ?? null]);
  }
}

// ---------------------------------------------------------------------------
// Laporan
// ---------------------------------------------------------------------------
// Website orders count once they're paid and not cancelled.
const WEBSITE_SALE = "o.status NOT IN ('awaiting_payment', 'pending', 'cancelled')";

export async function financeReport(month) {
  const p = [month, TZ];

  const web = (await query(
    `SELECT COUNT(*)::int AS orders,
            COALESCE(SUM(o.subtotal - COALESCE(o.discount, 0)), 0) AS revenue,
            COALESCE(SUM(o.shipping), 0) AS shipping
       FROM orders o
      WHERE ${WEBSITE_SALE} AND to_char(o.created_at AT TIME ZONE $2, 'YYYY-MM') = $1`, p)).rows[0];

  // Lines sold before costs were tracked fall back to today's average cost.
  const webCost = (await query(
    `SELECT COALESCE(SUM(oi.quantity * COALESCE(oi.unit_cost, pr.avg_cost, 0)), 0) AS cost,
            COALESCE(SUM(oi.quantity), 0)::int AS units,
            COUNT(*) FILTER (WHERE COALESCE(oi.unit_cost, pr.avg_cost, 0) = 0)::int AS no_cost
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       LEFT JOIN products pr ON pr.id = oi.product_id
      WHERE ${WEBSITE_SALE} AND to_char(o.created_at AT TIME ZONE $2, 'YYYY-MM') = $1`, p)).rows[0];

  const { rows: chanRows } = await query(
    `SELECT channel, COUNT(*)::int AS orders,
            SUM(subtotal - discount) AS revenue, SUM(marketplace_fee) AS fee
       FROM sales
      WHERE to_char(sold_at AT TIME ZONE $2, 'YYYY-MM') = $1
      GROUP BY channel`, p);
  const { rows: chanCost } = await query(
    `SELECT s.channel,
            COALESCE(SUM(si.quantity * si.unit_cost), 0) AS cost,
            COALESCE(SUM(si.quantity), 0)::int AS units,
            COALESCE(SUM(si.quantity * si.install_cost), 0) AS install,
            COUNT(*) FILTER (WHERE si.product_id IS NULL OR si.unit_cost = 0)::int AS no_cost
       FROM sales s JOIN sale_items si ON si.sale_id = s.id
      WHERE to_char(s.sold_at AT TIME ZONE $2, 'YYYY-MM') = $1
      GROUP BY s.channel`, p);

  const channels = {
    // gross = selling price after discounts; install = AC installation cost taken
    // off it; revenue = gross - install (what the goods themselves earned).
    website: { orders: web.orders, gross: n(web.revenue), install: 0, revenue: n(web.revenue), shipping: n(web.shipping), fee: 0,
               cost: n(webCost.cost), units: webCost.units, noCostLines: webCost.no_cost },
    toko:    { orders: 0, gross: 0, install: 0, revenue: 0, shipping: 0, fee: 0, cost: 0, units: 0, noCostLines: 0 },
    shopee:  { orders: 0, gross: 0, install: 0, revenue: 0, shipping: 0, fee: 0, cost: 0, units: 0, noCostLines: 0 },
  };
  for (const r of chanRows) Object.assign(channels[r.channel], { orders: r.orders, gross: n(r.revenue), fee: n(r.fee) });
  for (const r of chanCost) Object.assign(channels[r.channel], { cost: n(r.cost), install: n(r.install), units: r.units, noCostLines: r.no_cost });
  for (const k of ["toko", "shopee"]) channels[k].revenue = channels[k].gross - channels[k].install;

  const { rows: expRows } = await query(
    `SELECT category, SUM(amount) AS amount FROM expenses
      WHERE to_char(spent_on, 'YYYY-MM') = $1 GROUP BY category ORDER BY SUM(amount) DESC`, [month]);
  const expenses = expRows.map(r => ({ category: r.category, amount: n(r.amount) }));

  const purchases = (await query(
    `SELECT COALESCE(SUM(quantity * unit_cost), 0) AS total, COUNT(*)::int AS receipts
       FROM stock_receipts WHERE to_char(received_on, 'YYYY-MM') = $1`, [month])).rows[0];

  const inventory = (await query(
    `SELECT COALESCE(SUM(GREATEST(stock, 0) * avg_cost), 0) AS value,
            COALESCE(SUM(GREATEST(stock, 0)), 0)::int AS units,
            COUNT(*) FILTER (WHERE stock > 0 AND avg_cost = 0)::int AS without_cost
       FROM products`)).rows[0];

  const { rows: top } = await query(
    `WITH lines AS (
       SELECT oi.product_name AS name, oi.quantity AS qty,
              oi.quantity * oi.unit_price AS revenue,
              oi.quantity * COALESCE(oi.unit_cost, pr.avg_cost, 0) AS cost
         FROM orders o JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN products pr ON pr.id = oi.product_id
        WHERE ${WEBSITE_SALE} AND to_char(o.created_at AT TIME ZONE $2, 'YYYY-MM') = $1
       UNION ALL
       SELECT COALESCE(pr.name, si.product_name), si.quantity, si.quantity * (si.unit_price - si.install_cost), si.quantity * si.unit_cost
         FROM sales s JOIN sale_items si ON si.sale_id = s.id
         LEFT JOIN products pr ON pr.id = si.product_id
        WHERE to_char(s.sold_at AT TIME ZONE $2, 'YYYY-MM') = $1)
     SELECT name, SUM(qty)::int AS qty, SUM(revenue) AS revenue, SUM(cost) AS cost
       FROM lines GROUP BY name ORDER BY SUM(revenue) DESC LIMIT 10`, p);

  const sum = k => Object.values(channels).reduce((s, c) => s + c[k], 0);
  const revenue = sum("revenue");
  const gross = sum("gross");
  const install = sum("install");
  const shipping = sum("shipping");
  const cost = sum("cost");
  const fees = sum("fee");
  const grossProfit = revenue + shipping - cost - fees;
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);

  return {
    month,
    channels,
    totals: {
      gross, install, revenue, shipping, cost, fees, grossProfit,
      expenses: totalExpenses,
      netProfit: grossProfit - totalExpenses,
      orders: sum("orders"), units: sum("units"),
      noCostLines: sum("noCostLines"),
    },
    expenses,
    purchases: { total: n(purchases.total), receipts: purchases.receipts },
    inventory: { value: n(inventory.value), units: inventory.units, withoutCost: inventory.without_cost },
    // profit is null when no cost is known (no barang masuk yet, or a Shopee line
    // not linked to a product) — showing the full revenue as profit would mislead.
    topProducts: top.map(t => ({
      name: t.name, qty: t.qty, revenue: n(t.revenue),
      profit: n(t.cost) > 0 ? n(t.revenue) - n(t.cost) : null,
    })),
  };
}
