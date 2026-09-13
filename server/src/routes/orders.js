// ---- Orders router: /api/orders ----
import { Router } from "express";
import crypto from "node:crypto";
import * as store from "../store.js";
import { requireAuth } from "../auth.js";
import { createSnapTransaction, getClientConfig, isPaymentEnabled } from "../payment/midtrans.js";

const router = Router();

// Shipping is priced per Jabodetabek kecamatan (shipping_zones) and looked up
// server-side; client-supplied amounts are never trusted. No tax is charged.
const round2 = n => Math.round(n * 100) / 100;

function validateCustomer(c, method = "delivery") {
  const errors = [];
  if (!c || typeof c !== "object") return ["customer object is required"];
  // Contact fields are always required.
  if (typeof c.name !== "string" || c.name.trim().length < 2) errors.push("customer.name is required");
  if (typeof c.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) errors.push("valid customer.email is required");
  if (typeof c.phone !== "string" || c.phone.replace(/\D/g, "").length < 7) errors.push("valid customer.phone is required");
  // Shipping address is only required for delivery orders (pickup skips it).
  // The city/kecamatan is NOT taken from the client — it comes from the selected
  // shipping zone, so a delivery address can never fall outside the coverage.
  if (method === "delivery") {
    if (typeof c.address !== "string" || c.address.trim().length < 4) errors.push("customer.address is required");
    if (typeof c.postal !== "string" || c.postal.trim().length < 3) errors.push("customer.postal is required");
    if (typeof c.country !== "string" || c.country.trim().length < 2) errors.push("customer.country is required");
  }
  return errors;
}

function generateOrderId() {
  return "VE-" + Date.now().toString(36).toUpperCase() + "-" +
    Math.random().toString(36).slice(2, 6).toUpperCase();
}

// GET /api/orders — list all orders (admin only; exposes customer PII)
router.get("/", requireAuth, async (req, res, next) => {
  try {
    res.json(await store.getOrders());
  } catch (err) { next(err); }
});

// GET /api/orders/:id — one order (admin only; exposes customer PII)
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const order = await store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  } catch (err) { next(err); }
});

// PATCH /api/orders/:id/status — update fulfilment status (admin only)
// Sequential flow: needs_shipping → shipped → completed. Cancelled is separate.
const ORDER_STATUSES = ["needs_shipping", "shipped", "completed", "cancelled"];
router.patch("/:id/status", requireAuth, async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Validation failed", details: [`status must be one of: ${ORDER_STATUSES.join(", ")}`] });
    }
    const updated = await store.updateOrderStatus(req.params.id, status);
    if (!updated) return res.status(404).json({ error: "Order not found" });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /api/orders — place an order
router.post("/", async (req, res, next) => {
  try {
    const { customer, items } = req.body || {};

    // Fulfillment method — 'pickup' skips the shipping address + shipping fee.
    const fulfillmentMethod = req.body?.fulfillmentMethod === "pickup" ? "pickup" : "delivery";

    // Validate customer (address requirements relaxed for pickup).
    const customerErrors = validateCustomer(customer, fulfillmentMethod);
    if (customerErrors.length) {
      return res.status(400).json({ error: "Validation failed", details: customerErrors });
    }

    // Validate items shape.
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Validation failed", details: ["items must be a non-empty array"] });
    }

    // Resolve each item against real products; validate stock and quantities.
    const products = await store.getProducts();
    const lineItems = [];
    const stockErrors = [];

    for (const item of items) {
      const qty = Number(item.qty);
      const product = products.find(p => p.id === Number(item.id));
      if (!product) {
        stockErrors.push(`Unknown product id ${item.id}`);
        continue;
      }
      if (!Number.isInteger(qty) || qty < 1) {
        stockErrors.push(`Invalid quantity for "${product.name}"`);
        continue;
      }
      if (qty > product.stock) {
        stockErrors.push(`Insufficient stock for "${product.name}" (requested ${qty}, available ${product.stock})`);
        continue;
      }
      // AUTHORITATIVE pricing: the charged price is the product's effective
      // (promotional) price from the DB — the client-supplied price is ignored.
      const regularPrice = product.price;
      const chargedPrice = store.effectivePrice(product);
      lineItems.push({
        id: product.id,
        name: product.name,
        price: chargedPrice,       // what the customer pays (sale price if on promo)
        regularPrice,              // list price snapshot (for invoice discount line)
        qty,
      });
    }

    if (stockErrors.length) {
      return res.status(409).json({ error: "Order could not be placed", details: stockErrors });
    }

    // Compute authoritative totals server-side from the effective prices.
    const subtotal = round2(lineItems.reduce((s, li) => s + li.price * li.qty, 0));
    // Sale savings vs. regular price (informational; already reflected in subtotal).
    const saleDiscount = round2(lineItems.reduce((s, li) => s + (li.regularPrice - li.price) * li.qty, 0));

    // Promo code — re-validate server-side (never trust a client discount amount).
    // Fast-fail here with a clear 400; the actual atomic redeem happens inside
    // the order transaction (createOrder) so used_count can't be over-consumed.
    const promoCode = typeof req.body?.promoCode === "string" ? req.body.promoCode.trim() : "";
    let promoDiscount = 0;
    if (promoCode) {
      const check = await store.validatePromo(promoCode, subtotal);
      if (!check.valid) {
        return res.status(400).json({ error: check.reason || "Promo code is not valid.", promoInvalid: true });
      }
      promoDiscount = check.discount;
    }

    const discountedSubtotal = round2(Math.max(0, subtotal - promoDiscount));

    // ---- Shipping: per-kecamatan fee from the zone table, never from the client.
    // Pickup is collected in-store → no zone, no fee.
    let shipping = 0;
    let zone = null;
    if (fulfillmentMethod === "delivery") {
      const zoneId = req.body?.shippingZoneId;
      if (zoneId === undefined || zoneId === null || zoneId === "") {
        return res.status(400).json({
          error: "Please choose your delivery area (kecamatan). Delivery is available in Jabodetabek only.",
          shippingZoneInvalid: true,
        });
      }
      // Re-read the zone: it may have been deactivated since the page loaded, or
      // the request may have been tampered with.
      zone = await store.getActiveShippingZone(zoneId);
      if (!zone) {
        return res.status(400).json({
          error: "That delivery area isn't available anymore. Please pick another kecamatan (Jabodetabek only).",
          shippingZoneInvalid: true,
        });
      }
      shipping = round2(zone.shippingFee);
    }

    // Tax was removed from checkout: subtotal → shipping → total.
    const tax = 0;
    const total = round2(discountedSubtotal + shipping);
    // Stored order-level discount = sale savings + promo discount.
    const discount = round2(saleDiscount + promoDiscount);

    const order = {
      id: generateOrderId(),
      createdAt: new Date().toISOString(),
      // Server-generated, unique invoice number + per-order access token so the
      // (unauthenticated) customer can view only their own invoice.
      invoiceNo: await store.nextInvoiceNumber(),
      accessToken: crypto.randomBytes(24).toString("hex"),
      customer: {
        name: customer.name.trim(),
        email: customer.email.trim(),
        phone: customer.phone.trim(),
        // Address fields are optional for pickup → default to empty strings.
        address: (customer.address || "").trim(),
        // City + kecamatan are snapshotted from the verified zone, not the client.
        city: zone ? zone.cityName : (customer.city || "").trim(),
        district: zone ? zone.districtName : null,
        postal: (customer.postal || "").trim(),
        country: (customer.country || "").trim(),
      },
      shippingZoneId: zone ? zone.id : null,
      fulfillmentMethod,
      promoCode: promoCode || null,
      promoDiscount,
      items: lineItems,
      amounts: { subtotal, discount, shipping, tax, total },
      // If an online payment is required, the order waits for payment and only
      // enters the fulfilment pipeline (needs_shipping) once the Midtrans
      // webhook confirms settlement. Without a gateway (demo), it's treated as
      // paid immediately and goes straight to needs_shipping.
      status: isPaymentEnabled() ? "awaiting_payment" : "needs_shipping",
    };

    // Persist the order (customer upsert + items + stock decrement, atomically).
    let saved;
    try {
      saved = await store.createOrder(order);
    } catch (e) {
      // Promo became invalid between validation and placement (race) → clear 400.
      if (e && e.promoInvalid) {
        return res.status(400).json({ error: e.message, promoInvalid: true });
      }
      throw e;
    }

    // Create the Midtrans Snap transaction AFTER the order is persisted, using
    // the order's own id as order_id and the SERVER-computed total as
    // gross_amount. The frontend uses the returned token to open the QRIS popup.
    //
    // Gateway errors are non-fatal: the order is already valid (stock reserved,
    // totals fixed). We record the payment state and let the client retry
    // payment rather than losing the order.
    let snap = null;
    if (isPaymentEnabled()) {
      try {
        snap = await createSnapTransaction(saved);
        saved = await store.setOrderPayment(saved.id, {
          token: snap?.token ?? null,
          redirectUrl: snap?.redirectUrl ?? null,
          status: "pending",
        });
      } catch (payErr) {
        console.error(`Midtrans Snap creation failed for order ${saved.id}:`, payErr?.message || payErr);
        // Leave the order in place; surface a soft warning to the client.
        saved.paymentError = "Payment could not be initialised. You can retry payment.";
      }
    } else {
      // No gateway configured — mark the payment state so it's explicit.
      saved = await store.setOrderPayment(saved.id, { status: "unconfigured" });
    }

    res.status(201).json({
      ...saved,
      // Payment info for the frontend Snap popup.
      snapToken: snap?.token ?? null,
      redirectUrl: snap?.redirectUrl ?? null,
      midtransClientKey: getClientConfig().clientKey || null,
      midtransProduction: getClientConfig().isProduction,
    });
  } catch (err) { next(err); }
});

export default router;
