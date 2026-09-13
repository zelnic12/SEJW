// Admin Categories view: every category the catalog actually uses, with the icon
// the storefront shows for it and a control to upload/replace or clear a custom
// photo.
//
// Categories aren't records here — they're still the distinct products.category
// values — so this screen lists what the catalog has and only manages the
// optional icon override per name.
import { api } from "../components/api.js";
import { esc } from "../components/format.js";
import { toast } from "../components/toast.js";
import { confirmDialog } from "../components/modal.js";

// The same generic fallbacks the storefront uses (category-icons.js is loaded by
// admin.html), so this preview matches what shoppers actually see.
const fallbackIcon = name =>
  window.CategoryIcons ? window.CategoryIcons.iconFor(name) : "";

const preview = c => c.iconUrl
  ? `<span class="cat-admin-icon has-photo"><img src="${esc(c.iconUrl)}" alt="" /></span>`
  : `<span class="cat-admin-icon">${fallbackIcon(c.name)}</span>`;

export async function renderCategories(root) {
  root.innerHTML = `<p class="admin-status">Loading categories…</p>`;

  let categories;
  try {
    categories = await api.listCategories();
  } catch (err) {
    root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`;
    return;
  }

  const withIcons = categories.filter(c => c.iconUrl).length;

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Categories (${categories.length})</h2>
        <span class="muted-sm">${withIcons} of ${categories.length} have a custom photo</span>
      </div>
      <p class="panel-note">
        These come from the categories used by your products — add or rename a category on a
        product and it shows up here. Upload a square photo (JPG, PNG or WebP, max 5 MB) to
        replace the generic icon on the homepage's <strong>Browse by category</strong> row.
        The category name and item count always stay visible under it.
      </p>

      ${categories.length === 0
        ? `<p class="admin-status">No categories yet — they appear once products have one.</p>`
        : `<div class="cat-admin-grid">
            ${categories.map(c => `
              <div class="cat-admin-card" data-category="${esc(c.name)}">
                ${preview(c)}
                <div class="cat-admin-meta">
                  <strong>${esc(c.name)}</strong>
                  <span class="muted-sm">${c.productCount} product${c.productCount === 1 ? "" : "s"}${
                    c.iconUrl ? " · custom photo" : " · generic icon"}</span>
                </div>
                <div class="cat-admin-actions">
                  <input type="file" class="cat-admin-file" accept="image/jpeg,image/png,image/webp" hidden />
                  <button class="btn btn-secondary btn-sm" data-act="upload">
                    ${c.iconUrl ? "Replace photo" : "Upload photo"}
                  </button>
                  ${c.iconUrl ? `<button class="icon-action danger" data-act="clear">Remove</button>` : ""}
                </div>
                <p class="form-error cat-admin-error" hidden></p>
              </div>`).join("")}
          </div>`}
    </div>`;

  root.querySelectorAll(".cat-admin-card").forEach(card => {
    const name = card.dataset.category;
    const fileInput = card.querySelector(".cat-admin-file");
    const uploadBtn = card.querySelector('[data-act="upload"]');
    const clearBtn = card.querySelector('[data-act="clear"]');
    const err = card.querySelector(".cat-admin-error");

    uploadBtn.addEventListener("click", () => { err.hidden = true; fileInput.click(); });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const label = uploadBtn.textContent;
      uploadBtn.disabled = true; uploadBtn.textContent = "Uploading…";
      try {
        await api.uploadCategoryIcon(name, file);
        toast(`Icon updated for “${name}”`, "success");
        renderCategories(root);
      } catch (e) {
        err.textContent = e.message; err.hidden = false;
        uploadBtn.disabled = false; uploadBtn.textContent = label;
      } finally {
        fileInput.value = "";
      }
    });

    clearBtn?.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Remove custom photo",
        message: `“${name}” will go back to the generic icon on the homepage.`,
        confirmText: "Remove", danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteCategoryIcon(name);
        toast("Custom photo removed", "success");
        renderCategories(root);
      } catch (e) { toast(e.message, "error"); }
    });
  });
}
