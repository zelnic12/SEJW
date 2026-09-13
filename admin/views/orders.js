// Orders view: list all orders, view details, update fulfilment status.
import { api } from "../components/api.js";
import { money, fmtDate, esc } from "../components/format.js";
import { openModal } from "../components/modal.js";
import { toast } from "../components/toast.js";

// Sequential fulfilment flow (in stage order), plus Cancelled as a separate state.
const STATUSES = ["awaiting_payment", "needs_shipping", "shipped", "completed", "cancelled"];

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

function statusBadge(status) {
  // Class uses the (normalized) status value; label is the friendly text.
  const cls = ["awaiting_payment", "needs_shipping", "shipped", "completed", "cancelled"].includes(status)
    ? status
    : (status === "pending" || status === "paid" ? "needs_shipping" : status);
  return `<span class="badge ${esc(cls)}">${esc(statusLabel(status))}</span>`;
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

function orderDetail(root, order) {
  const items = order.items.map(it => `
    <tr>
      <td>${esc(it.name)}</td>
      <td class="num">${it.qty}</td>
      <td class="num">${money(it.price)}</td>
      <td class="num">${money(it.price * it.qty)}</td>
    </tr>`).join("");

  const c = order.customer;
  const isPickup = order.fulfillmentMethod === "pickup";
  // For pickup, there's no shipping address; show a pickup note instead.
  const addressLine = isPickup
    ? `<em>Self pickup at store — no shipping address</em>`
    // Kecamatan is what delivery is priced on, so show it between street and city.
    : `${[c.address, c.district, `${c.city} ${c.postal}`.trim(), c.country]
        .filter(Boolean).map(esc).join(", ")}`;
  openModal({
    title: `Order ${order.id}`,
    bodyHTML: `
      <p style="color:var(--muted);margin-bottom:1rem">${fmtDate(order.createdAt, true)} · ${statusBadge(order.status)}
        · <span class="fulfil-pill ${isPickup ? "pickup" : "delivery"}">${isPickup ? "🏬 Self Pickup" : "🚚 Delivery"}</span></p>
      <div class="panel" style="margin-bottom:1rem">
        <strong>${esc(c.name)}</strong><br>
        <span style="color:var(--muted);font-size:.88rem">
          ${esc(c.email)} · ${esc(c.phone)}<br>
          ${addressLine}
        </span>
      </div>
      ${isPickup ? `<div class="pickup-note" style="margin-bottom:1rem"><strong>Pickup</strong><span>Customer collects this order in person at the store.</span></div>` : ""}
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead>
          <tbody>${items}</tbody>
        </table>
      </div>
      <div style="margin-top:1rem;text-align:right">
        <div style="color:var(--muted);font-size:.9rem">Subtotal ${money(order.amounts.subtotal)}${order.amounts.discount ? ` · Discount −${money(order.amounts.discount)}` : ""} · Shipping ${money(order.amounts.shipping)}${order.customer?.district ? ` (${esc(order.customer.district)})` : ""}</div>
        <div style="font-size:1.3rem;font-weight:800;margin-top:.3rem">Total ${money(order.amounts.total)}</div>
      </div>
      ${order.invoiceNo ? `<p style="color:var(--muted);font-size:.82rem;margin-top:.6rem">Invoice: <strong>${esc(order.invoiceNo)}</strong></p>` : ""}
      <div class="payment-info">
        <div class="payment-info-row">
          <span>Payment</span>
          <span class="pay-badge pay-${esc(order.paymentStatus || "pending")}">${esc(paymentLabel(order.paymentStatus))}</span>
        </div>
        ${order.paymentTxnId ? `<div class="payment-info-row">
          <span>Midtrans txn id</span>
          <code class="pay-txn">${esc(order.paymentTxnId)}</code>
        </div>` : ""}
      </div>
      <div class="form-field" style="margin-top:1.2rem">
        <label>Update status</label>
        <select id="statusSel">
          ${STATUSES.map(s => {
            // Match the current status, normalizing any legacy value to the new flow.
            const normalized = (s === "needs_shipping" && (order.status === "pending" || order.status === "paid")) ? order.status : null;
            const selected = s === order.status || normalized ? "selected" : "";
            return `<option value="${s}" ${selected}>${statusLabel(s)}</option>`;
          }).join("")}
        </select>
        <span class="status-flow-hint">Flow: Needs Shipping → Shipped → Order Completed</span>
      </div>`,
    footHTML: `
      <button class="btn btn-ghost" data-close>Close</button>
      <button class="btn btn-secondary" id="viewInvoice">View invoice</button>
      <button class="btn btn-secondary" id="dlInvoice">Download PDF</button>
      <button class="btn btn-primary" id="saveStatus">Save status</button>`,
    onMount(overlay, close) {
      overlay.querySelector("#viewInvoice").addEventListener("click", () => openInvoicePdf(order.id, false));
      overlay.querySelector("#dlInvoice").addEventListener("click", () => openInvoicePdf(order.id, true));
      overlay.querySelector("#saveStatus").addEventListener("click", async () => {
        const status = overlay.querySelector("#statusSel").value;
        try {
          await api.updateOrderStatus(order.id, status);
          toast("Order status updated", "success");
          close();
          renderOrders(root);
        } catch (e) { toast(e.message, "error"); }
      });
    },
  });
}

// Kanban board columns, in pipeline order. Cancelled is kept separate so it
// doesn't mix with the active pipeline.
// Columns keep the 3-stage pipeline + Cancelled (+ Awaiting Payment). Titles
// note both flows since a column can hold delivery and pickup orders; each
// card shows its own adapted stage label.
const BOARD_COLUMNS = [
  { status: "awaiting_payment", title: "Awaiting Payment" },
  { status: "needs_shipping", title: "Needs Shipping / Ready for Pickup" },
  { status: "shipped", title: "Shipped / Picked Up" },
  { status: "completed", title: "Order Completed" },
  { status: "cancelled", title: "Cancelled" },
];

const VALID_BOARD = ["awaiting_payment", "needs_shipping", "shipped", "completed", "cancelled"];

// The primary "advance" action for a status, ADAPTED to the fulfillment method.
// null = no forward action (terminal / awaiting external event).
// The same 3-stage pipeline is reused; only the labels differ for pickup.
function nextAction(status, method) {
  const pickup = method === "pickup";
  switch (status) {
    case "needs_shipping": // = "Ready for Pickup" for pickup orders
      return { to: "shipped", label: pickup ? "Mark Picked Up" : "Mark as Shipped" };
    case "shipped":        // = "Picked Up" for pickup orders
      return { to: "completed", label: "Mark Completed" };
    default:
      return null; // awaiting_payment / completed / cancelled
  }
}

// Per-card stage label, adapted to the fulfillment method.
function stageLabelFor(status, method) {
  const pickup = method === "pickup";
  switch (status) {
    case "awaiting_payment": return "Awaiting Payment";
    case "needs_shipping": return pickup ? "Ready for Pickup" : "Needs Shipping";
    case "shipped": return pickup ? "Picked Up" : "Shipped";
    case "completed": return "Order Completed";
    case "cancelled": return "Cancelled";
    default: return status;
  }
}

// Normalize any legacy status onto a board column so no order is ever missing.
function boardStatus(status) {
  if (status === "pending" || status === "paid") return "needs_shipping";
  return VALID_BOARD.includes(status) ? status : "needs_shipping";
}

function orderCard(o) {
  const itemCount = o.items.reduce((s, i) => s + i.qty, 0);
  const bs = boardStatus(o.status);
  const method = o.fulfillmentMethod === "pickup" ? "pickup" : "delivery";
  const next = nextAction(bs, method);
  const canCancel = bs === "awaiting_payment" || bs === "needs_shipping" || bs === "shipped";
  // A small per-card pill shows the fulfillment type + its adapted stage label,
  // so delivery and pickup orders read correctly within the shared columns.
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
        <span>·</span>
        <span>${itemCount} item${itemCount === 1 ? "" : "s"}</span>
      </div>
      <div class="order-card-tags">${methodPill}<span class="stage-pill">${esc(stageLabelFor(bs, method))}</span></div>
      ${(next || canCancel) ? `<div class="order-card-actions">
        ${next ? `<button class="btn btn-primary btn-xs" data-move="${esc(o.id)}" data-to="${next.to}">${next.label}</button>` : ""}
        ${canCancel ? `<button class="icon-action danger btn-xs" data-move="${esc(o.id)}" data-to="cancelled">Cancel</button>` : ""}
      </div>` : ""}
    </article>`;
}

export async function renderOrders(root) {
  root.innerHTML = `<p class="admin-status">Loading orders…</p>`;
  let orders;
  try {
    orders = await api.listOrders();
  } catch (err) {
    root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`;
    return;
  }

  // Group orders by (normalized) board status.
  const byStatus = Object.fromEntries(BOARD_COLUMNS.map(c => [c.status, []]));
  for (const o of orders) byStatus[boardStatus(o.status)].push(o);

  const columnsHtml = BOARD_COLUMNS.map(col => {
    const list = byStatus[col.status];
    return `
      <section class="board-col" data-col="${col.status}">
        <header class="board-col-head status-${col.status}">
          <span class="board-col-title">${esc(col.title)}</span>
          <span class="board-col-count">${list.length}</span>
        </header>
        <div class="board-col-body">
          ${list.length ? list.map(orderCard).join("") : `<p class="board-empty">No orders</p>`}
        </div>
      </section>`;
  }).join("");

  root.innerHTML = `
    <div class="orders-head">
      <h2>Orders (${orders.length})</h2>
      <span class="orders-head-hint">Needs Shipping → Shipped → Order Completed</span>
    </div>
    <div class="orders-board">${columnsHtml}</div>`;

  const byId = new Map(orders.map(o => [o.id, o]));

  // Click a card (but not its action buttons) → open the existing detail modal.
  root.querySelectorAll("[data-card]").forEach(card => {
    const open = () => orderDetail(root, byId.get(card.dataset.card));
    card.addEventListener("click", e => {
      if (e.target.closest("[data-move]")) return; // let the button handler run
      open();
    });
    card.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });

  // Move buttons → update status, then re-render the board.
  root.querySelectorAll("[data-move]").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      btn.disabled = true;
      try {
        await api.updateOrderStatus(btn.dataset.move, btn.dataset.to);
        toast("Order moved", "success");
        renderOrders(root);
      } catch (err) {
        btn.disabled = false;
        toast(err.message, "error");
      }
    });
  });
}
