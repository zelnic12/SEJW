// Admin Aftersales view: every warranty claim / return request, filterable by
// type and status, with a detail modal to review evidence, move the request
// through the workflow, and write notes the customer sees on the tracking page.
import { api } from "../components/api.js";
import { money, esc, fmtDate } from "../components/format.js";
import { dataTable } from "../components/dataTable.js";
import { openModal } from "../components/modal.js";
import { toast } from "../components/toast.js";

const TYPE_LABELS = { warranty_claim: "Warranty claim", return_exchange: "Return / exchange" };
const STATUS_LABELS = {
  submitted: "Submitted", under_review: "Under review", approved: "Approved",
  rejected: "Rejected", processing: "Processing", completed: "Completed",
};
// Order the filter chips the way the workflow runs.
const STATUS_ORDER = ["submitted", "under_review", "approved", "processing", "completed", "rejected"];

// View state, kept in the module so re-renders preserve the chosen filters.
const filters = { type: "", status: "" };

const statusBadge = s => `<span class="badge ${esc(s)}">${esc(STATUS_LABELS[s] || s)}</span>`;
const typeBadge = t => `<span class="badge type-${esc(t)}">${esc(TYPE_LABELS[t] || t)}</span>`;

function photoGrid(photos) {
  if (!photos || !photos.length) return `<p class="admin-status">No photos attached.</p>`;
  return `<div class="as-admin-photos">
    ${photos.map((p, i) => `
      <a class="as-admin-photo" href="${esc(p.url)}" target="_blank" rel="noopener" title="Open full size">
        <img src="${esc(p.url)}" alt="Evidence photo ${i + 1}" loading="lazy" />
      </a>`).join("")}
  </div>`;
}

function orderBlock(order) {
  if (!order) {
    return `<p class="admin-status">The linked order is no longer available.</p>`;
  }
  return `
    <div class="as-admin-grid">
      <div><span class="as-admin-label">Order</span><strong>${esc(order.id)}</strong></div>
      <div><span class="as-admin-label">Order status</span>${statusBadgeForOrder(order.status)}</div>
      <div><span class="as-admin-label">Placed</span><span>${esc(fmtDate(order.createdAt))}</span></div>
      <div><span class="as-admin-label">Total</span><span>${money(order.amounts?.total ?? 0)}</span></div>
      <div><span class="as-admin-label">Fulfillment</span><span>${esc(order.fulfillmentMethod || "delivery")}</span></div>
      <div><span class="as-admin-label">Phone</span><span>${esc(order.customer?.phone || "—")}</span></div>
    </div>
    <ul class="as-admin-items">
      ${(order.items || []).map(i => `<li>${esc(i.name)} <span class="muted-sm">×${i.qty} · ${money(i.price)}</span></li>`).join("")}
    </ul>`;
}

// Orders use their own status vocabulary; reuse the existing badge classes.
const statusBadgeForOrder = s => `<span class="badge ${esc(s)}">${esc(String(s).replace(/_/g, " "))}</span>`;

async function openDetail(root, id) {
  let request;
  try {
    request = await api.getAftersalesRequest(id);
  } catch (err) {
    toast(err.message, "error");
    return;
  }

  openModal({
    title: `Request ${request.id}`,
    bodyHTML: `
      <div class="as-admin-head">
        ${typeBadge(request.type)} ${statusBadge(request.status)}
      </div>

      <div class="as-admin-grid">
        <div><span class="as-admin-label">Customer</span><strong>${esc(request.customerName)}</strong></div>
        <div><span class="as-admin-label">Email</span><span>${esc(request.customerEmail)}</span></div>
        <div><span class="as-admin-label">Submitted</span><span>${esc(fmtDate(request.createdAt))}</span></div>
        <div><span class="as-admin-label">Last update</span><span>${esc(fmtDate(request.updatedAt))}</span></div>
        <div><span class="as-admin-label">Item</span><span>${esc(request.productName || "Whole order")}</span></div>
      </div>

      <div class="as-admin-section">
        <h4>Customer's description</h4>
        <p class="as-admin-desc">${esc(request.description)}</p>
      </div>

      <div class="as-admin-section">
        <h4>Evidence photos</h4>
        ${photoGrid(request.photos)}
      </div>

      <div class="as-admin-section">
        <h4>Linked order</h4>
        ${orderBlock(request.order)}
      </div>

      <div class="as-admin-section">
        <h4>Move this request</h4>
        ${request.allowedNextStatuses.length
          ? `<div class="chart-toggle as-admin-actions" id="asStatusActions">
               ${request.allowedNextStatuses.map(s =>
                 `<button type="button" data-next="${esc(s)}">→ ${esc(STATUS_LABELS[s] || s)}</button>`).join("")}
             </div>`
          : `<p class="admin-status">“${esc(STATUS_LABELS[request.status] || request.status)}” is a final state — nothing further to do.</p>`}
      </div>

      <div class="as-admin-section">
        <h4>Notes for the customer</h4>
        <p class="form-hint">Shown on the customer's tracking page — use it to explain a decision or give shipping instructions.</p>
        <textarea id="asNotes" rows="4" maxlength="2000" placeholder="e.g. Approved — please ship the unit to our service center at …">${esc(request.adminNotes || "")}</textarea>
        <p class="form-error" id="asError" hidden></p>
      </div>`,
    footHTML: `
      <button class="btn btn-ghost" data-close>Close</button>
      <button class="btn btn-primary" id="asSaveNotes">Save notes</button>`,
    onMount(overlay, close) {
      const err = overlay.querySelector("#asError");

      // Status buttons: only the transitions the server allows are rendered.
      overlay.querySelectorAll("#asStatusActions [data-next]").forEach(btn => {
        btn.addEventListener("click", async () => {
          const next = btn.dataset.next;
          overlay.querySelectorAll("#asStatusActions button").forEach(b => { b.disabled = true; });
          try {
            // Save any pending note edits together with the move, so a decision
            // and its explanation reach the customer at the same time.
            const notes = overlay.querySelector("#asNotes").value;
            const payload = { status: next };
            if (notes !== (request.adminNotes || "")) payload.adminNotes = notes;
            await api.updateAftersalesRequest(request.id, payload);
            toast(`Request moved to “${STATUS_LABELS[next] || next}”`, "success");
            close();
            renderAftersales(root);
          } catch (e) {
            err.textContent = e.message; err.hidden = false;
            overlay.querySelectorAll("#asStatusActions button").forEach(b => { b.disabled = false; });
          }
        });
      });

      overlay.querySelector("#asSaveNotes").addEventListener("click", async () => {
        const btn = overlay.querySelector("#asSaveNotes");
        btn.disabled = true; btn.textContent = "Saving…";
        try {
          await api.updateAftersalesRequest(request.id, { adminNotes: overlay.querySelector("#asNotes").value });
          toast("Notes saved — the customer can see them on the tracking page", "success");
          close();
          renderAftersales(root);
        } catch (e) {
          err.textContent = e.message; err.hidden = false;
          btn.disabled = false; btn.textContent = "Save notes";
        }
      });
    },
  });
}

export async function renderAftersales(root) {
  root.innerHTML = `<p class="admin-status">Loading aftersales requests…</p>`;

  let data;
  try {
    data = await api.listAftersalesRequests(filters);
  } catch (err) {
    root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`;
    return;
  }
  const { requests, counts } = data;
  const totalAll = Object.values(counts).reduce((s, n) => s + n, 0);

  const table = dataTable({
    columns: [
      { key: "id", label: "Tracking ID", render: r => `<strong style="font-family:monospace">${esc(r.id)}</strong>` },
      { key: "customer", label: "Customer", render: r => `
        <div>${esc(r.customerName)}<span class="muted-sm">${esc(r.customerEmail)}</span></div>` },
      { key: "order", label: "Order", render: r => `
        <div style="font-family:monospace">${esc(r.orderId)}<span class="muted-sm">${esc(r.productName || "whole order")}</span></div>` },
      { key: "type", label: "Type", render: r => typeBadge(r.type) },
      { key: "status", label: "Status", render: r => statusBadge(r.status) },
      { key: "created", label: "Submitted", render: r => fmtDate(r.createdAt) },
      { key: "actions", label: "", render: r => `
        <div class="row-actions"><button class="icon-action" data-view="${esc(r.id)}">View</button></div>` },
    ],
    rows: requests,
    empty: filters.type || filters.status
      ? "No requests match these filters."
      : "No aftersales requests yet.",
  });

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Aftersales requests (${requests.length}${
          (filters.type || filters.status) ? ` of ${totalAll}` : ""})</h2>
      </div>

      <div class="as-admin-filters">
        <div class="as-admin-filter">
          <span class="as-admin-label">Type</span>
          <div class="chart-toggle" id="typeFilter">
            <button data-type="" class="${filters.type === "" ? "active" : ""}">All</button>
            <button data-type="warranty_claim" class="${filters.type === "warranty_claim" ? "active" : ""}">Warranty claims</button>
            <button data-type="return_exchange" class="${filters.type === "return_exchange" ? "active" : ""}">Returns / exchanges</button>
          </div>
        </div>
        <div class="as-admin-filter">
          <span class="as-admin-label">Status</span>
          <div class="chart-toggle" id="statusFilter">
            <button data-status="" class="${filters.status === "" ? "active" : ""}">All (${totalAll})</button>
            ${STATUS_ORDER.map(s => `
              <button data-status="${s}" class="${filters.status === s ? "active" : ""}">
                ${esc(STATUS_LABELS[s])} (${counts[s] ?? 0})
              </button>`).join("")}
          </div>
        </div>
      </div>

      ${table}
    </div>`;

  root.querySelectorAll("#typeFilter button").forEach(btn => {
    btn.addEventListener("click", () => { filters.type = btn.dataset.type; renderAftersales(root); });
  });
  root.querySelectorAll("#statusFilter button").forEach(btn => {
    btn.addEventListener("click", () => { filters.status = btn.dataset.status; renderAftersales(root); });
  });
  root.querySelectorAll("[data-view]").forEach(btn => {
    btn.addEventListener("click", () => openDetail(root, btn.dataset.view));
  });
  // The whole row opens the request too.
  root.querySelectorAll(".data-table tbody tr").forEach(tr => {
    tr.addEventListener("click", e => {
      if (e.target.closest("button, a")) return;
      const id = tr.querySelector("[data-view]")?.dataset.view;
      if (id) openDetail(root, id);
    });
  });
}
