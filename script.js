// ---- Product data ----
// Products are loaded from the backend API (GET /api/products) at startup.
// These are populated by init(); no hardcoded catalog lives here anymore.
let PRODUCTS = [];
let CATEGORIES = ["All"];

const API_BASE = "/api";

// Fetch the catalog from the API and refresh derived data.
async function loadProducts() {
  const res = await fetch(`${API_BASE}/products`);
  if (!res.ok) throw new Error(`Failed to load products (HTTP ${res.status})`);
  PRODUCTS = await res.json();
  CATEGORIES = ["All", ...new Set(PRODUCTS.map(p => p.category))];
}

// ---- State ----
// Cart state + drawer rendering live in cart-ui.js (shared with the listing pages).
let state = {
  category: "All",
  search: "",
  sort: "featured",
};

// ---- Helpers ----
// Formatting, discount and card helpers live in product-card.js so the homepage
// and the category/brand listing pages share one implementation.
const { money, esc, discountInfo, imageMarkup, primaryImage, priceOf } = window.ProductCard;
const $ = sel => document.querySelector(sel);
const getProduct = id => PRODUCTS.find(p => p.id === Number(id));
// Cart operations are delegated to the shared drawer module.
const addToCart = (id, qty = 1) => window.CartUI.add(id, qty);
const cartEntries = () => window.CartUI.entries();

// ---- Render category filters ----
function renderFilters() {
  const wrap = $("#categoryFilters");
  wrap.innerHTML = CATEGORIES.map(cat =>
    `<button class="filter-chip ${cat === state.category ? "active" : ""}" data-cat="${esc(cat)}">${esc(cat)}</button>`
  ).join("");
  wrap.querySelectorAll(".filter-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      state.category = btn.dataset.cat;
      renderFilters();
      renderProducts();
    });
  });
}

// ---- Render products ----
function getVisibleProducts() {
  let list = PRODUCTS.filter(p => {
    const matchCat = state.category === "All" || p.category === state.category;
    const matchSearch =
      p.name.toLowerCase().includes(state.search) ||
      p.brand.toLowerCase().includes(state.search) ||
      p.category.toLowerCase().includes(state.search);
    return matchCat && matchSearch;
  });

  switch (state.sort) {
    case "price-asc": list.sort((a, b) => a.price - b.price); break;
    case "price-desc": list.sort((a, b) => b.price - a.price); break;
    case "rating": list.sort((a, b) => b.rating - a.rating); break;
  }
  return list;
}

function renderProducts() {
  const list = getVisibleProducts();
  $("#emptyState").hidden = list.length !== 0;
  window.ProductCard.renderGrid($("#productGrid"), list, {
    onOpen: openProduct,
    onAdd: id => addToCart(id),
  });
}

// ---- Quick category navigation (icon + label row) ----
// Built from the catalog, so a category added to a product later shows up here
// automatically. Each tile links to that category's pre-filtered listing page.
function renderCategoryRow() {
  const row = $("#categoryIconRow");
  if (!row) return;
  const groups = window.SiteHeader.groupBy(PRODUCTS, "category");
  if (!groups.length) {
    row.closest(".cat-nav-section")?.setAttribute("hidden", "");
    return;
  }
  row.innerHTML = groups.map(g => `
    <a class="cat-tile" href="${window.SiteHeader.categoryUrl(g.name)}">
      <span class="cat-tile-icon">${window.CategoryIcons.iconFor(g.name)}</span>
      <span class="cat-tile-name">${esc(g.name)}</span>
      <span class="cat-tile-count">${g.count} item${g.count === 1 ? "" : "s"}</span>
    </a>`).join("");
}

// ---- Exclusive deals ----
// Only products with an active promotional price. Hidden entirely when none are
// discounted, so the homepage never shows an empty section.
function renderDeals() {
  const section = $("#deals");
  const grid = $("#dealsGrid");
  if (!section || !grid) return;
  const deals = PRODUCTS
    .filter(p => discountInfo(p))
    .sort((a, b) => (discountInfo(b)?.pct || 0) - (discountInfo(a)?.pct || 0))
    .slice(0, 8);
  if (!deals.length) { section.hidden = true; return; }
  section.hidden = false;
  window.ProductCard.renderGrid(grid, deals, {
    onOpen: openProduct,
    onAdd: id => addToCart(id),
  });
}

// Footer "Belanja" column — real category links only (no dead placeholders).
function renderFooterLinks() {
  const wrap = $("#footerCategoryLinks");
  if (!wrap) return;
  wrap.innerHTML = window.SiteHeader.groupBy(PRODUCTS, "category")
    .slice(0, 5)
    .map(g => `<a href="${window.SiteHeader.categoryUrl(g.name)}">${esc(g.name)}</a>`)
    .join("");
}

// ---- Product detail view ----
function renderProductDetail(product) {
  const out = product.stock <= 0;
  const low = !out && product.stock <= 5;
  const stockLine = out
    ? `<span class="detail-stock out">● Out of stock</span>`
    : low ? `<span class="detail-stock low">● Only ${product.stock} left in stock</span>`
          : `<span class="detail-stock in">● In stock (${product.stock} available)</span>`;

  const specsRows = Object.entries(product.specs)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join("");

  // Image gallery. If a product has multiple images, show a thumbnail strip
  // that swaps the main image on click. With ≤1 image, no gallery is shown.
  const imgs = (product.images && product.images.length) ? product.images : [{ url: `emoji:${product.emoji}` }];
  const mainUrl = imgs[0].url;
  const gallery = imgs.length > 1
    ? `<div class="detail-thumbs" role="listbox" aria-label="Product images">
         ${imgs.map((im, i) => `
           <button type="button" class="detail-thumb ${i === 0 ? "active" : ""}" data-thumb-url="${esc(im.url)}" aria-label="Image ${i + 1}">
             ${imageMarkup(im.url, product.emoji)}
           </button>`).join("")}
       </div>`
    : "";

  return `
    <div class="detail-gallery">
      <div class="detail-media" id="detailMainImage">
        ${imageMarkup(mainUrl, product.emoji, "detail-main-img")}
      </div>
      ${gallery}
    </div>
    <div class="detail-info">
      <span class="detail-brand">
        <a class="detail-brand-link" href="${window.SiteHeader.brandUrl(product.brand)}">${esc(product.brand)}</a>
        ·
        <a class="detail-brand-link" href="${window.SiteHeader.categoryUrl(product.category)}">${esc(product.category)}</a>
      </span>
      <h2 id="detailTitle" class="detail-name">${esc(product.name)}</h2>
      <div class="detail-rating" id="detailRating">${
        product.reviewCount > 0
          ? `★ ${product.avgRating.toFixed(1)} <span class="detail-rating-count">based on ${product.reviewCount} review${product.reviewCount === 1 ? "" : "s"}</span>`
          : `<span class="muted">No reviews yet</span>`
      }</div>
      ${(() => {
        const d = discountInfo(product);
        return d
          ? `<div class="detail-prices">
               <span class="detail-price on-sale">${money(d.sale)}</span>
               <span class="detail-price-original">${money(d.original)}</span>
               <span class="detail-price-off">${d.pct}% OFF</span>
             </div>`
          : `<div class="detail-prices"><span class="detail-price">${money(product.price)}</span></div>`;
      })()}
      ${stockLine}
      <p class="detail-desc">${esc(product.description)}</p>

      <div class="detail-buy ${out ? "is-out" : ""}">
        <div class="qty detail-qty" ${out ? "aria-disabled=\"true\"" : ""}>
          <button id="detailQtyDec" aria-label="Decrease quantity" ${out ? "disabled" : ""}>−</button>
          <span id="detailQtyVal">1</span>
          <button id="detailQtyInc" aria-label="Increase quantity" ${out ? "disabled" : ""}>+</button>
        </div>
        <button id="detailAddBtn" class="btn btn-secondary" ${out ? "disabled" : ""}>
          ${out ? "Out of stock" : "Add to Cart"}
        </button>
        <button id="detailBuyBtn" class="btn btn-primary" ${out ? "disabled" : ""}>
          Buy Now
        </button>
      </div>

      <div class="detail-specs">
        <h3>Specifications</h3>
        <table><tbody>${specsRows}</tbody></table>
      </div>

      <div class="detail-reviews" id="detailReviews">
        <h3>Customer reviews</h3>
        <div id="reviewsList" class="reviews-list"><p class="muted">Loading reviews…</p></div>

        <form id="reviewForm" class="review-form">
          <h4>Write a review</h4>
          <p class="review-note">Reviews are open to verified purchasers. Use the email from your order.</p>
          <div class="review-form-row">
            <input id="reviewName" class="review-input" type="text" maxlength="80" placeholder="Your name" required />
            <input id="reviewEmail" class="review-input" type="email" placeholder="Email used at checkout" required />
          </div>
          <div class="review-form-row">
            <div class="star-input" id="starInput" role="radiogroup" aria-label="Your rating">
              ${[1,2,3,4,5].map(n => `<button type="button" class="star-btn" data-star="${n}" aria-label="${n} star${n>1?"s":""}">★</button>`).join("")}
            </div>
          </div>
          <textarea id="reviewComment" class="review-input" rows="3" maxlength="2000" placeholder="Share your experience with this product…" required></textarea>
          <p class="review-error" id="reviewError" hidden></p>
          <button type="submit" class="btn btn-primary btn-sm" id="reviewSubmit">Submit review</button>
        </form>
      </div>
    </div>`;
}

// Relative "time ago" for review dates.
function timeAgo(iso) {
  const d = new Date(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (Number.isNaN(s)) return "";
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m} minute${m>1?"s":""} ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hour${h>1?"s":""} ago`;
  const days = Math.floor(h / 24); if (days < 30) return `${days} day${days>1?"s":""} ago`;
  const mo = Math.floor(days / 30); if (mo < 12) return `${mo} month${mo>1?"s":""} ago`;
  const y = Math.floor(mo / 12); return `${y} year${y>1?"s":""} ago`;
}

// Render stars (filled up to `rating`).
function starRow(rating) {
  return `<span class="stars">${"★".repeat(rating)}<span class="stars-empty">${"★".repeat(5 - rating)}</span></span>`;
}

// Load + render reviews for the open product, and wire the submit form.
function setupReviews(product) {
  const listEl = $("#reviewsList");
  const ratingEl = $("#detailRating");
  let selectedStars = 0;

  function renderList(reviews) {
    if (!reviews.length) {
      listEl.innerHTML = `<p class="muted">No reviews yet — be the first to review this product.</p>`;
      return;
    }
    listEl.innerHTML = reviews.map(r => `
      <div class="review-item">
        <div class="review-item-head">
          <span class="review-author">${esc(r.reviewerName)}${r.verifiedPurchase ? ` <span class="verified-badge" title="Verified purchase">✓ Verified Purchase</span>` : ""}</span>
          <span class="review-date">${esc(timeAgo(r.createdAt))}</span>
        </div>
        ${starRow(r.rating)}
        <p class="review-comment">${esc(r.comment)}</p>
      </div>`).join("");
  }

  function updateAverage(stats) {
    if (!ratingEl) return;
    ratingEl.innerHTML = stats.count > 0
      ? `★ ${Number(stats.average).toFixed(1)} <span class="detail-rating-count">based on ${stats.count} review${stats.count === 1 ? "" : "s"}</span>`
      : `<span class="muted">No reviews yet</span>`;
  }

  async function load() {
    try {
      const res = await fetch(`${API_BASE}/products/${product.id}/reviews`);
      const data = await res.json();
      renderList(data.reviews || []);
      updateAverage(data.stats || { count: 0, average: 0 });
    } catch {
      listEl.innerHTML = `<p class="review-error">Could not load reviews.</p>`;
    }
  }

  // Star picker.
  const starInput = $("#starInput");
  starInput.querySelectorAll(".star-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedStars = Number(btn.dataset.star);
      starInput.querySelectorAll(".star-btn").forEach(b =>
        b.classList.toggle("on", Number(b.dataset.star) <= selectedStars));
    });
  });

  // Submit.
  $("#reviewForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#reviewError");
    err.hidden = true;
    const reviewerName = $("#reviewName").value.trim();
    const email = $("#reviewEmail").value.trim();
    const comment = $("#reviewComment").value.trim();
    if (!reviewerName) { err.textContent = "Please enter your name."; err.hidden = false; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = "Please enter the email you used at checkout."; err.hidden = false; return; }
    if (!selectedStars) { err.textContent = "Please select a star rating."; err.hidden = false; return; }
    if (!comment) { err.textContent = "Please write a short comment."; err.hidden = false; return; }
    const btn = $("#reviewSubmit");
    btn.disabled = true; btn.textContent = "Submitting…";
    try {
      const res = await fetch(`${API_BASE}/products/${product.id}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewerName, email, rating: selectedStars, comment }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data.details && data.details.join(" ")) || data.error || "Could not submit review.");
      // Reset form + reload.
      $("#reviewForm").reset();
      selectedStars = 0;
      starInput.querySelectorAll(".star-btn").forEach(b => b.classList.remove("on"));
      await load();
    } catch (e2) {
      err.textContent = e2.message; err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = "Submit review";
    }
  });

  load();
}

function openProduct(id, updateHash = true) {
  const product = getProduct(id);
  if (!product) return;

  const body = $("#detailBody");
  body.innerHTML = renderProductDetail(product);

  // Thumbnail gallery: clicking a thumb swaps the main image.
  const mainImageEl = $("#detailMainImage");
  body.querySelectorAll("[data-thumb-url]").forEach(thumb => {
    thumb.addEventListener("click", () => {
      mainImageEl.innerHTML = imageMarkup(thumb.dataset.thumbUrl, product.emoji, "detail-main-img");
      body.querySelectorAll(".detail-thumb").forEach(t => t.classList.remove("active"));
      thumb.classList.add("active");
    });
  });

  // Quantity selector (bounded by available stock, min 1).
  let qty = 1;
  const qtyVal = $("#detailQtyVal");
  const dec = $("#detailQtyDec");
  const inc = $("#detailQtyInc");
  if (product.stock > 0) {
    dec.addEventListener("click", () => { qty = Math.max(1, qty - 1); qtyVal.textContent = qty; });
    inc.addEventListener("click", () => { qty = Math.min(product.stock, qty + 1); qtyVal.textContent = qty; });
    $("#detailAddBtn").addEventListener("click", () => {
      addToCart(product.id, qty);
      closeProduct();
    });
    // Buy Now: add to cart and go straight to checkout (reuses existing flow).
    $("#detailBuyBtn").addEventListener("click", () => {
      addToCart(product.id, qty);
      window.location.href = "checkout.html";
    });
  }

  // Reviews: load, render, and wire the submit form.
  setupReviews(product);

  const overlay = $("#detailOverlay");
  const modal = $("#detailModal");
  overlay.hidden = false;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  $("#detailClose").focus();

  if (updateHash) history.replaceState(null, "", `#product/${id}`);
}

function closeProduct(updateHash = true) {
  const overlay = $("#detailOverlay");
  const modal = $("#detailModal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  overlay.hidden = true;
  if (updateHash && location.hash.startsWith("#product/")) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

// ---- Events ----
$("#searchInput").addEventListener("input", e => {
  state.search = e.target.value.trim().toLowerCase();
  renderProducts();
});
$("#sortSelect").addEventListener("change", e => {
  state.sort = e.target.value;
  renderProducts();
});
$("#detailClose").addEventListener("click", () => closeProduct());
$("#detailOverlay").addEventListener("click", () => closeProduct());
// Escape closes the product modal; the cart drawer handles its own Escape.
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && $("#detailModal").classList.contains("open")) closeProduct();
});

// Open a product directly from a #product/<id> URL (shareable / refresh-safe).
// #cart opens the cart drawer — the listing pages link here for the full cart.
function handleHash() {
  const m = location.hash.match(/^#product\/(\d+)$/);
  if (m) { openProduct(Number(m[1]), false); return; }
  if (location.hash === "#cart") window.CartUI.open();
}
window.addEventListener("hashchange", handleHash);

// ---- Init ----
async function init() {
  const grid = $("#productGrid");
  const empty = $("#emptyState");

  // Loading state.
  empty.hidden = true;
  grid.innerHTML = `<p class="grid-status">Loading products…</p>`;

  // Cart drawer: wire controls and reflect the persisted cart immediately.
  window.CartUI.init({ getProduct });

  try {
    await loadProducts();
    window.SiteHeader.init(PRODUCTS);
    renderCategoryRow();
    renderDeals();
    renderFooterLinks();
    renderFilters();
    renderProducts();
    // Cart lines need the freshly loaded catalog (names, prices, stock).
    window.CartUI.render();
    handleHash();
  } catch (err) {
    console.error(err);
    grid.innerHTML = `
      <div class="grid-status error">
        <p>Sorry — we couldn't load the catalog.</p>
        <button id="retryLoad" class="btn btn-primary">Try again</button>
      </div>`;
    $("#retryLoad")?.addEventListener("click", init);
  }
}

init();
