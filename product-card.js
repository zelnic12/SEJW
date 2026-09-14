// ---- Shared product card + formatting helpers ----
// Loaded as a plain <script> (no build step) and exposed on window.ProductCard
// so the homepage (script.js) and the category/brand listing pages (listing.js)
// render an identical card from one source of truth.
(function () {
  // Indonesian Rupiah: "Rp " prefix, thousands dots, no decimal cents.
  const money = n => "Rp " + Math.round(Number(n) || 0).toLocaleString("id-ID");

  // Escape any dynamic text before injecting into innerHTML.
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Discount helper. Returns { original, sale, pct } when a product is on sale,
  // else null. Uses the API's promo fields (salePrice/onSale/discountPercent)
  // with a legacy fallback.
  function discountInfo(p) {
    const original = Number(p.price);
    const sale = p.salePrice != null ? Number(p.salePrice) : Number(p.originalPrice != null ? p.price : NaN);
    const active = (p.onSale === true) || (Number.isFinite(sale) && sale >= 0 && sale < original);
    if (!active || !original || !Number.isFinite(sale) || sale >= original) return null;
    const pct = p.discountPercent || Math.round((1 - sale / original) * 100);
    return { original, sale, pct };
  }

  // Resolve an image reference to a renderable HTML fragment. Uploaded images
  // use a real URL; the seed placeholders use an "emoji:<char>" scheme.
  function imageMarkup(url, emoji, cls = "") {
    if (typeof url === "string" && url && !url.startsWith("emoji:")) {
      return `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" />`;
    }
    const glyph = (typeof url === "string" && url.startsWith("emoji:")) ? url.slice(6) : emoji;
    return `<span class="media-emoji ${cls}">${glyph || emoji}</span>`;
  }

  // The image to show for a product: the first REAL upload in position order,
  // falling back to the emoji glyph only when the product has no real photo.
  //
  // Preferring a real upload matters because the seed writes an "emoji:<char>"
  // placeholder at position 0, while an admin upload lands at maxpos + 1 — so
  // taking images[0] blindly would keep showing the glyph for products that do
  // have a photo. This matches how the server resolves order-item thumbnails and
  // how the admin product table picks its preview.
  function primaryImage(p) {
    const images = Array.isArray(p.images) ? p.images : [];
    const real = images.find(im => typeof im.url === "string" && im.url && !im.url.startsWith("emoji:"));
    if (real) return real.url;
    return images.length ? images[0].url : `emoji:${p.emoji}`;
  }

  // Sold out — stock is authoritative and comes straight from the API.
  const isOutOfStock = p => !(Number(p?.stock) > 0);

  /**
   * Move sold-out products to the end of a list, whatever the current sort is.
   *
   * Relies on Array#sort being stable (guaranteed since ES2019), so the order the
   * caller already established survives *within* each group: apply the shopper's
   * chosen sort first, then this, and you get "in stock, sorted" followed by
   * "sold out, sorted". Returns a new array; the input is left alone.
   */
  function outOfStockLast(list) {
    return [...list].sort((a, b) => Number(isOutOfStock(a)) - Number(isOutOfStock(b)));
  }

  // Effective (charged) price — promotional price when on sale, else regular.
  // Mirrors the server's authoritative rule; used for display math only.
  function priceOf(p) {
    if (p.effectivePrice != null) return Number(p.effectivePrice);
    const d = discountInfo(p);
    return d ? d.sale : Number(p.price);
  }

  // Star indicator for a card.
  // Prefers the review average (reviewCount/avgRating from GET /api/products) and
  // shows the number of reviews with it. When a product has no reviews yet we fall
  // back to the catalog's own `rating` field — which the API has always returned —
  // so a card always carries a visible rating instead of only the 2-3 products
  // that happen to have been reviewed.
  function ratingMarkup(p) {
    const reviewCount = Number(p.reviewCount) || 0;
    const reviewAvg = Number(p.avgRating) || 0;
    if (reviewCount > 0 && reviewAvg > 0) {
      return `<span class="card-rating" title="${reviewCount} customer review${reviewCount === 1 ? "" : "s"}">
        <span class="star" aria-hidden="true">★</span> ${reviewAvg.toFixed(1)}
        <span class="card-rating-count">(${reviewCount})</span>
      </span>`;
    }
    const catalogRating = Number(p.rating) || 0;
    if (catalogRating > 0) {
      return `<span class="card-rating" title="Rating — no customer reviews yet">
        <span class="star" aria-hidden="true">★</span> ${catalogRating.toFixed(1)}
      </span>`;
    }
    return `<span class="card-rating muted">Not rated yet</span>`;
  }

  // A single catalog card. `data-view` / `data-add` hooks are wired by renderGrid.
  function cardHTML(p) {
    const out = p.stock <= 0;
    const low = !out && p.stock <= 5;
    const stockTag = out
      ? `<span class="stock-pill out">Out of stock</span>`
      : low ? `<span class="stock-pill low">Only ${p.stock} left</span>` : "";
    const d = discountInfo(p);
    const saleTag = d ? `<span class="sale-badge">${d.pct}% OFF</span>` : "";
    const priceBlock = d
      ? `<div class="card-prices">
           <span class="card-price on-sale">${money(d.sale)}</span>
           <span class="price-original">${money(d.original)}</span>
         </div>`
      : `<span class="card-price">${money(p.price)}</span>`;
    return `
    <article class="card ${out ? "is-out" : ""}" data-view="${p.id}" tabindex="0" role="button" aria-label="View details for ${esc(p.name)}">
      <div class="card-media">${imageMarkup(primaryImage(p), p.emoji)}${stockTag}${saleTag}</div>
      <div class="card-body">
        <span class="card-cat">${esc(p.brand)} · ${esc(p.category)}</span>
        <span class="card-name">${esc(p.name)}</span>
        ${ratingMarkup(p)}
        <div class="card-bottom">
          ${priceBlock}
          <button class="add-btn" data-add="${p.id}" ${out ? "disabled" : ""}>${out ? "Sold out" : "Add to cart"}</button>
        </div>
      </div>
    </article>`;
  }

  // Render a list of products into a container and wire the card interactions.
  // onOpen(id) — card click / Enter / Space. onAdd(id) — the add-to-cart button.
  function renderGrid(container, list, { onOpen, onAdd } = {}) {
    if (!container) return;
    container.innerHTML = list.map(cardHTML).join("");

    if (onAdd) {
      container.querySelectorAll("[data-add]").forEach(btn => {
        btn.addEventListener("click", e => {
          e.stopPropagation();               // don't open the detail view
          onAdd(Number(btn.dataset.add));
        });
      });
    }
    if (onOpen) {
      container.querySelectorAll("[data-view]").forEach(card => {
        const open = () => onOpen(Number(card.dataset.view));
        card.addEventListener("click", open);
        card.addEventListener("keydown", e => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
        });
      });
    }
  }

  window.ProductCard = {
    money, esc, discountInfo, imageMarkup, primaryImage, priceOf, ratingMarkup, cardHTML, renderGrid,
    isOutOfStock, outOfStockLast,
  };
})();
