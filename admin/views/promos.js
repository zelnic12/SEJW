// Admin Promo Codes view: table (with usage) + create form + active toggle.
import { api } from "../components/api.js";
import { money, esc, fmtDate } from "../components/format.js";
import { dataTable } from "../components/dataTable.js";
import { openModal } from "../components/modal.js";
import { toast } from "../components/toast.js";

function discountLabel(p) {
  return p.discountType === "percentage" ? `${p.discountValue}%` : money(p.discountValue);
}
function usageLabel(p) {
  return p.maxUses == null ? `${p.usedCount} / ∞` : `${p.usedCount} / ${p.maxUses}`;
}
function statusBadge(p) {
  const expired = p.expiresAt && new Date(p.expiresAt).getTime() < Date.now();
  const exhausted = p.maxUses != null && p.usedCount >= p.maxUses;
  if (!p.isActive) return `<span class="badge cancelled">Inactive</span>`;
  if (expired) return `<span class="badge cancelled">Expired</span>`;
  if (exhausted) return `<span class="badge cancelled">Exhausted</span>`;
  return `<span class="badge completed">Active</span>`;
}

function createForm(root) {
  openModal({
    title: "Create promo code",
    bodyHTML: `
      <form id="promoForm">
        <div class="form-grid">
          <div class="form-field full"><label>Code *</label><input name="code" placeholder="e.g. SHOPEE15" required /></div>
          <div class="form-field"><label>Discount type *</label>
            <select name="discountType" id="pfType">
              <option value="percentage">Percentage (%)</option>
              <option value="fixed_amount">Fixed amount (Rp)</option>
            </select>
          </div>
          <div class="form-field"><label>Discount value *</label><input name="discountValue" type="number" min="0" step="0.01" required /></div>
          <div class="form-field"><label>Max uses (blank = unlimited)</label><input name="maxUses" type="number" min="0" step="1" placeholder="unlimited" /></div>
          <div class="form-field"><label>Expires at (blank = never)</label><input name="expiresAt" type="date" /></div>
        </div>
        <p class="form-error" id="promoErr" hidden></p>
      </form>`,
    footHTML: `
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="promoSave">Create code</button>`,
    onMount(overlay, close) {
      overlay.querySelector("#promoSave").addEventListener("click", async () => {
        const form = overlay.querySelector("#promoForm");
        const err = overlay.querySelector("#promoErr");
        const fd = new FormData(form);
        const code = String(fd.get("code") || "").trim();
        const discountType = fd.get("discountType");
        const discountValue = Number(fd.get("discountValue"));
        const maxUsesRaw = String(fd.get("maxUses") || "").trim();
        const expiresRaw = String(fd.get("expiresAt") || "").trim();

        if (code.length < 2) { err.textContent = "Code must be at least 2 characters."; err.hidden = false; return; }
        if (!Number.isFinite(discountValue) || discountValue < 0) { err.textContent = "Enter a valid discount value."; err.hidden = false; return; }
        if (discountType === "percentage" && discountValue > 100) { err.textContent = "Percentage cannot exceed 100."; err.hidden = false; return; }

        const payload = {
          code, discountType, discountValue,
          maxUses: maxUsesRaw === "" ? null : parseInt(maxUsesRaw, 10),
          // Expire at end of the chosen day.
          expiresAt: expiresRaw === "" ? null : new Date(expiresRaw + "T23:59:59").toISOString(),
          isActive: true,
        };
        try {
          await api.createPromoCode(payload);
          toast("Promo code created", "success");
          close();
          renderPromos(root);
        } catch (e) { err.textContent = e.message; err.hidden = false; }
      });
    },
  });
}

export async function renderPromos(root) {
  root.innerHTML = `<p class="admin-status">Loading promo codes…</p>`;
  let codes;
  try {
    codes = await api.listPromoCodes();
  } catch (err) {
    root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`;
    return;
  }

  const table = dataTable({
    columns: [
      { key: "code", label: "Code", render: r => `<strong style="font-family:monospace">${esc(r.code)}</strong>` },
      { key: "discount", label: "Discount", render: r => discountLabel(r) },
      { key: "usage", label: "Used", render: r => usageLabel(r) },
      { key: "expires", label: "Expires", render: r => r.expiresAt ? fmtDate(r.expiresAt) : "—" },
      { key: "status", label: "Status", render: r => statusBadge(r) },
      { key: "actions", label: "", render: r => `
        <div class="row-actions">
          <button class="icon-action" data-toggle="${r.id}" data-active="${r.isActive}">${r.isActive ? "Deactivate" : "Activate"}</button>
        </div>` },
    ],
    rows: codes,
    empty: "No promo codes yet.",
  });

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Promo codes (${codes.length})</h2>
        <button class="btn btn-primary btn-sm" id="addPromoBtn">+ Create code</button>
      </div>
      ${table}
    </div>`;

  root.querySelector("#addPromoBtn").addEventListener("click", () => createForm(root));

  root.querySelectorAll("[data-toggle]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.toggle;
      const nowActive = btn.dataset.active === "true";
      try {
        await api.updatePromoCode(id, { isActive: !nowActive });
        toast(nowActive ? "Code deactivated" : "Code activated", "success");
        renderPromos(root);
      } catch (e) { toast(e.message, "error"); }
    });
  });
}
