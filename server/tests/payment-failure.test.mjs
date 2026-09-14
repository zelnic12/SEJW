// Regression test: a failed Midtrans Snap setup must never yield a paid or
// confirmed order.
//
// The bug this guards against: when snap.createTransaction() failed, the route
// logged the error and still answered 201 with snapToken: null. The frontend read
// a missing token as "no gateway configured", cleared the cart and rendered
// "Payment received — thank you!" — so the customer reached a confirmation
// screen without ever paying.
//
// Run it against a throwaway database:
//   npm run migrate && npm run seed && npm run seed:admin
//   npm run test:payment-failure
//
// No real Midtrans account is needed. The gateway is switched on with a stub key
// and Snap.createTransaction is replaced with a fake that fails on demand, which
// is the automated equivalent of "temporarily configure an invalid key".

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import zlib from "node:zlib";

const SERVER = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = dirname(SERVER);
const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;

// ---- 1. Enable the gateway BEFORE anything imports midtrans.js -------------
// midtrans.js builds its Snap client at module-evaluation time from process.env,
// so these have to be set before that module is first imported.
process.env.MIDTRANS_SERVER_KEY = "SB-Mid-server-STUB-KEY";
process.env.MIDTRANS_CLIENT_KEY = "SB-Mid-client-STUB-KEY";
process.env.MIDTRANS_IS_PRODUCTION = "false";

// ---- 2. Make Snap fail on demand ------------------------------------------
// The Snap client is module-private, so the seam is the prototype. midtrans-client
// is CommonJS, so requiring it here yields the very same object midtrans.js gets.
const midtransClient = createRequire(join(SERVER, "package.json"))("midtrans-client");

// "throw"   → gateway rejects (bad key, 401, network error)
// "notoken" → gateway resolves 200 but without a token (unexpected response shape)
// "ok"      → issues a token, for the happy-path control
let snapMode = "throw";
let createCalls = 0;
midtransClient.Snap.prototype.createTransaction = async function (parameter) {
  createCalls++;
  if (snapMode === "throw") {
    const err = new Error("Midtrans API error: 401 Unauthorized (stubbed invalid key)");
    err.httpStatusCode = "401";
    throw err;
  }
  if (snapMode === "notoken") {
    return { redirect_url: "https://app.sandbox.midtrans.com/snap/v2/vtweb/stub" };
  }
  return {
    token: "STUB-SNAP-TOKEN-" + parameter.transaction_details.order_id,
    redirect_url: "https://app.sandbox.midtrans.com/snap/v2/vtweb/stub",
  };
};

// ---- 3. Boot the real server ---------------------------------------------
const { pool } = await import(join(SERVER, "src/db/pool.js"));
const { isPaymentEnabled } = await import(join(SERVER, "src/payment/midtrans.js"));
const store = await import(join(SERVER, "src/store.js"));
await import(join(SERVER, "src/index.js"));
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 250));
}

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const { token: jwt } = await (await fetch(`${BASE}/api/auth/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: process.env.ADMIN_USERNAME || "admin",
    password: process.env.ADMIN_PASSWORD || "admin123",
  }),
})).json();
const AUTH = { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" };

const zones = (await (await fetch(`${BASE}/api/shipping-zones`)).json()).zones;
const products = await (await fetch(`${BASE}/api/products`)).json();
const P = products.find(p => p.stock > 3);
await pool.query("UPDATE products SET stock = 100 WHERE id = $1", [P.id]);

const CUSTOMER = {
  name: "Test Pembeli", email: "payfail@example.com", phone: "0812-3456-7890",
  address: "Jl. Sudirman No. 12", postal: "12190", country: "Indonesia",
};

const placeOrder = async (qty = 1) => {
  const res = await fetch(`${BASE}/api/orders`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer: CUSTOMER, items: [{ id: P.id, qty }],
      fulfillmentMethod: "delivery", shippingZoneId: zones[0].id,
    }),
  });
  return { status: res.status, body: await res.json() };
};
const stockOf = async () =>
  (await pool.query("SELECT stock FROM products WHERE id = $1", [P.id])).rows[0].stock;
const dbOrder = async id => (await pool.query(
  "SELECT status, payment_status, payment_token, payment_redirect_url FROM orders WHERE id = $1", [id]
)).rows[0];
const bellCount = async id => (await pool.query(
  "SELECT COUNT(*)::int AS n FROM admin_notifications WHERE type = 'new_order' AND reference_id = $1",
  [id])).rows[0].n;
// A 201 spreads the saved order (id on `id`); a 502 is an error envelope (`orderId`).
const idOf = body => body.orderId ?? body.id;

// ---------------------------------------------------------------------------
// Guard the guard: if the gateway weren't enabled, every assertion below would
// pass for the wrong reason (the route would skip payment entirely).
console.log("\n=== 0. THE GATEWAY IS ENABLED, SO THE FAILURE PATH IS REACHABLE ===");
check("isPaymentEnabled() is true", isPaymentEnabled() === true);

// ---------------------------------------------------------------------------
console.log("\n=== 1. createTransaction THROWS → the order must not look paid ===");
let failedId;
{
  snapMode = "throw";
  const before = await stockOf();
  const callsBefore = createCalls;

  const r = await placeOrder(2);
  // idOf, not body.orderId: if the route regresses to answering 201 we still want
  // to find the order and report what state it was actually left in.
  failedId = idOf(r.body);

  check("Snap creation was attempted", createCalls === callsBefore + 1, `${createCalls - callsBefore}`);
  check("the API does NOT answer 2xx", r.status >= 400, `${r.status}`);
  check("the API answers 502 (upstream gateway failed)", r.status === 502, `${r.status}`);
  check("the response is flagged as a payment failure", r.body.paymentFailed === true,
    JSON.stringify(r.body.paymentFailed));
  check("a customer-facing Indonesian error is returned",
    r.body.error === "Gagal memproses pembayaran, coba lagi atau hubungi kami.", JSON.stringify(r.body.error));
  check("no snapToken is handed back", !r.body.snapToken, JSON.stringify(r.body.snapToken));
  check("the order id is reported for support/tracing",
    typeof r.body.orderId === "string" && r.body.orderId.startsWith("VE-"),
    JSON.stringify(r.body.orderId));

  const row = (await dbOrder(failedId)) || {};
  check("payment_status is 'failed' — not paid, not left pending",
    row.payment_status === "failed", row.payment_status);
  check("the order is 'cancelled', so admin queues stay truthful",
    row.status === "cancelled", row.status);
  check("no stale payment token is left behind",
    row.payment_token === null && row.payment_redirect_url === null, JSON.stringify(row));
  check("reserved stock was released", (await stockOf()) === before, `${before} → ${await stockOf()}`);
  check("no 'new order' notification was raised", (await bellCount(failedId)) === 0);
}

// ---------------------------------------------------------------------------
console.log("\n=== 2. THE FAILED ORDER READS AS FAILED EVERYWHERE ===");
{
  const detail = await (await fetch(`${BASE}/api/orders/${failedId}`, { headers: AUTH })).json();
  check("admin detail shows cancelled + failed",
    detail.status === "cancelled" && detail.paymentStatus === "failed",
    `${detail.status}/${detail.paymentStatus}`);
  check("the cancellation is recorded in the status history",
    Array.isArray(detail.statusHistory) && detail.statusHistory.some(h => h.status === "cancelled"),
    JSON.stringify(detail.statusHistory));

  // The confirmation screen links the invoice with a per-order access token, so
  // the customer can reach these — they must not claim the order was paid.
  const inv = await (await fetch(`${BASE}/api/orders/${failedId}/invoice`, { headers: AUTH })).json();
  const invPay = inv.order?.paymentStatus ?? inv.paymentStatus;
  check("invoice JSON does not say 'paid'", invPay !== "paid", JSON.stringify(invPay));
  check("invoice JSON reports the real payment state", invPay === "failed", JSON.stringify(invPay));

  // Pull the drawn text out of the PDF: inflate each content stream, then decode
  // the hex glyph runs inside its TJ arrays.
  const pdfRes = await fetch(`${BASE}/api/orders/${failedId}/invoice/pdf`, { headers: AUTH });
  const raw = Buffer.from(await pdfRes.arrayBuffer()).toString("latin1");
  let drawn = "";
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const s = m.index + m[0].length, e = raw.indexOf("endstream", s);
    if (e < 0) continue;
    try { drawn += zlib.inflateSync(Buffer.from(raw.slice(s, e), "latin1")).toString("latin1"); } catch { /* not a flate stream */ }
  }
  const words = (drawn.match(/\[[^\]]*\]\s*TJ/g) || []).map(run =>
    (run.match(/<([0-9a-fA-F]+)>/g) || [])
      .map(h => Buffer.from(h.slice(1, -1), "hex").toString("latin1")).join("")
  ).join(" ");

  check("PDF text could be extracted (sanity check on this test)",
    /invoice number/i.test(words) && /status/i.test(words), words.slice(0, 160));
  check("the invoice PDF is NOT stamped PAID", !/\bPAID\b/.test(words),
    (words.match(/.{0,26}PAID.{0,10}/g) || []).join(" | "));
  check("the invoice PDF shows the failed state", /FAILED/.test(words),
    (words.match(/.{0,20}(CANCELLED|FAILED).{0,10}/g) || []).join(" | "));
}

// ---------------------------------------------------------------------------
console.log("\n=== 3. A RESOLVED-BUT-TOKENLESS RESPONSE IS ALSO A FAILURE ===");
{
  snapMode = "notoken";
  const before = await stockOf();
  const r = await placeOrder(1);
  check("a 200 without a token still yields 502", r.status === 502, `${r.status}`);
  check("flagged as a payment failure", r.body.paymentFailed === true);
  const row = (await dbOrder(idOf(r.body))) || {};
  check("order cancelled + payment failed",
    row.status === "cancelled" && row.payment_status === "failed",
    `${row.status}/${row.payment_status}`);
  check("stock released here too", (await stockOf()) === before, `${before} → ${await stockOf()}`);
}

// ---------------------------------------------------------------------------
console.log("\n=== 4. DB INVARIANTS: 'PAID' ONLY EVER COMES FROM THE WEBHOOK ===");
{
  const q = async sql => (await pool.query(sql)).rows;
  const [{ n: unbacked }] = await q(
    "SELECT COUNT(*)::int AS n FROM orders WHERE payment_status = 'paid' AND payment_txn_id IS NULL");
  check("no order is 'paid' without a gateway transaction id", unbacked === 0, `${unbacked}`);

  const contradictions = await q(`SELECT status, payment_status, COUNT(*)::int AS n FROM orders
     WHERE payment_status = 'failed' AND status <> 'cancelled' GROUP BY 1,2`);
  check("every payment-failed order is cancelled", contradictions.length === 0,
    JSON.stringify(contradictions));

  const [{ n: paid }] = await q("SELECT COUNT(*)::int AS n FROM orders WHERE payment_status = 'paid'");
  check("no order became 'paid' during the failure cases", paid === 0, `${paid}`);
}

// ---------------------------------------------------------------------------
console.log("\n=== 5. CONTROL: THE HAPPY PATH IS UNAFFECTED ===");
{
  snapMode = "ok";
  const before = await stockOf();
  const r = await placeOrder(1);
  check("order placed → 201", r.status === 201, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  check("a Snap token is returned", String(r.body.snapToken).startsWith("STUB-SNAP-TOKEN-"),
    JSON.stringify(r.body.snapToken));
  check("paymentRequired is true, so the client opens the popup",
    r.body.paymentRequired === true, JSON.stringify(r.body.paymentRequired));

  const okId = idOf(r.body);
  check("a placeable order DOES notify the admin", (await bellCount(okId)) === 1);

  const row = (await dbOrder(okId)) || {};
  check("the order awaits payment rather than claiming to be paid",
    row.status === "awaiting_payment" && row.payment_status === "pending",
    `${row.status}/${row.payment_status}`);
  check("the token is persisted for the popup", row.payment_token === r.body.snapToken, row.payment_token);
  check("stock IS held for a payable order", (await stockOf()) === before - 1,
    `${before} → ${await stockOf()}`);

  // Only the signature-verified webhook may flip an order to paid.
  await store.applyPaymentNotification(okId, {
    paymentStatus: "paid", orderStatus: "needs_shipping", txnId: "stub-txn-1",
  });
  const after = await dbOrder(okId);
  check("the webhook is what marks it paid",
    after.payment_status === "paid" && after.status === "needs_shipping",
    `${after.status}/${after.payment_status}`);
}

// ---------------------------------------------------------------------------
// The storefront has no test runner, so these few static checks stand in for the
// browser-side half of the fix. They're intentionally narrow: each one pins a
// specific way the old bug could come back.
console.log("\n=== 6. STATIC: NO SILENT-SUCCESS PATH REMAINS IN THE FRONTEND ===");
{
  const read = f => readFile(join(REPO, f), "utf8");
  const checkout = await read("checkout.js");
  // Strip comments — prose explaining why pay() was removed mentions it legitimately.
  const live = checkout.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  check("a missing token shows the error instead of confirming",
    /Gagal memproses pembayaran, coba lagi atau hubungi kami/.test(live));
  check("confirmation is gated on an explicit paymentRequired === false",
    /body\.paymentRequired === false/.test(live));
  check("no provider can fake a successful charge client-side",
    !/success:\s*true/.test(live) && !/transactionId/.test(live) && !/async pay\b/.test(live),
    (live.match(/.*(success:\s*true|transactionId|async pay\b).*/g) || []).join(" | "));
  check("an unpaid order is never told 'Payment received'",
    /unpaid: \{[\s\S]{0,80}title: "Order received/.test(live));

  const inv = await read("server/src/routes/invoices.js");
  check("the invoice API does not hardcode paid", !/paymentStatus: "paid"/.test(inv));
  const pdfSrc = await read("server/src/invoice/pdf.js");
  check("the invoice PDF does not hardcode PAID", !/· PAID`/.test(pdfSrc));
}

// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
await pool.end();
process.exit(fail === 0 ? 0 : 1);
