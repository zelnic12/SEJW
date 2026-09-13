// ---- Data store (PostgreSQL) ----
// All data access goes through this module. It talks to Postgres via the shared
// pool and returns objects in the same shape the API/frontend already expect,
// so the routers are unchanged by the migration from JSON files.

import { query, withTransaction } from "./db/pool.js";
import { migrate } from "./db/migrate.js";

// Convert a DB product row into the API product shape.
// NUMERIC columns come back as strings from pg — coerce to numbers.
function mapProduct(row) {
  if (!row) return null;
  const price = Number(row.price);
  // sale_price is optional; a sale is only "active" when 0 <= sale < price.
  const salePrice = row.sale_price == null ? null : Number(row.sale_price);
  const onSale = salePrice != null && salePrice >= 0 && salePrice < price;
  const product = {
    id: row.id,
    name: row.name,
    brand: row.brand,
    category: row.category,
    price,
    salePrice,                                   // null when no promo set
    onSale,                                       // convenience flag
    effectivePrice: onSale ? salePrice : price,   // what the customer actually pays
    discountPercent: onSale ? Math.round((1 - salePrice / price) * 100) : 0,
    rating: Number(row.rating),
    emoji: row.emoji,
    stock: row.stock,
    description: row.description,
    specs: row.specs || {},
    // Review aggregates (from PRODUCT_SELECT join). reviewCount 0 when none.
    reviewCount: row.review_count != null ? Number(row.review_count) : 0,
    avgRating: row.avg_rating != null ? Math.round(Number(row.avg_rating) * 10) / 10 : 0,
  };
  if (row.images) {
    product.images = row.images.map(img => ({ id: img.id, url: img.url, alt: img.alt }));
  }
  return product;
}

// The authoritative effective (charged) price for a product row/object.
// Used by checkout so totals never trust the client.
export function effectivePrice(product) {
  const price = Number(product.price);
  const sale = product.salePrice == null ? null : Number(product.salePrice);
  return sale != null && sale >= 0 && sale < price ? sale : price;
}

// On boot, ensure the schema exists. (Product/order seeding is a separate
// explicit step; the admin user is bootstrapped here so the system always has
// a way in — see ensureAdmin below.)
export async function initStore() {
  await migrate();
  await ensureAdmin();
}

// Create a default admin account if none exists yet. Credentials come from env
// (ADMIN_USERNAME / ADMIN_PASSWORD) with demo defaults.
async function ensureAdmin() {
  const { rows } = await query("SELECT COUNT(*)::int AS n FROM admin_users");
  if (rows[0].n > 0) return;
  const bcrypt = (await import("bcryptjs")).default;
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "admin123";
  const name = process.env.ADMIN_NAME || "Store Admin";
  const hash = await bcrypt.hash(password, 10);
  await query(
    "INSERT INTO admin_users (username, password_hash, name) VALUES ($1,$2,$3) ON CONFLICT (username) DO NOTHING",
    [username, hash, name]
  );
  console.log(`✓ Bootstrapped admin user "${username}"` +
    (process.env.ADMIN_PASSWORD ? "" : ` (default password "${password}")`));
}

// ---- Products ----
const PRODUCT_SELECT = `
  SELECT p.*,
         COALESCE(
           (SELECT json_agg(json_build_object('id', pi.id, 'url', pi.url, 'alt', pi.alt) ORDER BY pi.position, pi.id)
              FROM product_images pi WHERE pi.product_id = p.id),
           '[]'::json
         ) AS images,
         (SELECT COUNT(*) FROM product_reviews r WHERE r.product_id = p.id) AS review_count,
         (SELECT AVG(r.rating) FROM product_reviews r WHERE r.product_id = p.id) AS avg_rating
    FROM products p`;

export async function getProducts() {
  const { rows } = await query(`${PRODUCT_SELECT} ORDER BY p.id`);
  return rows.map(mapProduct);
}

// Lower-cased product names, for cheap duplicate detection during a bulk import
// (the full getProducts() join is far too heavy to run per row).
export async function listProductNamesLower() {
  const { rows } = await query("SELECT lower(name) AS name FROM products");
  return rows.map(r => r.name);
}

export async function getProduct(id) {
  const { rows } = await query(`${PRODUCT_SELECT} WHERE p.id = $1`, [Number(id)]);
  return mapProduct(rows[0]);
}

export async function createProduct(data) {
  const { rows } = await query(
    `INSERT INTO products (name, brand, category, price, sale_price, rating, emoji, stock, description, specs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      data.name, data.brand ?? "", data.category ?? "Uncategorized",
      data.price, data.sale_price ?? null, data.rating ?? 0, data.emoji ?? "📦",
      data.stock, data.description ?? "", JSON.stringify(data.specs ?? {}),
    ]
  );
  return getProduct(rows[0].id);
}

export async function updateProduct(id, data) {
  // Build a dynamic SET clause from the provided fields only.
  // sale_price is included so admins can set OR clear (null) a promotion.
  const fields = ["name", "brand", "category", "price", "sale_price", "rating", "emoji", "stock", "description", "specs"];
  const sets = [];
  const values = [];
  let i = 1;
  for (const f of fields) {
    if (data[f] !== undefined) {
      sets.push(`${f} = $${i++}`);
      values.push(f === "specs" ? JSON.stringify(data[f]) : data[f]);
    }
  }
  if (sets.length === 0) return getProduct(id); // nothing to update
  values.push(Number(id));
  const { rows } = await query(
    `UPDATE products SET ${sets.join(", ")} WHERE id = $${i} RETURNING id`,
    values
  );
  if (rows.length === 0) return null;
  return getProduct(rows[0].id);
}

export async function deleteProduct(id) {
  const { rowCount } = await query("DELETE FROM products WHERE id = $1", [Number(id)]);
  return rowCount > 0;
}

// ---- Orders ----
// Convert order + item rows into the API order shape.
function mapOrder(orderRow, itemRows) {
  return {
    id: orderRow.id,
    createdAt: orderRow.created_at instanceof Date ? orderRow.created_at.toISOString() : orderRow.created_at,
    customer: {
      name: orderRow.ship_name,
      email: orderRow.ship_email,
      phone: orderRow.ship_phone,
      address: orderRow.ship_address,
      city: orderRow.ship_city,
      postal: orderRow.ship_postal,
      country: orderRow.ship_country,
    },
    items: itemRows.map(it => ({
      id: it.product_id,
      name: it.product_name,
      price: Number(it.unit_price),                                  // charged (sale) price
      regularPrice: it.regular_price == null ? Number(it.unit_price) : Number(it.regular_price),
      qty: it.quantity,
    })),
    amounts: {
      subtotal: Number(orderRow.subtotal),
      discount: Number(orderRow.discount ?? 0),
      shipping: Number(orderRow.shipping),
      tax: Number(orderRow.tax),
      total: Number(orderRow.total),
    },
    status: orderRow.status,
    invoiceNo: orderRow.invoice_no ?? null,
    accessToken: orderRow.access_token ?? null,
    paymentStatus: orderRow.payment_status ?? "pending",
    paymentToken: orderRow.payment_token ?? null,
    paymentRedirectUrl: orderRow.payment_redirect_url ?? null,
    paymentTxnId: orderRow.payment_txn_id ?? null,
    fulfillmentMethod: orderRow.fulfillment_method ?? "delivery",
    promoCode: orderRow.promo_code ?? null,
  };
}

// Persist the Midtrans payment details returned after creating a Snap
// transaction. Returns the refreshed order.
export async function setOrderPayment(id, { token = null, redirectUrl = null, status } = {}) {
  const sets = ["payment_token = $2", "payment_redirect_url = $3"];
  const values = [id, token, redirectUrl];
  if (status) { sets.push(`payment_status = $${values.length + 1}`); values.push(status); }
  await query(`UPDATE orders SET ${sets.join(", ")} WHERE id = $1`, values);
  return getOrder(id);
}

// Apply a (verified) Midtrans notification: update payment_status, the
// transaction id, and — when the payment settles or fails — the fulfilment
// status. Only updates fulfilment when `orderStatus` is provided.
// Returns { updated: boolean }.
export async function applyPaymentNotification(orderId, { paymentStatus, orderStatus = null, txnId = null }) {
  const sets = ["payment_status = $2"];
  const values = [orderId, paymentStatus];
  if (txnId) { sets.push(`payment_txn_id = $${values.length + 1}`); values.push(txnId); }
  if (orderStatus) { sets.push(`status = $${values.length + 1}`); values.push(orderStatus); }
  const { rowCount } = await query(`UPDATE orders SET ${sets.join(", ")} WHERE id = $1`, values);
  return { updated: rowCount > 0 };
}

export async function getOrders() {
  const { rows: orders } = await query("SELECT * FROM orders ORDER BY created_at DESC");
  if (orders.length === 0) return [];
  const ids = orders.map(o => o.id);
  const { rows: items } = await query(
    "SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY id", [ids]
  );
  const byOrder = new Map(orders.map(o => [o.id, []]));
  for (const it of items) byOrder.get(it.order_id)?.push(it);
  return orders.map(o => mapOrder(o, byOrder.get(o.id)));
}

export async function getOrder(id) {
  const { rows: orders } = await query("SELECT * FROM orders WHERE id = $1", [id]);
  if (orders.length === 0) return null;
  const { rows: items } = await query(
    "SELECT * FROM order_items WHERE order_id = $1 ORDER BY id", [id]
  );
  return mapOrder(orders[0], items);
}

// Create an order atomically: upsert customer, insert order + items, decrement
// stock — all in one transaction.
export async function createOrder(order) {
  return withTransaction(async (client) => {
    const c = order.customer;

    // Atomically redeem the promo code (if any) inside this transaction. If it
    // became invalid since validation (e.g. last use consumed by someone else),
    // throw a tagged error so the whole order rolls back and the route can 400.
    if (order.promoCode) {
      const redeem = await redeemPromo(client, order.promoCode, order.amounts.subtotal);
      if (!redeem.ok) {
        const e = new Error(redeem.reason || "Promo code is no longer valid.");
        e.promoInvalid = true;
        throw e;
      }
    }

    // Upsert the customer by email; keep their latest details.
    const { rows: custRows } = await client.query(
      `INSERT INTO customers (name, email, phone, address, city, postal, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name, phone = EXCLUDED.phone, address = EXCLUDED.address,
         city = EXCLUDED.city, postal = EXCLUDED.postal, country = EXCLUDED.country
       RETURNING id`,
      [c.name, c.email, c.phone, c.address, c.city, c.postal, c.country]
    );
    const customerId = custRows[0].id;

    // Insert the order (with shipping snapshot + amounts + invoice fields).
    await client.query(
      `INSERT INTO orders
         (id, customer_id, ship_name, ship_email, ship_phone, ship_address,
          ship_city, ship_postal, ship_country, subtotal, discount, shipping, tax, total,
          status, created_at, invoice_no, access_token, fulfillment_method, promo_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        order.id, customerId, c.name, c.email, c.phone, c.address,
        c.city, c.postal, c.country,
        order.amounts.subtotal, order.amounts.discount ?? 0, order.amounts.shipping,
        order.amounts.tax, order.amounts.total,
        order.status, order.createdAt, order.invoiceNo ?? null, order.accessToken ?? null,
        order.fulfillmentMethod === "pickup" ? "pickup" : "delivery",
        order.promoCode ?? null,
      ]
    );

    // Insert line items (snapshotting regular + charged price) and decrement stock.
    for (const item of order.items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, regular_price, quantity)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.id, item.id, item.name, item.price, item.regularPrice ?? item.price, item.qty]
      );
      await client.query(
        "UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id = $2",
        [item.qty, item.id]
      );
    }

    return getOrderWithClient(client, order.id);
  });
}

// Read a full order within an existing transaction client.
async function getOrderWithClient(client, id) {
  const { rows: orders } = await client.query("SELECT * FROM orders WHERE id = $1", [id]);
  if (orders.length === 0) return null;
  const { rows: items } = await client.query(
    "SELECT * FROM order_items WHERE order_id = $1 ORDER BY id", [id]
  );
  return mapOrder(orders[0], items);
}


// ---- Order status update ----
export async function updateOrderStatus(id, status) {
  const { rows } = await query(
    "UPDATE orders SET status = $1 WHERE id = $2 RETURNING id",
    [status, id]
  );
  if (rows.length === 0) return null;
  return getOrder(id);
}

// ============================================================================
// Analytics — aggregate queries for the admin dashboard.
// All monetary values are coerced from NUMERIC strings to numbers.
// ============================================================================

// Headline KPIs: revenue, order count, AOV, customers, units sold, catalog size.
export async function getSummary() {
  const { rows } = await query(`
    SELECT
      COALESCE(SUM(o.total), 0)          AS revenue,
      COUNT(DISTINCT o.id)               AS orders,
      COALESCE(SUM(o.subtotal), 0)       AS subtotal,
      COALESCE(SUM(o.tax), 0)            AS tax,
      COALESCE(SUM(o.shipping), 0)       AS shipping,
      COUNT(DISTINCT o.customer_id)      AS customers
    FROM orders o
  `);
  const units = await query("SELECT COALESCE(SUM(quantity),0) AS units FROM order_items");
  const products = await query("SELECT COUNT(*) AS n FROM products");
  const r = rows[0];
  const orders = Number(r.orders);
  const revenue = Number(r.revenue);
  return {
    revenue,
    orders,
    subtotal: Number(r.subtotal),
    tax: Number(r.tax),
    shipping: Number(r.shipping),
    customers: Number(r.customers),
    unitsSold: Number(units.rows[0].units),
    productCount: Number(products.rows[0].n),
    avgOrderValue: orders > 0 ? +(revenue / orders).toFixed(2) : 0,
  };
}

// Best-selling products by units sold (and revenue).
export async function getBestSellers(limit = 5) {
  const { rows } = await query(`
    SELECT oi.product_id AS id,
           oi.product_name AS name,
           SUM(oi.quantity) AS units,
           SUM(oi.quantity * oi.unit_price) AS revenue
    FROM order_items oi
    GROUP BY oi.product_id, oi.product_name
    ORDER BY units DESC, revenue DESC
    LIMIT $1
  `, [limit]);
  return rows.map(r => ({
    id: r.id, name: r.name,
    units: Number(r.units), revenue: Number(r.revenue),
  }));
}

// Sales grouped by product category (joined via products; falls back to
// 'Unknown' for items whose product was later deleted).
export async function getSalesByCategory() {
  const { rows } = await query(`
    SELECT COALESCE(p.category, 'Unknown') AS label,
           SUM(oi.quantity) AS units,
           SUM(oi.quantity * oi.unit_price) AS revenue
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    GROUP BY COALESCE(p.category, 'Unknown')
    ORDER BY revenue DESC
  `);
  return rows.map(r => ({ label: r.label, units: Number(r.units), revenue: Number(r.revenue) }));
}

// Sales grouped by product brand.
export async function getSalesByBrand() {
  const { rows } = await query(`
    SELECT COALESCE(NULLIF(p.brand, ''), 'Unknown') AS label,
           SUM(oi.quantity) AS units,
           SUM(oi.quantity * oi.unit_price) AS revenue
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    GROUP BY COALESCE(NULLIF(p.brand, ''), 'Unknown')
    ORDER BY revenue DESC
  `);
  return rows.map(r => ({ label: r.label, units: Number(r.units), revenue: Number(r.revenue) }));
}

// Revenue/orders time series, bucketed by day | week | month.
// Returns a dense series (zero-filled gaps) for the last N buckets.
export async function getSalesTimeSeries(bucket = "day", points = 30) {
  const trunc = { day: "day", week: "week", month: "month" }[bucket] || "day";
  const stepInterval = { day: "1 day", week: "1 week", month: "1 month" }[trunc];

  // Generate a dense date spine then LEFT JOIN aggregated orders onto it.
  const { rows } = await query(`
    WITH spine AS (
      SELECT generate_series(
        date_trunc($1, now()) - ($2::int - 1) * $3::interval,
        date_trunc($1, now()),
        $3::interval
      ) AS bucket
    ),
    agg AS (
      SELECT date_trunc($1, created_at) AS bucket,
             SUM(total) AS revenue,
             COUNT(*)   AS orders
      FROM orders
      GROUP BY 1
    )
    SELECT s.bucket,
           COALESCE(a.revenue, 0) AS revenue,
           COALESCE(a.orders, 0)  AS orders
    FROM spine s
    LEFT JOIN agg a ON a.bucket = s.bucket
    ORDER BY s.bucket
  `, [trunc, points, stepInterval]);

  return rows.map(r => ({
    bucket: r.bucket instanceof Date ? r.bucket.toISOString() : r.bucket,
    revenue: Number(r.revenue),
    orders: Number(r.orders),
  }));
}

// Products at or below a low-stock threshold (for stock management alerts).
export async function getLowStock(threshold = 5) {
  const { rows } = await query(
    "SELECT id, name, brand, category, stock, price FROM products WHERE stock <= $1 ORDER BY stock ASC, name",
    [threshold]
  );
  return rows.map(r => ({
    id: r.id, name: r.name, brand: r.brand, category: r.category,
    stock: r.stock, price: Number(r.price),
  }));
}


// ---- Admin users ----
export async function getAdminByUsername(username) {
  const { rows } = await query(
    "SELECT id, username, password_hash, name, role FROM admin_users WHERE username = $1",
    [username]
  );
  return rows[0] || null;
}

export async function getAdminById(id) {
  const { rows } = await query(
    "SELECT id, username, name, role FROM admin_users WHERE id = $1",
    [Number(id)]
  );
  return rows[0] || null;
}


// ============================================================================
// Product images (management)
// ============================================================================

// Shape an image row for the admin API. cloudinaryPublicId is null for the
// emoji placeholders and for legacy images that still live in /uploads.
function mapProductImage(r) {
  return {
    id: r.id,
    productId: r.product_id,
    url: r.url,
    alt: r.alt,
    position: r.position,
    cloudinaryPublicId: r.cloudinary_public_id ?? null,
  };
}

// List images for a product (ordered).
export async function getProductImages(productId) {
  const { rows } = await query(
    `SELECT id, product_id, url, alt, position, cloudinary_public_id
       FROM product_images WHERE product_id = $1 ORDER BY position, id`,
    [Number(productId)]
  );
  return rows.map(mapProductImage);
}

// Add an image. New images go to the end unless it's the first (position 0).
// `cloudinaryPublicId` is stored so the asset can be deleted from Cloudinary later.
export async function addProductImage(productId, url, alt = "", cloudinaryPublicId = null) {
  const { rows: maxRows } = await query(
    "SELECT COALESCE(MAX(position), -1) AS maxpos FROM product_images WHERE product_id = $1",
    [Number(productId)]
  );
  const position = Number(maxRows[0].maxpos) + 1;
  const { rows } = await query(
    `INSERT INTO product_images (product_id, url, alt, position, cloudinary_public_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id, product_id, url, alt, position, cloudinary_public_id`,
    [Number(productId), url, alt, position, cloudinaryPublicId]
  );
  return mapProductImage(rows[0]);
}

// Fetch a single image row (used to locate the asset/file for deletion).
export async function getProductImage(productId, imageId) {
  const { rows } = await query(
    `SELECT id, product_id, url, alt, position, cloudinary_public_id
       FROM product_images WHERE id = $1 AND product_id = $2`,
    [Number(imageId), Number(productId)]
  );
  return rows[0] ? mapProductImage(rows[0]) : null;
}

// Deletes the row and returns { url, cloudinaryPublicId } so the caller can
// remove the backing asset (Cloudinary) or legacy file (local /uploads).
export async function deleteProductImage(productId, imageId) {
  const { rows } = await query(
    `DELETE FROM product_images WHERE id = $1 AND product_id = $2
     RETURNING url, cloudinary_public_id`,
    [Number(imageId), Number(productId)]
  );
  if (!rows[0]) return null;
  return { url: rows[0].url, cloudinaryPublicId: rows[0].cloudinary_public_id ?? null };
}

// Set an image as the primary/main one by giving it the lowest position.
export async function setMainImage(productId, imageId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT id FROM product_images WHERE id = $1 AND product_id = $2",
      [Number(imageId), Number(productId)]
    );
    if (rows.length === 0) return false;
    // Re-number: chosen image = 0, the rest keep relative order starting at 1.
    const { rows: others } = await client.query(
      "SELECT id FROM product_images WHERE product_id = $1 AND id <> $2 ORDER BY position, id",
      [Number(productId), Number(imageId)]
    );
    await client.query("UPDATE product_images SET position = 0 WHERE id = $1", [Number(imageId)]);
    let pos = 1;
    for (const o of others) {
      await client.query("UPDATE product_images SET position = $1 WHERE id = $2", [pos++, o.id]);
    }
    return true;
  });
}

// Reorder all images for a product given an ordered array of image ids.
export async function reorderImages(productId, orderedIds) {
  return withTransaction(async (client) => {
    // Only reorder ids that actually belong to this product.
    const { rows } = await client.query(
      "SELECT id FROM product_images WHERE product_id = $1", [Number(productId)]
    );
    const owned = new Set(rows.map(r => r.id));
    let pos = 0;
    for (const id of orderedIds) {
      if (owned.has(Number(id))) {
        await client.query("UPDATE product_images SET position = $1 WHERE id = $2", [pos++, Number(id)]);
      }
    }
    return true;
  });
}

// ============================================================================
// Invoice number (server-authoritative, unique)
// Format: INV-YYYYMMDD-00001  (sequence-backed, monotonic)
// ============================================================================
export async function nextInvoiceNumber() {
  const { rows } = await query("SELECT nextval('invoice_seq') AS n");
  const seq = String(rows[0].n).padStart(5, "0");
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `INV-${ymd}-${seq}`;
}

// ============================================================================
// Store settings (single row)
// ============================================================================
export async function getStoreSettings() {
  const { rows } = await query("SELECT * FROM store_settings WHERE id = 1");
  const r = rows[0] || { name: "Sinar Elektronik" };
  return {
    name: r.name ?? "Sinar Elektronik",
    tagline: r.tagline ?? "",
    address: r.address ?? "",
    city: r.city ?? "",
    postal: r.postal ?? "",
    country: r.country ?? "",
    phone: r.phone ?? "",
    email: r.email ?? "",
    taxId: r.tax_id ?? "",
    bankInfo: r.bank_info ?? "",
    currency: r.currency ?? "IDR",
  };
}

export async function updateStoreSettings(data) {
  const fieldMap = {
    name: "name", tagline: "tagline", address: "address", city: "city",
    postal: "postal", country: "country", phone: "phone", email: "email",
    taxId: "tax_id", bankInfo: "bank_info", currency: "currency",
  };
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(fieldMap)) {
    if (data[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      values.push(String(data[key]));
    }
  }
  if (sets.length === 0) return getStoreSettings();
  await query(`UPDATE store_settings SET ${sets.join(", ")} WHERE id = 1`, values);
  return getStoreSettings();
}

// ============================================================================
// Raw order (includes access_token) — for invoice access control.
// getOrder()/getOrders() already return invoiceNo + accessToken via mapOrder.
// This is a thin helper used by the invoice route to check the token.
// ============================================================================
export async function getOrderAccessToken(id) {
  const { rows } = await query("SELECT access_token FROM orders WHERE id = $1", [id]);
  return rows.length ? rows[0].access_token : undefined; // undefined = not found
}


// ============================================================================
// Live chat (customer ↔ admin)
// Customers are identified by an opaque session_token (no login). All customer
// reads/writes are scoped by (conversationId + token) so they can only access
// their own conversation.
// ============================================================================
import crypto from "node:crypto";

function mapConversation(row) {
  return {
    id: row.id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    lastMessageAt: row.last_message_at instanceof Date ? row.last_message_at.toISOString() : row.last_message_at,
    adminUnread: row.admin_unread,
    customerUnread: row.customer_unread,
  };
}

function mapMessage(row) {
  return {
    id: row.id,
    sender: row.sender,
    body: row.body,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

// Start a new conversation. Returns { conversation, sessionToken }.
export async function createConversation(name, email) {
  const token = crypto.randomBytes(24).toString("hex");
  const { rows } = await query(
    `INSERT INTO chat_conversations (customer_name, customer_email, session_token)
     VALUES ($1,$2,$3) RETURNING *`,
    [name, email, token]
  );
  return { conversation: mapConversation(rows[0]), sessionToken: token };
}

// Resolve a conversation by id, enforcing the customer's session token.
export async function getConversationForToken(id, token) {
  const { rows } = await query(
    "SELECT * FROM chat_conversations WHERE id = $1 AND session_token = $2",
    [Number(id), token]
  );
  return rows[0] ? mapConversation(rows[0]) : null;
}

// Append a message from either side and bump counters/timestamps atomically.
export async function addChatMessage(conversationId, sender, body) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO chat_messages (conversation_id, sender, body) VALUES ($1,$2,$3) RETURNING *`,
      [Number(conversationId), sender, body]
    );
    // A customer message is unread for the admin; an admin reply is unread for the customer.
    const bump = sender === "customer"
      ? "admin_unread = admin_unread + 1"
      : "customer_unread = customer_unread + 1";
    await client.query(
      `UPDATE chat_conversations SET last_message_at = now(), ${bump} WHERE id = $1`,
      [Number(conversationId)]
    );
    return mapMessage(rows[0]);
  });
}

// List messages for a conversation (optionally only those after `afterId` for
// lightweight polling).
export async function listChatMessages(conversationId, afterId = 0) {
  const { rows } = await query(
    "SELECT * FROM chat_messages WHERE conversation_id = $1 AND id > $2 ORDER BY id",
    [Number(conversationId), Number(afterId) || 0]
  );
  return rows.map(mapMessage);
}

// Clear the customer's unread counter (they've viewed the admin replies).
export async function markCustomerRead(conversationId) {
  await query("UPDATE chat_conversations SET customer_unread = 0 WHERE id = $1", [Number(conversationId)]);
}

// ---- Admin side ----
export async function listConversations() {
  const { rows } = await query(`
    SELECT c.*,
      (SELECT body FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body
    FROM chat_conversations c
    ORDER BY c.last_message_at DESC
  `);
  return rows.map(r => ({ ...mapConversation(r), lastBody: r.last_body || "" }));
}

export async function getConversation(id) {
  const { rows } = await query("SELECT * FROM chat_conversations WHERE id = $1", [Number(id)]);
  return rows[0] ? mapConversation(rows[0]) : null;
}

// Clear the admin's unread counter (they've viewed the customer messages).
export async function markAdminRead(conversationId) {
  await query("UPDATE chat_conversations SET admin_unread = 0 WHERE id = $1", [Number(conversationId)]);
}


// ============================================================================
// Product reviews (public — no account required)
// ============================================================================
function mapReview(row) {
  // NOTE: reviewer_email is intentionally NOT included — email is never exposed
  // publicly. Every stored review has passed purchase verification, so we mark
  // it verifiedPurchase for the storefront badge.
  return {
    id: row.id,
    productId: row.product_id,
    reviewerName: row.reviewer_name,
    rating: row.rating,
    comment: row.comment,
    verifiedPurchase: true,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

// Purchase verification: has this email bought this product in an order that
// actually progressed past payment (not awaiting_payment/pending/cancelled)?
// Matches on the order's snapshot email (ship_email), case-insensitive.
export async function hasPurchasedProduct(email, productId) {
  const { rows } = await query(
    `SELECT 1
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
      WHERE lower(o.ship_email) = lower($1)
        AND oi.product_id = $2
        AND o.status NOT IN ('awaiting_payment', 'pending', 'cancelled')
      LIMIT 1`,
    [email, Number(productId)]
  );
  return rows.length > 0;
}

// List reviews for a product, newest first.
export async function getProductReviews(productId) {
  const { rows } = await query(
    "SELECT * FROM product_reviews WHERE product_id = $1 ORDER BY created_at DESC, id DESC",
    [Number(productId)]
  );
  return rows.map(mapReview);
}

// Average rating + count for a product.
export async function getReviewStats(productId) {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS count, AVG(rating) AS avg FROM product_reviews WHERE product_id = $1",
    [Number(productId)]
  );
  const count = rows[0].count;
  const avg = rows[0].avg == null ? 0 : Math.round(Number(rows[0].avg) * 10) / 10;
  return { count, average: avg };
}

// Create OR update a review (validated + purchase-verified in the route).
// One review per email per product: a repeat submission from the same email
// updates the existing review (name/rating/comment/date) rather than duplicating.
// Returns { review, updated } where `updated` is true when an existing row was replaced.
export async function createReview(productId, { reviewerName, email, rating, comment }) {
  const { rows } = await query(
    `INSERT INTO product_reviews (product_id, reviewer_name, reviewer_email, rating, comment)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (product_id, lower(reviewer_email)) DO UPDATE
       SET reviewer_name = EXCLUDED.reviewer_name,
           rating        = EXCLUDED.rating,
           comment       = EXCLUDED.comment,
           created_at     = now()
     RETURNING *, (xmax <> 0) AS was_update`,
    [Number(productId), reviewerName, email, rating, comment]
  );
  const row = rows[0];
  return { review: mapReview(row), updated: row.was_update === true };
}


// ============================================================================
// Promo / discount codes
// ============================================================================
function mapPromo(row) {
  return {
    id: row.id,
    code: row.code,
    discountType: row.discount_type,
    discountValue: Number(row.discount_value),
    maxUses: row.max_uses == null ? null : Number(row.max_uses),
    usedCount: Number(row.used_count),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    isActive: row.is_active,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

// Compute the discount amount for a promo against a subtotal.
// Percentage → subtotal * value/100; fixed → value (capped at subtotal).
// Never negative, never more than the subtotal.
export function computePromoDiscount(promo, subtotal) {
  const sub = Number(subtotal) || 0;
  let amount = promo.discountType === "percentage"
    ? sub * (Number(promo.discountValue) / 100)
    : Number(promo.discountValue);
  amount = Math.round(amount * 100) / 100;
  return Math.max(0, Math.min(amount, sub));
}

// Fetch a promo by code (case-insensitive). Optional client for use in a tx.
export async function findPromoByCode(code, client = null) {
  const runner = client || { query };
  const q = "SELECT * FROM promo_codes WHERE lower(code) = lower($1)";
  const { rows } = client ? await client.query(q, [code]) : await query(q, [code]);
  return rows[0] ? mapPromo(rows[0]) : null;
}

// Validate a code against a subtotal WITHOUT redeeming it.
// Returns { valid, reason?, discount?, promo? }.
export async function validatePromo(code, subtotal) {
  const trimmed = String(code || "").trim();
  if (!trimmed) return { valid: false, reason: "Please enter a promo code." };
  const promo = await findPromoByCode(trimmed);
  if (!promo) return { valid: false, reason: "This promo code doesn't exist." };
  if (!promo.isActive) return { valid: false, reason: "This promo code is no longer active." };
  if (promo.expiresAt && new Date(promo.expiresAt).getTime() < Date.now()) {
    return { valid: false, reason: "This promo code has expired." };
  }
  if (promo.maxUses != null && promo.usedCount >= promo.maxUses) {
    return { valid: false, reason: "This promo code has reached its usage limit." };
  }
  const discount = computePromoDiscount(promo, subtotal);
  return { valid: true, discount, promo };
}

// Atomically redeem a promo INSIDE an existing transaction client. Re-checks
// validity + increments used_count in one guarded UPDATE to avoid races.
// Returns { ok, reason?, promo? }.
export async function redeemPromo(client, code, subtotal) {
  const promo = await findPromoByCode(code, client);
  if (!promo) return { ok: false, reason: "This promo code doesn't exist." };
  // Guarded increment: only succeeds if still active, not expired, and under the cap.
  const { rows } = await client.query(
    `UPDATE promo_codes
        SET used_count = used_count + 1
      WHERE id = $1
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > now())
        AND (max_uses IS NULL OR used_count < max_uses)
      RETURNING *`,
    [promo.id]
  );
  if (rows.length === 0) {
    return { ok: false, reason: "This promo code is no longer valid. Please remove it and try again." };
  }
  const updated = mapPromo(rows[0]);
  return { ok: true, promo: updated, discount: computePromoDiscount(updated, subtotal) };
}

// ---- Admin CRUD ----
export async function listPromoCodes() {
  const { rows } = await query("SELECT * FROM promo_codes ORDER BY created_at DESC, id DESC");
  return rows.map(mapPromo);
}

export async function createPromoCode(data) {
  const { rows } = await query(
    `INSERT INTO promo_codes (code, discount_type, discount_value, max_uses, expires_at, is_active)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [data.code, data.discountType, data.discountValue, data.maxUses ?? null,
     data.expiresAt ?? null, data.isActive ?? true]
  );
  return mapPromo(rows[0]);
}

// Partial update (used for the active toggle + edits).
export async function updatePromoCode(id, data) {
  const map = {
    code: "code", discountType: "discount_type", discountValue: "discount_value",
    maxUses: "max_uses", expiresAt: "expires_at", isActive: "is_active",
  };
  const sets = []; const values = []; let i = 1;
  for (const [k, col] of Object.entries(map)) {
    if (data[k] !== undefined) { sets.push(`${col} = $${i++}`); values.push(data[k]); }
  }
  if (sets.length === 0) {
    const { rows } = await query("SELECT * FROM promo_codes WHERE id = $1", [Number(id)]);
    return rows[0] ? mapPromo(rows[0]) : null;
  }
  values.push(Number(id));
  const { rows } = await query(`UPDATE promo_codes SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, values);
  return rows[0] ? mapPromo(rows[0]) : null;
}


// ============================================================================
// Homepage hero banners (carousel slides)
// ============================================================================
function mapBanner(row) {
  if (!row) return null;
  return {
    id: row.id,
    imageUrl: row.image_url || null,
    // Cloudinary asset id for the image above, so it can be deleted when the
    // banner is removed or its image replaced. Null for legacy /uploads images.
    // (Not sensitive: the public_id is part of the delivery URL.)
    imagePublicId: row.cloudinary_public_id || null,
    backgroundColor: row.background_color || null,
    headline: row.headline,
    subtext: row.subtext || "",
    ctaText: row.cta_text || "",
    ctaLink: row.cta_link || "",
    position: Number(row.position),
    isActive: row.is_active,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

// Public storefront view: only active slides, in display order.
export async function listActiveBanners() {
  const { rows } = await query(
    "SELECT * FROM banners WHERE is_active = true ORDER BY position, id"
  );
  return rows.map(mapBanner);
}

// Admin view: every slide, active or not, in display order.
export async function listBanners() {
  const { rows } = await query("SELECT * FROM banners ORDER BY position, id");
  return rows.map(mapBanner);
}

export async function getBanner(id) {
  const { rows } = await query("SELECT * FROM banners WHERE id = $1", [Number(id)]);
  return rows[0] ? mapBanner(rows[0]) : null;
}

// New slides go to the end of the list unless a position is given.
export async function createBanner(data) {
  const { rows } = await query(
    `INSERT INTO banners (image_url, cloudinary_public_id, background_color, headline, subtext, cta_text, cta_link, position, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,
             COALESCE($8, (SELECT COALESCE(MAX(position), -1) + 1 FROM banners)),
             $9)
     RETURNING *`,
    [data.imageUrl ?? null, data.imagePublicId ?? null, data.backgroundColor ?? null, data.headline,
     data.subtext ?? null, data.ctaText ?? null, data.ctaLink ?? null,
     data.position ?? null, data.isActive ?? true]
  );
  return mapBanner(rows[0]);
}

// Partial update — only the provided keys are written.
export async function updateBanner(id, data) {
  const map = {
    imageUrl: "image_url", imagePublicId: "cloudinary_public_id",
    backgroundColor: "background_color", headline: "headline",
    subtext: "subtext", ctaText: "cta_text", ctaLink: "cta_link",
    position: "position", isActive: "is_active",
  };
  const sets = []; const values = []; let i = 1;
  for (const [k, col] of Object.entries(map)) {
    if (data[k] !== undefined) { sets.push(`${col} = $${i++}`); values.push(data[k]); }
  }
  if (sets.length === 0) return getBanner(id);
  values.push(Number(id));
  const { rows } = await query(
    `UPDATE banners SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, values
  );
  return rows[0] ? mapBanner(rows[0]) : null;
}

// Returns the deleted row (so the route can clean up an uploaded file), or null.
export async function deleteBanner(id) {
  const { rows } = await query("DELETE FROM banners WHERE id = $1 RETURNING *", [Number(id)]);
  return rows[0] ? mapBanner(rows[0]) : null;
}

// Rewrite positions from an ordered list of ids, in one transaction.
// Ids not present in the list keep their relative order after the listed ones.
export async function reorderBanners(orderedIds) {
  await withTransaction(async (client) => {
    let pos = 0;
    for (const id of orderedIds) {
      await client.query("UPDATE banners SET position = $1 WHERE id = $2", [pos++, Number(id)]);
    }
    // Push anything not mentioned to the end, preserving its previous order.
    const { rows } = await client.query(
      "SELECT id FROM banners WHERE NOT (id = ANY($1::int[])) ORDER BY position, id",
      [orderedIds.map(Number)]
    );
    for (const row of rows) {
      await client.query("UPDATE banners SET position = $1 WHERE id = $2", [pos++, row.id]);
    }
  });
  return listBanners();
}


// ============================================================================
// Aftersales service (warranty claims + returns/exchanges)
// ============================================================================

// Happy path plus a terminal `rejected` branch, mirroring how orders treat
// `cancelled`. Exported so the routes and the admin UI agree on what's allowed.
export const AFTERSALES_STATUSES = [
  "submitted", "under_review", "approved", "rejected", "processing", "completed",
];
export const AFTERSALES_TYPES = ["warranty_claim", "return_exchange"];

// Which status can follow which. `rejected` and `completed` are terminal.
export const AFTERSALES_TRANSITIONS = {
  submitted:    ["under_review", "rejected"],
  under_review: ["approved", "rejected"],
  approved:     ["processing", "rejected"],
  processing:   ["completed", "rejected"],
  completed:    [],
  rejected:     [],
};

// An order can only be claimed against once it has actually been fulfilled —
// nothing to warranty or return before it ships.
export const AFTERSALES_ELIGIBLE_ORDER_STATUSES = ["shipped", "completed"];

function mapAftersales(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    type: row.type,
    productId: row.product_id ?? null,
    productName: row.product_name ?? null,     // from the admin list/detail join
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    description: row.description,
    // [{ url, publicId }] — publicId is only needed server-side for cleanup.
    photos: Array.isArray(row.photo_urls) ? row.photo_urls : [],
    status: row.status,
    adminNotes: row.admin_notes || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

// AS-<base36 timestamp>-<4 random chars>, matching the VE- order id style.
function newAftersalesId() {
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase().slice(0, 4);
  return `AS-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

// Verify the requester owns the order: the id + email pair must match, the same
// gate the verified-purchase review check uses. Returns null when it doesn't.
export async function findOrderForAftersales(orderId, email) {
  const { rows } = await query(
    `SELECT id, ship_name, ship_email, status, total, created_at
       FROM orders
      WHERE id = $1 AND lower(ship_email) = lower($2)`,
    [String(orderId).trim(), String(email).trim()]
  );
  if (!rows[0]) return null;
  const o = rows[0];
  return {
    id: o.id,
    customerName: o.ship_name,
    customerEmail: o.ship_email,
    status: o.status,
    total: Number(o.total),
    createdAt: o.created_at instanceof Date ? o.created_at.toISOString() : o.created_at,
    // Convenience flag so callers don't re-implement the rule.
    eligible: AFTERSALES_ELIGIBLE_ORDER_STATUSES.includes(o.status),
  };
}

// The order's line items, so the customer can pick which product the request is
// about (and so we can check a submitted product_id really belongs to the order).
export async function getOrderItemsForAftersales(orderId) {
  const { rows } = await query(
    `SELECT oi.product_id, oi.product_name, oi.quantity
       FROM order_items oi
      WHERE oi.order_id = $1
      ORDER BY oi.id`,
    [String(orderId).trim()]
  );
  return rows.map(r => ({
    productId: r.product_id ?? null,
    name: r.product_name,          // snapshotted at order time
    quantity: Number(r.quantity),
  }));
}

// Create a request. Retries on the (vanishingly unlikely) id collision.
export async function createAftersalesRequest(data) {
  const photos = Array.isArray(data.photos) ? data.photos : [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newAftersalesId();
    try {
      const { rows } = await query(
        `INSERT INTO aftersales_requests
           (id, order_id, type, product_id, customer_name, customer_email, description, photo_urls, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'submitted')
         RETURNING *`,
        [id, data.orderId, data.type, data.productId ?? null, data.customerName,
         data.customerEmail, data.description, JSON.stringify(photos)]
      );
      return mapAftersales(rows[0]);
    } catch (err) {
      // 23505 = unique_violation on the primary key → new id, try again.
      if (err.code !== "23505" || attempt === 4) throw err;
    }
  }
  throw new Error("Could not allocate a tracking id.");
}

// Single request, with the product name joined in for display.
export async function getAftersalesRequest(id) {
  const { rows } = await query(
    `SELECT a.*, p.name AS product_name
       FROM aftersales_requests a
       LEFT JOIN products p ON p.id = a.product_id
      WHERE a.id = $1`,
    [String(id).trim()]
  );
  return mapAftersales(rows[0]);
}

// Admin list with optional type/status filters, newest first. Includes a little
// order context so the table is useful without opening every row.
export async function listAftersalesRequests({ type = null, status = null } = {}) {
  const where = [];
  const values = [];
  if (type) { values.push(type); where.push(`a.type = $${values.length}`); }
  if (status) { values.push(status); where.push(`a.status = $${values.length}`); }
  const { rows } = await query(
    `SELECT a.*, p.name AS product_name, o.status AS order_status, o.total AS order_total
       FROM aftersales_requests a
       LEFT JOIN products p ON p.id = a.product_id
       LEFT JOIN orders o ON o.id = a.order_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.created_at DESC, a.id DESC`,
    values
  );
  return rows.map(r => ({
    ...mapAftersales(r),
    orderStatus: r.order_status || null,
    orderTotal: r.order_total == null ? null : Number(r.order_total),
  }));
}

// Counts per status (for the admin filter chips).
export async function getAftersalesStatusCounts() {
  const { rows } = await query(
    "SELECT status, COUNT(*)::int AS n FROM aftersales_requests GROUP BY status"
  );
  const counts = Object.fromEntries(AFTERSALES_STATUSES.map(s => [s, 0]));
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

// Partial update — status and/or admin notes. Transition validity is enforced by
// the route (which knows the current status and can explain what's allowed).
export async function updateAftersalesRequest(id, { status, adminNotes } = {}) {
  const sets = [];
  const values = [];
  if (status !== undefined) { values.push(status); sets.push(`status = $${values.length}`); }
  if (adminNotes !== undefined) { values.push(adminNotes); sets.push(`admin_notes = $${values.length}`); }
  if (sets.length === 0) return getAftersalesRequest(id);
  values.push(String(id).trim());
  const { rows } = await query(
    `UPDATE aftersales_requests SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows[0]) return null;
  // Re-read so the product name join is present in the response.
  return getAftersalesRequest(rows[0].id);
}
