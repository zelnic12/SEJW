// Admin Banners view: manage the homepage hero carousel slides.
// List (preview + headline + status) with reorder / activate / edit / delete,
// plus a create-or-edit form that accepts an uploaded image or a pasted URL.
import { api } from "../components/api.js";
import { esc } from "../components/format.js";
import { dataTable } from "../components/dataTable.js";
import { openModal, confirmDialog } from "../components/modal.js";
import { toast } from "../components/toast.js";

const DEFAULT_BG = "#C8102E";

// Small preview: the image when there is one, otherwise the background colour.
function preview(b) {
  return b.imageUrl
    ? `<span class="banner-thumb"><img src="${esc(b.imageUrl)}" alt="" /></span>`
    : `<span class="banner-thumb banner-swatch" style="background:${esc(b.backgroundColor || DEFAULT_BG)}"></span>`;
}

function statusBadge(b) {
  return b.isActive
    ? `<span class="badge completed">Active</span>`
    : `<span class="badge cancelled">Inactive</span>`;
}

function ctaLabel(b) {
  if (!b.ctaText) return "—";
  return b.ctaLink
    ? `${esc(b.ctaText)} <span class="muted-sm">→ ${esc(b.ctaLink)}</span>`
    : esc(b.ctaText);
}

// Create (banner = null) or edit an existing slide.
function bannerForm(root, banner = null) {
  const editing = !!banner;
  const b = banner || {};
  // Local copy of the image URL: set by uploading a file or pasting a URL.
  let imageUrl = b.imageUrl || "";

  openModal({
    title: editing ? `Edit banner #${b.id}` : "Add banner",
    bodyHTML: `
      <form id="bannerForm">
        <div class="form-grid">
          <div class="form-field full">
            <label>Headline *</label>
            <input name="headline" maxlength="120" value="${esc(b.headline || "")}" placeholder="e.g. Promo laptop pilihan" required />
          </div>
          <div class="form-field full">
            <label>Subtext</label>
            <textarea name="subtext" rows="2" maxlength="300" placeholder="Short supporting line">${esc(b.subtext || "")}</textarea>
          </div>
          <div class="form-field"><label>CTA button text</label><input name="ctaText" maxlength="40" value="${esc(b.ctaText || "")}" placeholder="e.g. Lihat laptop" /></div>
          <div class="form-field"><label>CTA link</label><input name="ctaLink" value="${esc(b.ctaLink || "")}" placeholder="category.html?name=Laptops" /></div>

          <div class="form-field full">
            <label>Background image</label>
            <div class="banner-image-row">
              <span class="banner-thumb" id="bfPreview">${
                imageUrl ? `<img src="${esc(imageUrl)}" alt="" />` : `<span class="banner-swatch" style="background:${esc(b.backgroundColor || DEFAULT_BG)}"></span>`
              }</span>
              <div class="banner-image-inputs">
                <input type="file" id="bfFile" accept="image/jpeg,image/png,image/webp" />
                <input type="url" id="bfUrl" value="${esc(imageUrl)}" placeholder="…or paste an image URL" />
                <button type="button" class="btn btn-ghost btn-sm" id="bfClearImage">Remove image</button>
              </div>
            </div>
            <p class="form-hint">Upload a JPG/PNG/WebP (max 5 MB) or paste a URL. With no image the slide uses the colour below.</p>
          </div>

          <div class="form-field">
            <label>Background colour (used when there is no image)</label>
            <input name="backgroundColor" type="text" value="${esc(b.backgroundColor || DEFAULT_BG)}" placeholder="#C8102E" />
          </div>
          <div class="form-field">
            <label>Active</label>
            <select name="isActive">
              <option value="true" ${b.isActive === false ? "" : "selected"}>Active (shown on the homepage)</option>
              <option value="false" ${b.isActive === false ? "selected" : ""}>Inactive (hidden)</option>
            </select>
          </div>
        </div>
        <p class="form-error" id="bannerErr" hidden></p>
      </form>`,
    footHTML: `
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="bannerSave">${editing ? "Save changes" : "Add banner"}</button>`,
    onMount(overlay, close) {
      const err = overlay.querySelector("#bannerErr");
      const previewEl = overlay.querySelector("#bfPreview");
      const urlInput = overlay.querySelector("#bfUrl");
      const fileInput = overlay.querySelector("#bfFile");
      const colourInput = overlay.querySelector('[name="backgroundColor"]');

      function paintPreview() {
        previewEl.innerHTML = imageUrl
          ? `<img src="${esc(imageUrl)}" alt="" />`
          : `<span class="banner-swatch" style="background:${esc(colourInput.value || DEFAULT_BG)}"></span>`;
      }

      // Upload immediately so the preview is real (reuses the product-image
      // upload mechanism on the server: multer → /uploads/banners/<file>).
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        err.hidden = true;
        try {
          const { url } = await api.uploadBannerImage(file);
          imageUrl = url;
          urlInput.value = url;
          paintPreview();
          toast("Image uploaded", "success");
        } catch (e) {
          err.textContent = e.message; err.hidden = false;
        } finally {
          fileInput.value = "";
        }
      });
      urlInput.addEventListener("input", () => { imageUrl = urlInput.value.trim(); paintPreview(); });
      colourInput.addEventListener("input", paintPreview);
      overlay.querySelector("#bfClearImage").addEventListener("click", () => {
        imageUrl = ""; urlInput.value = ""; paintPreview();
      });

      overlay.querySelector("#bannerSave").addEventListener("click", async () => {
        const form = overlay.querySelector("#bannerForm");
        const fd = new FormData(form);
        const headline = String(fd.get("headline") || "").trim();
        if (headline.length < 2) {
          err.textContent = "Headline must be at least 2 characters."; err.hidden = false; return;
        }
        const backgroundColor = String(fd.get("backgroundColor") || "").trim();
        if (backgroundColor && !/^#[0-9a-f]{3,8}$/i.test(backgroundColor)) {
          err.textContent = "Background colour must be a hex value like #C8102E."; err.hidden = false; return;
        }
        const payload = {
          headline,
          subtext: String(fd.get("subtext") || "").trim(),
          ctaText: String(fd.get("ctaText") || "").trim(),
          ctaLink: String(fd.get("ctaLink") || "").trim(),
          imageUrl,
          backgroundColor,
          isActive: fd.get("isActive") === "true",
        };
        try {
          if (editing) await api.updateBanner(b.id, payload);
          else await api.createBanner(payload);
          toast(editing ? "Banner updated" : "Banner added", "success");
          close();
          renderBanners(root);
        } catch (e) { err.textContent = e.message; err.hidden = false; }
      });
    },
  });
}

export async function renderBanners(root) {
  root.innerHTML = `<p class="admin-status">Loading banners…</p>`;
  let banners;
  try {
    banners = await api.listBanners();
  } catch (err) {
    root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`;
    return;
  }

  const activeCount = banners.filter(b => b.isActive).length;

  const table = dataTable({
    columns: [
      { key: "preview", label: "Preview", render: r => preview(r) },
      { key: "headline", label: "Headline", render: r => `
        <div>
          <strong>${esc(r.headline)}</strong>
          ${r.subtext ? `<div class="muted-sm">${esc(r.subtext)}</div>` : ""}
        </div>` },
      { key: "cta", label: "CTA", render: r => ctaLabel(r) },
      // dataTable renders one row at a time, so derive the position here.
      { key: "order", label: "Order", render: r => {
        const i = banners.indexOf(r);
        return `
        <div class="order-btns">
          <button class="icon-action" data-up="${r.id}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button class="icon-action" data-down="${r.id}" ${i === banners.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
        </div>`;
      } },
      { key: "status", label: "Status", render: r => statusBadge(r) },
      { key: "actions", label: "", render: r => `
        <div class="row-actions">
          <button class="icon-action" data-edit="${r.id}">Edit</button>
          <button class="icon-action" data-toggle="${r.id}" data-active="${r.isActive}">${r.isActive ? "Deactivate" : "Activate"}</button>
          <button class="icon-action danger" data-delete="${r.id}">Delete</button>
        </div>` },
    ],
    rows: banners,
    empty: "No banners yet — add one to show a carousel on the homepage.",
  });

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Homepage banners (${banners.length})</h2>
        <button class="btn btn-primary btn-sm" id="addBannerBtn">+ Add banner</button>
      </div>
      <p class="panel-note">
        ${activeCount === 0
          ? "No active slides — the homepage carousel is hidden right now."
          : `${activeCount} active slide${activeCount === 1 ? "" : "s"}, shown in the order below.`}
      </p>
      ${table}
    </div>`;

  root.querySelector("#addBannerBtn").addEventListener("click", () => bannerForm(root));

  root.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => {
      const banner = banners.find(b => String(b.id) === btn.dataset.edit);
      if (banner) bannerForm(root, banner);
    });
  });

  root.querySelectorAll("[data-toggle]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const nowActive = btn.dataset.active === "true";
      try {
        await api.updateBanner(btn.dataset.toggle, { isActive: !nowActive });
        toast(nowActive ? "Banner deactivated" : "Banner activated", "success");
        renderBanners(root);
      } catch (e) { toast(e.message, "error"); }
    });
  });

  root.querySelectorAll("[data-delete]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const banner = banners.find(b => String(b.id) === btn.dataset.delete);
      const ok = await confirmDialog({
        title: "Delete banner?",
        message: `“${banner ? banner.headline : "This slide"}” will be removed from the homepage carousel.`,
        confirmText: "Delete",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteBanner(btn.dataset.delete);
        toast("Banner deleted", "success");
        renderBanners(root);
      } catch (e) { toast(e.message, "error"); }
    });
  });

  // Reorder with up/down: swap the slide with its neighbour and send the new order.
  async function move(id, delta) {
    const order = banners.map(b => b.id);
    const from = order.indexOf(Number(id));
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    try {
      await api.reorderBanners(order);
      renderBanners(root);
    } catch (e) { toast(e.message, "error"); }
  }
  root.querySelectorAll("[data-up]").forEach(btn =>
    btn.addEventListener("click", () => move(btn.dataset.up, -1)));
  root.querySelectorAll("[data-down]").forEach(btn =>
    btn.addEventListener("click", () => move(btn.dataset.down, 1)));
}
