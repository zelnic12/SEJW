// ---- Checkout page logic ----
const VE = window.VoltEdge;
const $ = sel => document.querySelector(sel);
const API_BASE = "/api";

// Selected fulfillment method: 'delivery' (default) or 'pickup'. Pickup skips
// the shipping address and the shipping fee (server recomputes authoritatively).
let fulfillmentMethod = "delivery";

// Applied promo code (client-side, for display). The SERVER re-validates and
// recomputes the discount authoritatively when the order is placed.
// { code, discount } or null.
let appliedPromo = null;

/* =========================================================================
 * Payment abstraction
 * -------------------------------------------------------------------------
 * A PaymentProvider isolates payment handling so a real gateway (Stripe,
 * PayPal, Adyen, etc.) can be dropped in later WITHOUT touching the checkout
 * flow. To integrate a gateway:
 *   1. Implement a provider with the same three methods below.
 *   2. Swap the `activeProvider` assignment near the bottom of this file.
 * The checkout flow only ever talks to this interface, never to a gateway
 * directly.
 *
 *   mount(el, ctx)   -> render payment UI into `el` (card fields, wallet, …)
 *   validate()       -> { ok: boolean, message?: string }
 *   pay(order)       -> Promise<{ success, transactionId?, error? }>
 * ========================================================================= */

// Default demo provider: no real charge, just simulates a successful payment.
const MockPaymentProvider = {
  id: "mock",
  mount(el /*, ctx */) {
    el.innerHTML = `
      <div class="payment-demo">
        <span class="payment-demo-badge">Demo</span>
        <p>No real payment gateway is connected yet. Placing the order will
           simulate a successful payment. A gateway can be integrated here later.</p>
      </div>`;
  },
  validate() {
    return { ok: true };
  },
  async pay(order) {
    // Simulate network latency of a real gateway call.
    await new Promise(r => setTimeout(r, 900));
    return {
      success: true,
      transactionId: "TXN-" + Math.random().toString(36).slice(2, 10).toUpperCase(),
      order,
    };
  },
};

/* Example scaffold for a future real provider — kept as a template, unused.
const StripePaymentProvider = {
  id: "stripe",
  mount(el, ctx) { /* mount Stripe Elements into el * / },
  validate() { /* check the card element * / return { ok: true }; },
  async pay(order) {
    // const res = await fetch("/api/create-payment-intent", { ... });
    // const { clientSecret } = await res.json();
    // const result = await stripe.confirmCardPayment(clientSecret, { ... });
    // return { success: !result.error, transactionId: result.paymentIntent?.id };
  },
};
*/

// The provider currently in use. Swap this line to change gateways.
const activeProvider = MockPaymentProvider;

/* =========================================================================
 * Order summary
 * ========================================================================= */
function renderSummary() {
  const base = VE.computeTotals();
  const { entries, subtotal } = base;

  // Empty cart: hide the form, show a notice.
  if (entries.length === 0) {
    $("#checkoutGrid").hidden = true;
    $("#emptyCart").hidden = false;
    return { empty: true };
  }
  $("#checkoutGrid").hidden = false;
  $("#emptyCart").hidden = true;

  // Mirror the server's math for DISPLAY (server stays authoritative on placement):
  // subtotal → minus promo discount → shipping (free for pickup) + tax off the
  // discounted base.
  const isPickup = fulfillmentMethod === "pickup";
  const promoDiscount = appliedPromo ? Math.min(appliedPromo.discount, subtotal) : 0;
  const discountedSubtotal = Math.max(0, +(subtotal - promoDiscount).toFixed(2));
  const shipping = isPickup
    ? 0
    : (discountedSubtotal === 0 ? 0 : (discountedSubtotal >= VE.CONFIG.FREE_SHIPPING_THRESHOLD ? 0 : VE.CONFIG.SHIPPING_FEE));
  const tax = +(discountedSubtotal * VE.CONFIG.TAX_RATE).toFixed(2);
  const total = +(discountedSubtotal + shipping + tax).toFixed(2);

  $("#summaryItems").innerHTML = entries.map(({ product, qty }) => `
    <div class="summary-item">
      <span class="summary-item-emoji">${product.emoji}</span>
      <div class="summary-item-info">
        <span class="summary-item-name">${VE.esc(product.name)}</span>
        <span class="summary-item-qty">Qty ${qty} × ${VE.money(product.price)}</span>
      </div>
      <strong>${VE.money(product.price * qty)}</strong>
    </div>
  `).join("");

  $("#sumSubtotal").textContent = VE.money(subtotal);
  // Promo discount row (only when a code is applied).
  const discRow = $("#sumDiscountRow");
  if (discRow) {
    discRow.hidden = !appliedPromo || promoDiscount <= 0;
    if (appliedPromo) {
      $("#sumDiscountLabel").textContent = `Discount (${appliedPromo.code})`;
      $("#sumDiscount").textContent = `− ${VE.money(promoDiscount)}`;
    }
  }
  // Hide the shipping row entirely for pickup (no shipping fee at all).
  const shipRow = $("#sumShipRow");
  if (shipRow) shipRow.hidden = isPickup;
  $("#sumShipping").textContent = shipping === 0 ? "Free" : VE.money(shipping);
  $("#sumShipLabel").textContent =
    discountedSubtotal > 0 && discountedSubtotal < VE.CONFIG.FREE_SHIPPING_THRESHOLD
      ? `Shipping (free over ${VE.money(VE.CONFIG.FREE_SHIPPING_THRESHOLD)})`
      : "Shipping";
  $("#sumTax").textContent = VE.money(tax);
  $("#sumTotal").textContent = VE.money(total);
  $("#payAmount").textContent = VE.money(total);

  return { empty: false, subtotal, shipping, tax, total, entries, promoDiscount };
}

/* =========================================================================
 * Form validation
 * ========================================================================= */
const VALIDATORS = {
  name: v => v.trim().length >= 2 || "Please enter your full name.",
  email: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) || "Enter a valid email address.",
  phone: v => (v.replace(/[^\d]/g, "").length >= 7) || "Enter a valid phone number.",
  address: v => v.trim().length >= 4 || "Enter your street address.",
  city: v => v.trim().length >= 2 || "Enter your city.",
  postal: v => v.trim().length >= 3 || "Enter a postal / ZIP code.",
  country: v => v.trim().length >= 2 || "Enter your country.",
};

const FIELD_IDS = {
  name: "fName", email: "fEmail", phone: "fPhone",
  address: "fAddress", city: "fCity", postal: "fPostal", country: "fCountry",
};

function setFieldError(fieldId, message) {
  const input = document.getElementById(fieldId);
  const errEl = document.querySelector(`[data-error-for="${fieldId}"]`);
  if (message) {
    input.classList.add("invalid");
    input.setAttribute("aria-invalid", "true");
    errEl.textContent = message;
  } else {
    input.classList.remove("invalid");
    input.removeAttribute("aria-invalid");
    errEl.textContent = "";
  }
}

// Address fields are only validated for delivery orders.
const ADDRESS_FIELDS = ["address", "city", "postal", "country"];

function collectAndValidate() {
  const data = {};
  let firstInvalid = null;
  const isPickup = fulfillmentMethod === "pickup";

  for (const [key, id] of Object.entries(FIELD_IDS)) {
    const value = document.getElementById(id).value;
    data[key] = value.trim();
    // Skip address validation for pickup (fields are hidden).
    if (isPickup && ADDRESS_FIELDS.includes(key)) { setFieldError(id, ""); continue; }
    const result = VALIDATORS[key](value);
    if (result !== true) {
      setFieldError(id, result);
      if (!firstInvalid) firstInvalid = id;
    } else {
      setFieldError(id, "");
    }
  }

  return { valid: !firstInvalid, data, firstInvalid };
}

/* =========================================================================
 * Place order flow
 * ========================================================================= */
function buildOrder(customer, totals) {
  return {
    id: "VE-" + Date.now().toString(36).toUpperCase() + "-" +
        Math.random().toString(36).slice(2, 6).toUpperCase(),
    createdAt: new Date().toISOString(),
    customer,
    items: totals.entries.map(({ product, qty }) => ({
      id: product.id, name: product.name, price: product.price, qty,
    })),
    amounts: {
      subtotal: totals.subtotal,
      shipping: totals.shipping,
      tax: totals.tax,
      total: totals.total,
    },
    // Informational only — the server is authoritative and sets the real status.
    status: "needs_shipping",
  };
}

async function handleSubmit(e) {
  e.preventDefault();
  $("#formError").hidden = true;

  const totals = renderSummary();
  if (totals.empty) return;

  const { valid, data, firstInvalid } = collectAndValidate();
  if (!valid) {
    $("#formError").textContent = "Please fix the highlighted fields.";
    $("#formError").hidden = false;
    document.getElementById(firstInvalid)?.focus();
    return;
  }

  // Let the payment provider validate its own inputs (card fields, etc.).
  const pv = activeProvider.validate();
  if (!pv.ok) {
    $("#formError").textContent = pv.message || "Payment details are invalid.";
    $("#formError").hidden = false;
    return;
  }

  const order = buildOrder(data, totals);

  const btn = $("#placeOrderBtn");
  const originalLabel = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "Processing…";

  const restoreButton = () => { btn.disabled = false; btn.innerHTML = originalLabel; };

  try {
    // Persist the order via the backend API. The server validates stock and
    // recomputes the authoritative totals — its response is the source of truth
    // and (when Midtrans is configured) includes a Snap token for payment.
    const res = await fetch(`${API_BASE}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer: order.customer, items: order.items, fulfillmentMethod, promoCode: appliedPromo ? appliedPromo.code : null }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Promo went invalid between validation and placement → clear it so the
      // customer can retry without the code.
      if (body.promoInvalid) {
        appliedPromo = null;
        showPromoState();
        renderSummary();
        $("#promoError").textContent = body.error || "Your promo code is no longer valid — it has been removed.";
        $("#promoError").hidden = false;
      }
      const detail = Array.isArray(body.details) ? body.details.join(" ") : "";
      throw new Error([body.error, detail].filter(Boolean).join(": ") || "Could not place the order.");
    }

    localStorage.setItem("voltedge_last_order", JSON.stringify(body));

    // If Midtrans returned a Snap token, open the QRIS payment popup. Otherwise
    // (gateway not configured) fall back to showing confirmation directly so
    // demos still work end-to-end.
    if (body.snapToken) {
      await payWithSnap(body, restoreButton);
    } else {
      VE.clearCart();
      showConfirmation(body);
    }
  } catch (err) {
    $("#formError").textContent = err.message || "Something went wrong. Please try again.";
    $("#formError").hidden = false;
    restoreButton();
  }
}

/* =========================================================================
 * Midtrans Snap popup
 * ========================================================================= */

// Load the Snap.js script once (sandbox or production URL), keyed by client key.
let snapScriptPromise = null;
function loadSnapScript(clientKey, isProduction) {
  if (window.snap) return Promise.resolve();
  if (snapScriptPromise) return snapScriptPromise;
  snapScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = isProduction
      ? "https://app.midtrans.com/snap/snap.js"
      : "https://app.sandbox.midtrans.com/snap/snap.js";
    s.setAttribute("data-client-key", clientKey || "");
    s.onload = () => resolve();
    s.onerror = () => { snapScriptPromise = null; reject(new Error("Could not load the payment module.")); };
    document.head.appendChild(s);
  });
  return snapScriptPromise;
}

// Small inline status line shown near the Place Order button.
function setPayStatus(html, kind = "info") {
  let el = $("#payStatus");
  if (!el) {
    el = document.createElement("p");
    el.id = "payStatus";
    el.className = "pay-status";
    $("#placeOrderBtn").insertAdjacentElement("afterend", el);
  }
  el.className = `pay-status ${kind}`;
  el.innerHTML = html;
  el.hidden = false;
}
function clearPayStatus() { const el = $("#payStatus"); if (el) el.hidden = true; }

async function payWithSnap(order, restoreButton) {
  try {
    await loadSnapScript(order.midtransClientKey, order.midtransProduction);
  } catch (e) {
    // Order exists but the popup couldn't load — let them retry.
    setPayStatus(`${e.message} <button type="button" class="link-btn" id="retryPay">Retry payment</button>`, "error");
    wireRetry(order, restoreButton);
    restoreButton();
    return;
  }

  setPayStatus("Opening secure QRIS payment…");

  window.snap.pay(order.snapToken, {
    // Payment confirmed.
    onSuccess() {
      clearPayStatus();
      VE.clearCart();
      showConfirmation(order);
    },
    // QRIS can take a moment to confirm — treat as placed-but-awaiting.
    onPending() {
      VE.clearCart();
      showConfirmation(order, { pending: true });
    },
    // Payment failed — keep the order, let them retry.
    onError() {
      setPayStatus(`Payment failed. <button type="button" class="link-btn" id="retryPay">Try again</button>`, "error");
      wireRetry(order, restoreButton);
      restoreButton();
    },
    // Customer dismissed the popup without paying.
    onClose() {
      setPayStatus(`Payment window closed before completing. <button type="button" class="link-btn" id="retryPay">Resume payment</button>`, "warn");
      wireRetry(order, restoreButton);
      restoreButton();
    },
  });
}

// Re-open the Snap popup for the same order (token is still valid).
function wireRetry(order, restoreButton) {
  const b = $("#retryPay");
  if (b) b.addEventListener("click", () => { clearPayStatus(); payWithSnap(order, restoreButton); });
}

/* =========================================================================
 * Confirmation screen
 * ========================================================================= */
function showConfirmation(order, { pending = false } = {}) {
  const c = order.customer;
  $("#confirmInvoiceNo").textContent = order.invoiceNo || order.id;
  $("#confirmOrderId").textContent = order.id;
  $("#confirmTotal").textContent = VE.money(order.amounts.total);
  $("#confirmEmail").textContent = c.email;

  // Fulfillment method: delivery shows the shipping address; pickup shows a
  // pickup note and hides the address row.
  const isPickup = (order.fulfillmentMethod || fulfillmentMethod) === "pickup";
  $("#confirmMethod").textContent = isPickup ? "Self Pickup at Store" : "Delivery";
  const addrRow = $("#confirmAddressRow");
  const pickupNote = $("#confirmPickupNote");
  if (isPickup) {
    if (addrRow) addrRow.hidden = true;
    if (pickupNote) pickupNote.hidden = false;
  } else {
    if (addrRow) addrRow.hidden = false;
    if (pickupNote) pickupNote.hidden = true;
    $("#confirmAddress").textContent = `${c.address}, ${c.city} ${c.postal}, ${c.country}`;
  }

  // Tailor the heading/subtext for a pending QRIS payment vs. a completed one.
  const titleEl = $("#confirmTitle");
  const subEl = $("#confirmSub");
  if (pending) {
    if (titleEl) titleEl.textContent = "Almost done — complete your payment";
    if (subEl) subEl.textContent = "We've received your order. Please finish the QRIS payment; it can take a moment to confirm. We'll process your order once payment is received.";
  } else {
    if (titleEl) titleEl.textContent = "Payment received — thank you!";
    if (subEl) subEl.textContent = "Your order is confirmed and will be processed shortly.";
  }

  // Invoice links use the per-order access token so the (unauthenticated)
  // customer can view only their own invoice.
  const token = encodeURIComponent(order.accessToken || "");
  const base = `${API_BASE}/orders/${encodeURIComponent(order.id)}/invoice/pdf?token=${token}`;
  const viewLink = $("#viewInvoiceLink");
  const dlLink = $("#downloadInvoiceLink");
  if (order.accessToken) {
    viewLink.href = base;
    dlLink.href = `${base}&download=1`;
    $(".confirm-actions").hidden = false;
  } else {
    $(".confirm-actions").hidden = true;
  }

  $("#checkoutView").hidden = true;
  $("#confirmationView").hidden = false;

  // Update the step indicator.
  $("#stepInfo")?.classList.remove("active");
  $("#stepInfo")?.classList.add("done");
  $("#stepDone")?.classList.add("active");

  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* =========================================================================
 * Promo code
 * ========================================================================= */
// Toggle the entry field vs. the "applied" row.
function showPromoState() {
  const entry = $("#promoEntry");
  const applied = $("#promoApplied");
  if (appliedPromo) {
    entry.hidden = true;
    applied.hidden = false;
    $("#promoAppliedCode").textContent = appliedPromo.code;
    $("#promoAppliedAmount").textContent = `− ${VE.money(appliedPromo.discount)}`;
  } else {
    entry.hidden = false;
    applied.hidden = true;
    $("#promoInput").value = "";
  }
}

async function applyPromo() {
  const err = $("#promoError");
  err.hidden = true;
  const code = $("#promoInput").value.trim();
  if (!code) { err.textContent = "Please enter a promo code."; err.hidden = false; return; }
  const { subtotal } = VE.computeTotals();
  const btn = $("#promoApply");
  btn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/promo-codes/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, subtotal }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.valid) {
      err.textContent = data.error || "This promo code is not valid.";
      err.hidden = false;
      return;
    }
    appliedPromo = { code: data.code, discount: data.discount };
    showPromoState();
    renderSummary();
  } catch {
    err.textContent = "Could not validate the code. Please try again.";
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function removePromo() {
  appliedPromo = null;
  $("#promoError").hidden = true;
  showPromoState();
  renderSummary();
}

/* =========================================================================
 * Init
 * ========================================================================= */
async function init() {
  // Refresh the catalog from the API so the summary reflects live prices/stock.
  try {
    await VE.loadProducts();
  } catch (err) {
    console.error("Could not refresh catalog from API; using cached data.", err);
  }

  const totals = renderSummary();
  activeProvider.mount($("#paymentMount"), { totals });
  $("#checkoutForm").addEventListener("submit", handleSubmit);

  // Promo code: apply / remove / Enter-to-apply.
  $("#promoApply").addEventListener("click", applyPromo);
  $("#promoRemove").addEventListener("click", removePromo);
  $("#promoInput").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); applyPromo(); }
  });

  // Fulfillment method toggle: show/hide shipping address, recompute summary.
  const shippingSection = $("#shippingSection");
  const pickupNote = $("#pickupNote");
  document.querySelectorAll('input[name="fulfillment"]').forEach(radio => {
    radio.addEventListener("change", () => {
      fulfillmentMethod = radio.value === "pickup" ? "pickup" : "delivery";
      const isPickup = fulfillmentMethod === "pickup";
      // Toggle selected styling.
      document.querySelectorAll(".fulfillment-opt").forEach(opt =>
        opt.classList.toggle("selected", opt.dataset.method === fulfillmentMethod));
      // Hide the shipping address section + show the pickup note.
      if (shippingSection) shippingSection.hidden = isPickup;
      if (pickupNote) pickupNote.hidden = !isPickup;
      // Clear any address errors when switching to pickup.
      if (isPickup) ADDRESS_FIELDS.forEach(k => setFieldError(FIELD_IDS[k], ""));
      renderSummary();
    });
  });

  // Clear a field's error as the user corrects it.
  Object.values(FIELD_IDS).forEach(id => {
    document.getElementById(id).addEventListener("input", () => setFieldError(id, ""));
  });
}

init();
