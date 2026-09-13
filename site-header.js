// ---- Shared storefront header behaviour ----
// Fills the "Categories" mega-menu and the slim secondary link row from the
// live catalog (never a hardcoded list), and wires the menu open/close +
// keyboard handling. Used by index.html, category.html and brand.html.
// Exposed on window.SiteHeader.
(function () {
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Count products per key, returning [{ name, count }] sorted by name.
  function groupBy(products, key) {
    const counts = new Map();
    for (const p of products) {
      const value = p[key];
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const categoryUrl = name => `category.html?name=${encodeURIComponent(name)}`;
  const brandUrl = name => `brand.html?name=${encodeURIComponent(name)}`;

  function fillMegaMenu(products, active) {
    const catWrap = document.getElementById("megaCategories");
    const brandWrap = document.getElementById("megaBrands");
    if (catWrap) {
      const categories = groupBy(products, "category");
      catWrap.innerHTML = categories.map(c => `
        <a class="mega-item ${active.category === c.name ? "is-active" : ""}" href="${categoryUrl(c.name)}">
          <span class="mega-item-icon">${window.CategoryIcons ? window.CategoryIcons.iconFor(c.name) : ""}</span>
          <span class="mega-item-text">
            <span class="mega-item-name">${esc(c.name)}</span>
            <span class="mega-item-count">${c.count} product${c.count === 1 ? "" : "s"}</span>
          </span>
        </a>`).join("");
    }
    if (brandWrap) {
      // Brands with the most products first, capped so the panel stays readable.
      const brands = groupBy(products, "brand").sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      brandWrap.innerHTML = brands.slice(0, 8).map(b =>
        `<a class="mega-brand ${active.brand === b.name ? "is-active" : ""}" href="${brandUrl(b.name)}">${esc(b.name)}</a>`
      ).join("");
    }
  }

  // Secondary row: only links that actually resolve (dynamic categories +
  // the full catalog). No placeholder pages, so there are no dead links.
  function fillQuickLinks(products, active) {
    const wrap = document.getElementById("headerQuickLinks");
    if (!wrap) return;
    const categories = groupBy(products, "category")
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 6)
      .sort((a, b) => a.name.localeCompare(b.name));
    wrap.innerHTML = categories.map(c =>
      `<a class="sub-link ${active.category === c.name ? "is-active" : ""}" href="${categoryUrl(c.name)}">${esc(c.name)}</a>`
    ).join("");
  }

  function wireMenu() {
    const btn = document.getElementById("catMenuBtn");
    const panel = document.getElementById("catMenuPanel");
    const root = document.getElementById("catMenu");
    if (!btn || !panel || !root) return;
    if (btn.dataset.wired === "1") return;   // init() may run again after a reload
    btn.dataset.wired = "1";

    const open = () => {
      panel.hidden = false;
      root.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
    };
    const close = ({ focusBtn = false } = {}) => {
      panel.hidden = true;
      root.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
      if (focusBtn) btn.focus();
    };

    btn.addEventListener("click", e => {
      e.stopPropagation();
      panel.hidden ? open() : close();
    });
    // Click outside closes.
    document.addEventListener("click", e => {
      if (!panel.hidden && !root.contains(e.target)) close();
    });
    // Escape closes and returns focus to the trigger.
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !panel.hidden) close({ focusBtn: true });
    });
    // Tabbing out of the menu closes it.
    root.addEventListener("focusout", e => {
      if (!panel.hidden && !root.contains(e.relatedTarget)) close();
    });
  }

  // products: array from GET /api/products.
  // active: { category, brand } — highlights the current page's link.
  function init(products, active = {}) {
    fillMegaMenu(products || [], active);
    fillQuickLinks(products || [], active);
    wireMenu();
  }

  window.SiteHeader = { init, categoryUrl, brandUrl, groupBy };
})();
