// ---- Shared bootstrap for the standalone static pages ----
// terms.html, privacy.html and returns.html carry the same header, cart drawer
// and footer as the rest of the storefront. Those need the product catalog to
// fill the category mega-menu, the header quick links and the footer's "Belanja"
// column — this does that once instead of each page repeating it.
//
// The page content is static, so none of this is load-bearing: if the API is
// unreachable the policy text still renders and the menus simply stay empty.
(function () {
  const API = "/api";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let products = [];

  async function init() {
    // The cart drawer is shared markup, so keep it working across these pages.
    if (window.CartUI) {
      window.CartUI.init({ getProduct: id => products.find(p => p.id === Number(id)) });
    }

    try {
      const res = await fetch(`${API}/products`);
      if (!res.ok) return;
      products = await res.json();

      if (window.SiteHeader) {
        window.SiteHeader.init(products);

        const footerCats = document.getElementById("footerCategoryLinks");
        if (footerCats) {
          footerCats.innerHTML = window.SiteHeader.groupBy(products, "category")
            .slice(0, 5)
            .map(g => `<a href="${window.SiteHeader.categoryUrl(g.name)}">${esc(g.name)}</a>`)
            .join("");
        }
      }

      if (window.CartUI) window.CartUI.render();
    } catch {
      /* Offline or API down — the static content is what matters here. */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
