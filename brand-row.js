// ---- "Shop by Brand" row ----
// Renders one tile per distinct brand in the catalog (never a hardcoded list),
// each linking to that brand's listing page. A brand with a logo file in
// /assets/brands shows the image; every other brand shows its name in a bordered
// pill, so there are no broken-image icons.
// Exposed on window.BrandRow.
(function () {
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Must match brandSlug() in server/src/routes/brand-logos.js.
  function brandSlug(name) {
    return String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  // Which brands have a logo on disk. Failure is not fatal — we just render
  // text pills, which is the designed fallback anyway.
  async function loadLogoMap() {
    try {
      const res = await fetch("/api/brand-logos");
      if (!res.ok) return {};
      const map = await res.json();
      return (map && typeof map === "object") ? map : {};
    } catch {
      return {};
    }
  }

  function tileHTML(brand, logoUrl) {
    const url = `brand.html?name=${encodeURIComponent(brand.name)}`;
    const count = `${brand.count} product${brand.count === 1 ? "" : "s"}`;
    // With a logo the name is still in aria-label, so the link stays readable
    // to screen readers and the tile isn't image-only.
    const inner = logoUrl
      ? `<img class="brand-tile-logo" src="${esc(logoUrl)}" alt="${esc(brand.name)}" loading="lazy" />`
      : `<span class="brand-tile-name">${esc(brand.name)}</span>`;
    return `
      <a class="brand-tile ${logoUrl ? "has-logo" : "no-logo"}" href="${url}"
         aria-label="${esc(brand.name)} — ${count}">
        <span class="brand-tile-frame">${inner}</span>
        <span class="brand-tile-count">${count}</span>
      </a>`;
  }

  /**
   * Render the row.
   * @param {string|Element} target  container for the tiles (e.g. "#brandRow")
   * @param {Array} products         catalog from GET /api/products
   */
  async function render(target, products) {
    const row = typeof target === "string" ? document.querySelector(target) : target;
    if (!row) return;
    const section = row.closest(".brand-row-section");

    // Same grouping helper the category row uses, so counts stay consistent.
    const brands = window.SiteHeader.groupBy(products || [], "brand");
    if (!brands.length) {
      if (section) section.hidden = true;      // no catalog → no empty section
      return;
    }

    const logos = await loadLogoMap();
    row.innerHTML = brands.map(b => tileHTML(b, logos[brandSlug(b.name)])).join("");
    if (section) section.hidden = false;
  }

  window.BrandRow = { render, brandSlug };
})();
