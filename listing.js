// ---- Category / brand listing page ----
// Drives both category.html?name=Laptops and brand.html?name=Pulse. The page
// mode comes from <body data-listing="category|brand">; everything else (cards,
// cart drawer, header mega-menu) is the shared storefront code.
(function () {
  const { esc } = window.ProductCard;
  const $ = sel => document.querySelector(sel);

  const MODE = document.body.dataset.listing === "brand" ? "brand" : "category";
  const NAME = (new URLSearchParams(location.search).get("name") || "").trim();
  // On a category page the extra filter is by brand, and vice versa.
  const SECONDARY = MODE === "category" ? "brand" : "category";

  let PRODUCTS = [];   // full catalog (needed by the header menu + cart)
  let GROUP = [];      // just the products in this category/brand

  const state = { search: "", sort: "featured", secondary: "All" };

  const getProduct = id => PRODUCTS.find(p => p.id === Number(id));

  function visibleProducts() {
    let list = GROUP.filter(p => {
      const matchSecondary = state.secondary === "All" || p[SECONDARY] === state.secondary;
      const q = state.search;
      const matchSearch = !q
        || p.name.toLowerCase().includes(q)
        || p.brand.toLowerCase().includes(q)
        || p.category.toLowerCase().includes(q);
      return matchSecondary && matchSearch;
    });
    switch (state.sort) {
      case "price-asc": list.sort((a, b) => a.price - b.price); break;
      case "price-desc": list.sort((a, b) => b.price - a.price); break;
      case "rating": list.sort((a, b) => b.rating - a.rating); break;
    }
    return list;
  }

  function renderSecondaryFilters() {
    const wrap = $("#secondaryFilters");
    const values = [...new Set(GROUP.map(p => p[SECONDARY]))].sort((a, b) => a.localeCompare(b));
    // Nothing to narrow down when everything shares the same brand/category.
    if (values.length < 2) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = ["All", ...values].map(v =>
      `<button class="filter-chip ${v === state.secondary ? "active" : ""}" data-value="${esc(v)}">${esc(v)}</button>`
    ).join("");
    wrap.querySelectorAll(".filter-chip").forEach(btn => {
      btn.addEventListener("click", () => {
        state.secondary = btn.dataset.value;
        renderSecondaryFilters();
        renderList();
      });
    });
  }

  function renderList() {
    const list = visibleProducts();
    $("#emptyState").hidden = list.length !== 0;
    // "Laptops (14 products)" — plus a "showing" line when a filter is narrowing.
    const total = GROUP.length;
    const countEl = $("#listingCount");
    countEl.textContent = list.length === total
      ? `${total} product${total === 1 ? "" : "s"}`
      : `Showing ${list.length} of ${total} product${total === 1 ? "" : "s"}`;

    window.ProductCard.renderGrid($("#productGrid"), list, {
      // The full detail view (with reviews) lives on the homepage modal.
      onOpen: id => { window.location.href = `index.html#product/${id}`; },
      onAdd: id => window.CartUI.add(id),
    });
  }

  function renderFooterLinks() {
    const wrap = $("#footerCategoryLinks");
    if (!wrap) return;
    wrap.innerHTML = window.SiteHeader.groupBy(PRODUCTS, "category")
      .slice(0, 5)
      .map(g => `<a href="${window.SiteHeader.categoryUrl(g.name)}">${esc(g.name)}</a>`)
      .join("");
  }

  function renderHeading(found) {
    const label = MODE === "category" ? "category" : "brand";
    const title = found ? NAME : (NAME || `Unknown ${label}`);
    $("#listingTitle").textContent = title;
    $("#crumbCurrent").textContent = title;
    document.title = `${title} — Sinar Elektronik`;
    // A category gets its generic icon; brands show the neutral tag glyph.
    const icon = $("#listingIcon");
    if (icon) {
      icon.innerHTML = MODE === "category"
        ? window.CategoryIcons.iconFor(NAME)
        : window.CategoryIcons.TAG;
    }
  }

  function showNotFound() {
    const label = MODE === "category" ? "category" : "brand";
    $("#listingCount").textContent = "";
    $("#secondaryFilters").innerHTML = "";
    $("#sortSelect").hidden = true;
    $("#productGrid").innerHTML = `
      <div class="grid-status">
        <p>${NAME
          ? `We couldn't find any products in the ${label} “${esc(NAME)}”.`
          : `No ${label} was specified.`}</p>
        <a class="btn btn-primary" href="index.html#catalog">Browse the full catalog</a>
      </div>`;
  }

  // ---- Events ----
  $("#searchInput").addEventListener("input", e => {
    state.search = e.target.value.trim().toLowerCase();
    renderList();
  });
  $("#sortSelect").addEventListener("change", e => {
    state.sort = e.target.value;
    renderList();
  });

  async function init() {
    window.CartUI.init({ getProduct });
    $("#productGrid").innerHTML = `<p class="grid-status">Loading products…</p>`;

    try {
      const res = await fetch("/api/products");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      PRODUCTS = await res.json();
    } catch (err) {
      console.error(err);
      $("#productGrid").innerHTML = `
        <div class="grid-status error">
          <p>Sorry — we couldn't load the catalog.</p>
          <a class="btn btn-primary" href="index.html">Back to home</a>
        </div>`;
      return;
    }

    // Match case-insensitively so hand-typed URLs still work.
    GROUP = PRODUCTS.filter(p => String(p[MODE]).toLowerCase() === NAME.toLowerCase());

    window.SiteHeader.init(PRODUCTS, { [MODE]: GROUP[0] ? GROUP[0][MODE] : NAME });
    renderFooterLinks();
    window.CartUI.render();

    if (!NAME || GROUP.length === 0) {
      renderHeading(false);
      showNotFound();
      return;
    }
    // Use the catalog's own casing for the visible title.
    renderHeading(true);
    $("#listingTitle").textContent = GROUP[0][MODE];
    $("#crumbCurrent").textContent = GROUP[0][MODE];
    renderSecondaryFilters();
    renderList();
  }

  init();
})();
