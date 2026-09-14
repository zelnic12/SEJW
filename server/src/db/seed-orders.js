// ---- Demo orders seed ----
// Generates realistic orders spread over the last ~60 days so the admin
// dashboard analytics (revenue, best-sellers, category/brand splits, and the
// daily/weekly/monthly charts) have meaningful data to display.
//
// Idempotent-ish: clears existing orders/customers first, then inserts a fresh
// randomized set. Does NOT change product stock (kept simple for demo data).

import 'dotenv/config';
import { pathToFileURL } from "node:url";
import { pool, withTransaction } from "./pool.js";
import { refuseInProduction } from "./demo-guard.js";

const round2 = n => Math.round(n * 100) / 100;

const NAMES = [
  "Jane Doe", "Sam Buyer", "Alex Kim", "Maria Lopez", "Chen Wei", "Omar Farouk",
  "Priya Patel", "Liam Murphy", "Nina Rossi", "Tom Becker", "Yuki Tanaka", "Grace Okafor",
];
// Delivery only covers Jabodetabek, so demo orders ship inside it.
const COUNTRY = "Indonesia";

const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = arr => arr[rand(0, arr.length - 1)];

const NOW = new Date();

// Payment state that matches the fulfilment stage — an order can't be shipped
// without having been paid, and the admin order detail shows both side by side.
function paymentFor(status) {
  switch (status) {
    case "awaiting_payment": return { paymentStatus: "pending", paid: false };
    case "cancelled":        return { paymentStatus: pick(["expired", "cancelled", "failed"]), paid: false };
    default:                 return { paymentStatus: "paid", paid: true };
  }
}

const txnId = () =>
  `${rand(100000, 999999)}-${Math.random().toString(36).slice(2, 6)}-demo`;

// The stages an order must have passed through to reach `status`. Used to give
// demo orders a believable status timeline rather than a single point.
function stagesTo(status) {
  switch (status) {
    case "awaiting_payment": return ["awaiting_payment"];
    case "shipped":   return ["needs_shipping", "shipped"];
    case "completed": return ["needs_shipping", "shipped", "completed"];
    case "cancelled": return ["needs_shipping", "cancelled"];
    default:          return ["needs_shipping"];
  }
}

function orderId(d) {
  return "VE-" + d.getTime().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
}

export async function seedOrders(count = 120) {
  const { rows: products } = await pool.query("SELECT id, name, brand, price FROM products");
  if (products.length === 0) throw new Error("No products found — run the product seed first.");

  // Real shipping zones, so demo orders carry a kecamatan and its actual fee.
  const { rows: zones } = await pool.query(
    "SELECT id, city_name, district_name, shipping_fee FROM shipping_zones WHERE is_active = true"
  );
  if (zones.length === 0) throw new Error("No active shipping zones — run the migrations first.");

  await withTransaction(async (client) => {
    await client.query(
      "TRUNCATE order_status_history, order_items, orders, customers RESTART IDENTITY CASCADE"
    );

    for (let i = 0; i < count; i++) {
      // Random date within the last 60 days (weighted slightly toward recent).
      const daysAgo = Math.floor(Math.pow(Math.random(), 1.5) * 60);
      const created = new Date();
      created.setDate(created.getDate() - daysAgo);
      created.setHours(rand(8, 21), rand(0, 59), rand(0, 59), 0);
      // Picking a shop-hours time can land later than "now" for a same-day order,
      // which would put the status timeline before the order was placed.
      if (created > NOW) created.setDate(created.getDate() - 1);

      // 1–4 distinct line items.
      const nItems = rand(1, 4);
      const chosen = new Map();
      for (let k = 0; k < nItems; k++) {
        const p = pick(products);
        chosen.set(p.id, { product: p, qty: (chosen.get(p.id)?.qty || 0) + rand(1, 3) });
      }
      const items = [...chosen.values()];

      const subtotal = round2(items.reduce((s, it) => s + Number(it.product.price) * it.qty, 0));
      // Roughly one in five is collected in store, so both fulfilment paths show
      // up in the admin. Pickup carries no zone and no shipping fee, matching the
      // live checkout.
      const isPickup = Math.random() < 0.2;
      // Zone-based shipping, no tax — same as the live checkout.
      const zone = pick(zones);
      const shipping = isPickup ? 0 : round2(Number(zone.shipping_fee));
      const tax = 0;
      const total = round2(subtotal + shipping);

      const name = pick(NAMES);
      const email = name.toLowerCase().replace(/[^a-z]/g, ".") + "@example.com";

      const { rows: cust } = await client.query(
        `INSERT INTO customers (name, email, phone, address, city, postal, country)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name, email, `08${rand(10000000, 99999999)}`, `Jl. Demo No. ${rand(1, 199)}`,
         zone.city_name, String(rand(10000, 19999)), COUNTRY]
      );
      const customerId = cust[0].id;

      const id = orderId(created);
      // Weighted toward the earlier stages; matches the new fulfilment flow.
      // A few sit in awaiting_payment (customer never finished the QRIS payment)
      // so that status page isn't empty in a demo.
      const status = pick([
        "awaiting_payment",
        "needs_shipping", "needs_shipping", "needs_shipping",
        "shipped", "shipped", "completed", "completed", "cancelled",
      ]);

      const pay = paymentFor(status);

      await client.query(
        `INSERT INTO orders
           (id, customer_id, ship_name, ship_email, ship_phone, ship_address,
            ship_city, ship_district, ship_postal, ship_country, shipping_zone_id,
            subtotal, shipping, tax, total, status, created_at, fulfillment_method,
            payment_status, payment_txn_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [id, customerId, name, email, `08${rand(10000000, 99999999)}`,
         // Pickup orders have no shipping address, exactly as checkout stores them.
         isPickup ? "" : `Jl. Demo No. ${rand(1, 199)}`,
         isPickup ? "" : zone.city_name,
         isPickup ? null : zone.district_name,
         isPickup ? "" : String(rand(10000, 19999)),
         isPickup ? "" : COUNTRY,
         isPickup ? null : zone.id,
         subtotal, shipping, tax, total, status, created.toISOString(),
         isPickup ? "pickup" : "delivery",
         pay.paymentStatus, pay.paid ? txnId() : null]
      );

      for (const it of items) {
        await client.query(
          `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, it.product.id, it.product.name, it.product.price, it.qty]
        );
      }

      // Walk the order through the stages it must have passed to reach `status`,
      // so the demo data exercises the detail view's timeline instead of every
      // order looking like it predates status tracking.
      // Accumulate the offset so each stage is strictly later than the previous
      // one; clamp only what gets written, so a recent order's later stages pile
      // up at "now" instead of landing in the future.
      let at = new Date(created);
      for (const [n, stage] of stagesTo(status).entries()) {
        if (n > 0) at = new Date(at.getTime() + rand(4, 30) * 3600_000);
        await client.query(
          `INSERT INTO order_status_history (order_id, status, changed_at) VALUES ($1,$2,$3)`,
          [id, stage, (at > NOW ? NOW : at).toISOString()]
        );
      }
    }
  });

  console.log(`✓ Seeded ${count} demo orders over the last 60 days`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // This clears existing orders and customers — never against a production database.
  refuseInProduction("the demo order seed");
  const count = Number(process.argv[2]) || 120;
  seedOrders(count)
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(err => { console.error("Order seed failed:", err); process.exit(1); });
}
