// Orders view: one page per fulfilment status, with a rich detail view per order.
//
// Every status is its own route (#orders, #orders-shipped, …) so a refresh or a
// status change keeps the admin on the tab they were working in. The tab bar
// always shows all five counts, so the board's "see everything at once" benefit
// survives without five columns competing for width.
import { api } from "../components/api.js";
import { money, fmtDate, esc, thumb } from "../components/format.js";
import { openModal } from "../components/modal.js";
import { toast } from "../components/toast.js";

// ---------------------------------------------------------------------------
// Status model — single source of truth for the tabs, labels and routes.
// ---------------------------------------------------------------------------
// Pipeline order. `route` is the admin hash for that tab; needs_shipping owns
// the bare `#orders` route because it's the default landing tab (see below).
const ORDER_TABS = [
  { status: "awaiting_payment", route: "orders-awaiting-payment", tab: "Awaiting Payment", title: "Awaiting Payment" },
  { status: "needs_shipping", route: "orders", tab: "Needs Shipping", title: "Needs Shipping / Ready for Pickup" },
  { status: "shipped", route: "orders-shipped", tab: "Shipped", title: "Shipped / Picked Up" },
  { status: "completed", route: "orders-completed", tab: "Completed", title: "Order Completed" },
  { status: "cancelled", route: "orders-cancelled", tab: "Cancelled", title: "Cancelled" },
];

// The admin's default landing tab. Awaiting Payment is waiting on the *customer*
// (and on the Midtrans webhook), whereas Needs Shipping is the queue where the
// store itself is the blocker — so that's the actionable starting point.
const DEFAULT_STATUS = "needs_shipping";

const VALID_STATUSES = ORDER_TABS.map(t => t.status);

// Human-readable labels for each status value.
const STATUS_LABELS = {
  awaiting_payment: "Awaiting Payment",
  needs_shipping: "Needs Shipping",
  shipped: "Shipped",
  completed: "Order Completed",
  cancelled: "Cancelled",
  // Legacy fallbacks (should be migrated away, but display sensibly if seen).
  pending: "Needs Shipping",
  paid: "Needs Shipping",
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

const PAYMENT_LABELS = {
  paid: "Paid",
  pending: "Awaiting payment",
  failed: "Failed",
  expired: "Expired",
  cancelled: "Cancelled",
  unconfigured: "No gateway",
};
function paymentLabel(s) {
  return PAYMENT_LABELS[s] || s || "—";
}

// Normalize any legacy status onto a real tab so no order is ever unreachable.
function normalizeStatus(status) {
  if (status === "pending" || status === "paid") return "needs_shipping";
  return VALID_STATUSES.includes(status) ? status : "needs_shipping";
}

function statusBadge(status) {
  const cls = normalizeStatus(status);
  return `<span class="badge ${esc(cls)}">${esc(statusLabel(status))}</span>`;
}

// Per-order stage label, adapted to the fulfillment method: the same pipeline
// reads differently for a pickup order ("Ready for Pickup" vs "Needs Shipping").
function stageLabelFor(status, method) {
  const pickup = method === "pickup";
  switch (normalizeStatus(status)) {
    case "awaiting_payment": return "Awaiting Payment";
    case "needs_shipping": return pickup ? "Ready for Pickup" : "Needs Shipping";
    case "shipped": return pickup ? "Picked Up" : "Shipped";
    case "completed": return "Order Completed";
    case "cancelled": return "Cancelled";
    default: return status;
  }
}

// The primary "advance" action for a status, adapted to the fulfillment method.
// null = no forward action (terminal, or waiting on the payment webhook).
function nextAction(status, method) {
  const pickup = method === "pickup";
  switch (normalizeStatus(status)) {
    case "needs_shipping": // = "Ready for Pickup" for pickup orders
      return { to: "shipped", label: pickup ? "Mark Picked Up" : "Mark as Shipped" };
    case "shipped":        // = "Picked Up" for pickup orders
      return { to: "completed", label: "Mark Completed" };
    default:
      return null; // awaiting_payment / completed / cancelled
  }
}

function canCancel(status) {
  const s = normalizeStatus(status);
  return s === "awaiting_payment" || s === "needs_shipping" || s === "shipped";
}

const methodOf = order => (order.fulfillmentMethod === "pickup" ? "pickup" : "delivery");

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------
// Module scope so a status change (which re-renders) keeps the admin on the tab
// they were working in, matching how the products view remembers its tab.
let currentStatus = DEFAULT_STATUS;
// Set by openOrderById() so a notification click can land on an order's detail
// view: the list opens it once the cards have rendered.
let pendingOrderId = null;

function reload(root) {
  return renderOrders(root, { status: currentStatus });
}

/**
 * Which route to visit to open a given order, and a request to open its detail
 * view when that route renders. Used by the notification bell.
 *
 * The order's own status decides the tab, so a new order lands on Awaiting
 * Payment or Needs Shipping depending on whether a gateway is configured. If the
 * lookup fails we still return a usable route — the detail view re-fetches
 * anyway, so the worst case is the list underneath showing a different tab.
 *
 * @returns {Promise<string>} the admin route (no leading "#")
 */
export async function openOrderById(id) {
  pendingOrderId = id;
  let status = DEFAULT_STATUS;
  try {
    status = normalizeStatus((await api.getOrder(id)).status);
  } catch {
    /* Fall back to the default tab; the detail view still opens. */
  }
  return ORDER_TABS.find(t => t.status === status)?.route || "orders";
}

// Open (or download) the invoice PDF as a blob so the admin auth header is sent.
async function openInvoicePdf(orderId, download = false) {
  try {
    const url = await api.fetchInvoicePdf(orderId);
    if (download) {
      const a = document.createElement("a");
      a.href = url; a.download = `${orderId}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
    } else {
      window.open(url, "_blank");
    }
    // Revoke shortly after to free memory (after the tab/download grabs it).
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { toast(e.message, "error"); }
}

// ---------------------------------------------------------------------------
// Status timeline
// ---------------------------------------------------------------------------
// Turn the order's recorded history into timeline points.
//
// Orders placed after migration 018 have their opening status recorded at
// creation time, so history[0] *is* the "order placed" moment. Orders that
// predate it start mid-pipeline (or have no history at all), and inventing
// timestamps for the stages they already passed would be fiction — so those get
// a synthesized placement point and an explicit note about the gap.
function timelinePoints(order) {
  const history = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  const createdMs = new Date(order.createdAt).getTime();
  const firstMs = history.length ? new Date(history[0].changedAt).getTime() : Infinity;
  // Within a second of creation → this is the opening status, not a later move.
  const originRecorded = history.length > 0 && firstMs - createdMs < 1000;

  const points = originRecorded
    ? history.map((h, i) => ({ status: h.status, at: h.changedAt, placed: i === 0 }))
    : [
        { status: null, at: order.createdAt, placed: true },
        ...history.map(h => ({ status: h.status, at: h.changedAt })),
      ];

  // If the recorded points don't reach where the order actually is, the stage it
  // sits in was reached before tracking — show it, but don't invent a timestamp.
  const last = points[points.length - 1];
  if (!last || last.status === null || normalizeStatus(last.status) !== normalizeStatus(order.status)) {
    points.push({ status: order.status, at: null });
  }

  return { points, partial: !originRecorded };
}

function statusTimeline(order) {
  const { points, partial } = timelinePoints(order);
  const method = methodOf(order);

  const items = points.map((p, i) => {
    const isLast = i === points.length - 1;
    const label = p.status === null ? "Order placed" : stageLabelFor(p.status, method);
    const cls = p.status === null ? "placed" : normalizeStatus(p.status);
    return `
      <li class="timeline-point ${esc(cls)}${isLast ? " current" : ""}">
        <div class="timeline-label">
          ${esc(label)}
          ${p.placed && p.status !== null ? `<span class="timeline-tag">order placed</span>` : ""}
          ${isLast ? `<span class="timeline-tag now">current</span>` : ""}
        </div>
        ${p.at
          ? `<time class="timeline-time">${fmtDate(p.at, true)}</time>`
          : `<span class="timeline-time unknown">not recorded</span>`}
      </li>`;
  }).join("");

  return `
    <ol class="order-timeline">${items}</ol>
    ${partial ? `<p class="timeline-note">
      Only changes made since status tracking was added are listed — this order was
      placed before then, so any earlier stages aren't recorded.
    </p>` : ""}`;
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------
function detailBody(order) {
  const c = order.customer || {};
  const isPickup = methodOf(order) === "pickup";
  const a = order.amounts;

  // Every line with its thumbnail, so the admin can see what was ordered without
  // cross-referencing the catalog. A line whose product has been deleted keeps
  // its snapshotted name and falls back to a generic glyph.
  const items = order.items.map(it => `
    <tr>
      <td>
        <div class="od-item">
          ${thumb({ url: it.image, emoji: it.emoji, alt: it.name, cls: "row-thumb" })}
          <span class="od-item-text">
            <span class="od-item-name">${esc(it.name)}</span>
            ${it.note ? `<span class="od-item-note"><strong>Catatan:</strong> ${esc(it.note)}</span>` : ""}
          </span>
        </div>
      </td>
      <td class="num">${it.qty}</td>
      <td class="num">${money(it.price)}</td>
      <td class="num">${money(it.price * it.qty)}</td>
    </tr>`).join("");

  // Kecamatan is what delivery is priced on, so show it between street and city.
  const addressLine = [c.address, c.district, [c.city, c.postal].filter(Boolean).join(" "), c.country]
    .filter(Boolean).map(esc).join(", ");

  // Only the stages the server accepts (awaiting_payment is set by the order
  // route / payment webhook, never by hand) plus whatever this order is in now.
  const settable = ["needs_shipping", "shipped", "completed", "cancelled"];
  const current = normalizeStatus(order.status);
  const next = nextAction(current, methodOf(order));

  return `
    <div class="od-head">
      ${statusBadge(order.status)}
      <span class="fulfil-pill ${isPickup ? "pickup" : "delivery"}">${isPickup ? "🏬 Self Pickup" : "🚚 Delivery"}</span>
      <span class="od-placed">Placed ${fmtDate(order.createdAt, true)}</span>
    </div>

    <div class="od-grid">
      <section class="od-block">
        <h4>Customer</h4>
        <p class="od-strong">${esc(c.name || "—")}</p>
        <dl class="od-pairs">
          <dt>Email</dt><dd><a href="mailto:${esc(c.email || "")}">${esc(c.email || "—")}</a></dd>
          <dt>Phone</dt><dd><a href="tel:${esc(c.phone || "")}">${esc(c.phone || "—")}</a></dd>
        </dl>
      </section>

      <section class="od-block">
        <h4>${isPickup ? "Pickup" : "Delivery"}</h4>
        ${isPickup
          ? `<p class="od-strong">Self pickup at store</p>
             <p class="od-muted">The customer collects this order in person — no shipping
             address and no shipping fee.</p>`
          : `<p class="od-strong">Delivery${c.district ? ` to ${esc(c.district)}` : ""}</p>
             <address class="od-address">${addressLine || "—"}</address>
             ${c.district ? `<p class="od-muted">Kecamatan <strong>${esc(c.district)}</strong>${c.city ? `, ${esc(c.city)}` : ""} — ongkir ${money(a.shipping)}</p>` : ""}`}
      </section>
    </div>

    <section class="od-section">
      <h4>Items</h4>
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Subtotal</th></tr></thead>
          <tbody>${items}</tbody>
        </table>
      </div>
    </section>

    <section class="od-section">
      <h4>Totals</h4>
      <dl class="od-totals">
        <dt>Subtotal</dt><dd>${money(a.subtotal)}</dd>
        ${a.discount ? `<dt>Discount${order.promoCode ? ` (${esc(order.promoCode)})` : ""}</dt><dd class="minus">− ${money(a.discount)}</dd>` : ""}
        <dt>Shipping${isPickup ? " (pickup)" : c.district ? ` (${esc(c.district)})` : ""}</dt>
        <dd>${a.shipping ? money(a.shipping) : "Free"}</dd>
        <dt class="grand">Total</dt><dd class="grand">${money(a.total)}</dd>
      </dl>
    </section>

    <section class="od-section">
      <h4>Payment</h4>
      <dl class="od-pairs">
        <dt>Status</dt>
        <dd><span class="pay-badge pay-${esc(order.paymentStatus || "pending")}">${esc(paymentLabel(order.paymentStatus))}</span></dd>
        ${order.invoiceNo ? `<dt>Invoice</dt><dd><strong>${esc(order.invoiceNo)}</strong></dd>` : ""}
        ${order.paymentTxnId
          ? `<dt>Midtrans txn id</dt><dd><code class="pay-txn">${esc(order.paymentTxnId)}</code></dd>`
          : `<dt>Midtrans txn id</dt><dd class="od-muted">Not available</dd>`}
      </dl>
    </section>

    <section class="od-section">
      <h4>Status history</h4>
      ${statusTimeline(order)}
    </section>

    <section class="od-section">
      <h4>Move this order</h4>
      ${(next || canCancel(current)) ? `
        <div class="od-actions">
          ${next ? `<button class="btn btn-primary btn-sm" id="advance">${esc(next.label)}</button>` : ""}
          ${canCancel(current) ? `<button class="btn btn-danger btn-sm" id="cancelOrder">Cancel order</button>` : ""}
        </div>` : `<p class="od-muted">${current === "cancelled"
          ? "This order was cancelled — reopen it with the status picker below if that was a mistake."
          : "This order is complete. Nothing left to do."}</p>`}
      <div class="od-manual">
        <label for="statusSel">Or set the status directly</label>
        <div class="od-manual-row">
          <select id="statusSel" aria-label="Order status">
            ${settable.includes(current) ? "" : `<option value="" selected>${esc(statusLabel(current))} — pick a new stage</option>`}
            ${settable.map(s =>
              `<option value="${s}" ${s === current ? "selected" : ""}>${esc(statusLabel(s))}</option>`
            ).join("")}
          </select>
          <button class="btn btn-secondary btn-sm" id="saveStatus">Save</button>
        </div>
        <span class="status-flow-hint">Flow: Needs Shipping → Shipped → Order Completed</span>
      </div>
    </section>`;
}

// Open the detail view for an order id. Always re-fetches so the timeline and
// payment state are current (the list payload deliberately omits history).
async function openOrderDetail(root, orderId) {
  let order;
  try {
    order = await api.getOrder(orderId);
  } catch (e) {
    toast(e.message, "error");
    return;
  }

  const next = nextAction(order.status, methodOf(order));

  openModal({
    title: `Order ${order.id}`,
    className: "modal-lg",
    bodyHTML: detailBody(order),
    // Status actions live in the body next to the timeline, so the footer stays
    // the document actions only.
    footHTML: `
      <button class="btn btn-ghost" data-close>Close</button>
      <button class="btn btn-secondary" id="viewInvoice">View invoice</button>
      <button class="btn btn-secondary" id="dlInvoice">Download PDF</button>`,
    onMount(overlay, close) {
      overlay.querySelector("#viewInvoice").addEventListener("click", () => openInvoicePdf(order.id, false));
      overlay.querySelector("#dlInvoice").addEventListener("click", () => openInvoicePdf(order.id, true));

      // Move the order, then close and re-render the tab underneath.
      const move = async (to, button) => {
        button.disabled = true;
        try {
          await api.updateOrderStatus(order.id, to);
          toast(`Order ${statusLabel(to).toLowerCase()}`, "success");
          close();
          reload(root);
        } catch (e) {
          button.disabled = false;
          toast(e.message, "error");
        }
      };

      overlay.querySelector("#advance")?.addEventListener("click", e => move(next.to, e.currentTarget));
      overlay.querySelector("#cancelOrder")?.addEventListener("click", e => move("cancelled", e.currentTarget));
      overlay.querySelector("#saveStatus").addEventListener("click", e => {
        const target = overlay.querySelector("#statusSel").value;
        // The placeholder is selected for statuses the admin can't set by hand
        // (awaiting_payment), so nothing has been chosen yet.
        if (!target) {
          toast("Choose a stage to move this order to", "info");
          return;
        }
        // Re-saving the current status is a no-op server-side; say so instead of
        // closing the view as though something happened.
        if (target === normalizeStatus(order.status)) {
          toast(`Already ${statusLabel(target).toLowerCase()}`, "info");
          return;
        }
        move(target, e.currentTarget);
      });
    },
  });
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
// What's in the order, at a glance: the first line's thumbnail and name, plus a
// "+N more" for the rest. Showing every thumbnail would not fit a card, and the
// full list is one click away in the detail view.
function itemPreview(items) {
  if (!items || items.length === 0) return "";
  const [first, ...rest] = items;
  // Hovering the counter names the other products, so the rest isn't a mystery.
  const restNames = rest.map(i => i.name).join(", ");
  return `
    <div class="order-card-items">
      ${thumb({ url: first.image, emoji: first.emoji, alt: first.name, cls: "oc-thumb" })}
      <span class="oc-item-name" title="${esc(first.name)}">${esc(first.name)}</span>
      ${first.qty > 1 ? `<span class="oc-item-qty">×${first.qty}</span>` : ""}
      ${rest.length ? `<span class="oc-more" title="${esc(restNames)}">+${rest.length} more</span>` : ""}
    </div>`;
}

function orderCard(o) {
  const status = normalizeStatus(o.status);
  const method = methodOf(o);
  const next = nextAction(status, method);
  const methodPill = `<span class="fulfil-pill ${method}">${method === "pickup" ? "🏬 Pickup" : "🚚 Delivery"}</span>`;
  return `
    <article class="order-card" data-card="${esc(o.id)}" tabindex="0" role="button" aria-label="Open order ${esc(o.id)}">
      <div class="order-card-top">
        <span class="order-card-id">${esc(o.id)}</span>
        <span class="order-card-total">${money(o.amounts.total)}</span>
      </div>
      <div class="order-card-customer">${esc(o.customer?.name || "—")}</div>
      <div class="order-card-meta">
        <span>${fmtDate(o.createdAt)}</span>
        ${o.customer?.district ? `<span>·</span><span>${esc(o.customer.district)}</span>` : ""}
      </div>
      ${itemPreview(o.items)}
      <div class="order-card-tags">${methodPill}<span class="stage-pill">${esc(stageLabelFor(status, method))}</span></div>
      ${(next || canCancel(status)) ? `<div class="order-card-actions">
        ${next ? `<button class="btn btn-primary btn-xs" data-move="${esc(o.id)}" data-to="${next.to}">${next.label}</button>` : ""}
        ${canCancel(status) ? `<button class="icon-action danger btn-xs" data-move="${esc(o.id)}" data-to="cancelled">Cancel</button>` : ""}
      </div>` : ""}
    </article>`;
}

// What an empty tab should say — the reason differs per status.
const EMPTY_COPY = {
  awaiting_payment: "No orders are waiting on payment.",
  needs_shipping: "Nothing to pack right now — this queue is clear.",
  shipped: "No orders are in transit or waiting to be collected.",
  completed: "No completed orders yet.",
  cancelled: "No cancelled orders.",
};

/**
 * Orders, one fulfilment status at a time.
 *
 * The same list, cards and actions for every tab — a tab is just this view
 * scoped to one status. Counts for all statuses are always shown in the tab bar,
 * so a single fetch of every order backs the whole screen.
 *
 * @param {HTMLElement} root
 * @param {object}  [options]
 * @param {string}  [options.status] one of ORDER_TABS' statuses
 */
export async function renderOrders(root, { status = DEFAULT_STATUS } = {}) {
  currentStatus = VALID_STATUSES.includes(status) ? status : DEFAULT_STATUS;

  root.innerHTML = `<p class="admin-status">Loading orders…</p>`;
  let orders;
  try {
    orders = await api.listOrders();
  } catch (err) {
    root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`;
    return;
  }

  // Group once: the tab bar needs every count, the list needs one bucket.
  const byStatus = Object.fromEntries(VALID_STATUSES.map(s => [s, []]));
  for (const o of orders) byStatus[normalizeStatus(o.status)].push(o);

  const active = ORDER_TABS.find(t => t.status === currentStatus);
  const list = byStatus[currentStatus];

  const tabsHtml = ORDER_TABS.map(t => {
    const n = byStatus[t.status].length;
    const isActive = t.status === currentStatus;
    // Highlight the queues that are waiting on someone, but only when non-empty.
    const needsAttention = n > 0 && (t.status === "needs_shipping" || t.status === "awaiting_payment");
    return `
      <button class="admin-tab ${isActive ? "active" : ""}" data-route="${t.route}"
              role="tab" aria-selected="${isActive}">
        ${esc(t.tab)}
        <span class="admin-tab-count ${needsAttention ? "warn" : ""}">${n}</span>
      </button>`;
  }).join("");

  root.innerHTML = `
    <div class="panel orders-panel">
      <div class="panel-head">
        <h2>${esc(active.title)} (${list.length})</h2>
        <span class="orders-head-hint">Needs Shipping → Shipped → Order Completed</span>
      </div>
      <div class="admin-tabs" role="tablist" aria-label="Order status">${tabsHtml}</div>
      <div class="orders-body">
        ${list.length
          ? `<div class="order-list">${list.map(orderCard).join("")}</div>`
          : `<p class="admin-status">${esc(EMPTY_COPY[currentStatus] || "No orders.")}</p>`}
      </div>
    </div>`;

  // Tabs are real routes, so a status change or a refresh keeps you in place.
  root.querySelectorAll(".admin-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const target = `#${tab.dataset.route}`;
      if (location.hash === target) return;
      location.hash = target;
    });
  });

  // Click a card (but not its action buttons) → open the detail view.
  root.querySelectorAll("[data-card]").forEach(card => {
    const open = () => openOrderDetail(root, card.dataset.card);
    card.addEventListener("click", e => {
      if (e.target.closest("[data-move]")) return; // let the button handler run
      open();
    });
    card.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });

  // Move buttons → update status, then re-render the current tab.
  root.querySelectorAll("[data-move]").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      btn.disabled = true;
      try {
        await api.updateOrderStatus(btn.dataset.move, btn.dataset.to);
        toast("Order moved", "success");
        reload(root);
      } catch (err) {
        btn.disabled = false;
        toast(err.message, "error");
      }
    });
  });

  // Honour an order requested from outside (notification click).
  if (pendingOrderId) {
    const wanted = pendingOrderId;
    pendingOrderId = null;
    await openOrderDetail(root, wanted);
  }
}

// Route table for admin.js — one entry per status tab, so each is linkable.
export const ORDER_ROUTES = ORDER_TABS.map(t => ({
  route: t.route,
  status: t.status,
  title: t.status === DEFAULT_STATUS ? "Orders" : `Orders · ${t.tab}`,
}));
