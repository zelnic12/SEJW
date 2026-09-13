// ---- Shared cart drawer ----
// The cart state (localStorage) plus the drawer rendering and interactions, so
// the homepage and the category/brand listing pages behave identically. Every
// page that includes the drawer markup calls CartUI.init({ getProduct }).
// Exposed on window.CartUI.
(function () {
  const STORAGE_KEY = "voltedge_cart";
  const SHIPPING_FEE = 9.99;             // Flat shipping fee below the threshold.
  const FREE_SHIPPING_THRESHOLD = 100;   // Free shipping at/above this subtotal.

  const $ = sel => document.querySelector(sel);
  const { money, esc, discountInfo, imageMarkup, primaryImage, priceOf } = window.ProductCard;

  let cart = read();
  // Injected by init(): resolves an id to a product from the page's catalog.
  let getProduct = () => null;

  function read() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch { return {}; }
  }
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
  }

  function entries() {
    return Object.entries(cart)
      .map(([id, qty]) => ({ product: getProduct(id), qty }))
      .filter(e => e.product);
  }

  function add(id, qty = 1) {
    const product = getProduct(id);
    if (!product || product.stock <= 0) return;
    const current = cart[id] || 0;
    // Never let cart quantity exceed available stock.
    cart[id] = Math.min(product.stock, current + qty);
    save();
    render();
    open();
  }

  function changeQty(id, delta) {
    const product = getProduct(id);
    const next = (cart[id] || 0) + delta;
    if (next <= 0) delete cart[id];
    else cart[id] = product ? Math.min(product.stock, next) : next;
    save();
    render();
  }

  function remove(id) {
    delete cart[id];
    save();
    render();
  }

  function render() {
    const list = entries();
    const count = list.reduce((s, e) => s + e.qty, 0);
    const subtotal = list.reduce((s, e) => s + e.qty * priceOf(e.product), 0);
    // Shipping: free over the threshold, flat fee below, nothing when empty.
    const shipping = subtotal === 0 ? 0 : (subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE);

    const countEl = $("#cartCount");
    if (countEl) countEl.textContent = count;

    const container = $("#cartItems");
    if (!container) return;   // page has a badge but no drawer

    $("#cartSubtotal").textContent = money(subtotal);
    $("#cartShipping").textContent = shipping === 0 ? "Free" : money(shipping);
    $("#cartTotal").textContent = money(subtotal + shipping);
    $("#shippingLabel").textContent =
      subtotal > 0 && subtotal < FREE_SHIPPING_THRESHOLD
        ? `Shipping (free over ${money(FREE_SHIPPING_THRESHOLD)})`
        : "Shipping";
    $("#checkoutBtn").disabled = list.length === 0;

    if (list.length === 0) {
      container.innerHTML = `<p class="cart-empty">Your cart is empty.</p>`;
      return;
    }

    container.innerHTML = list.map(({ product, qty }) => {
      const atMax = qty >= product.stock;
      const unit = priceOf(product);
      const d = discountInfo(product);
      const priceLine = d
        ? `<span class="cart-item-sale">${money(unit)}</span> <span class="cart-item-was">${money(product.price)}</span>`
        : `${money(unit)}`;
      return `
      <div class="cart-item">
        <div class="cart-item-media">${imageMarkup(primaryImage(product), product.emoji)}</div>
        <div>
          <div class="cart-item-name">${esc(product.name)}</div>
          <div class="cart-item-price">${priceLine}</div>
          <div class="qty">
            <button data-dec="${product.id}" aria-label="Decrease quantity">−</button>
            <span>${qty}</span>
            <button data-inc="${product.id}" aria-label="Increase quantity" ${atMax ? "disabled" : ""}>+</button>
            <button class="remove-btn" data-remove="${product.id}">Remove</button>
          </div>
          ${atMax ? `<div class="qty-max-note">Max stock reached</div>` : ""}
        </div>
        <strong>${money(unit * qty)}</strong>
      </div>`;
    }).join("");

    container.querySelectorAll("[data-inc]").forEach(b => b.addEventListener("click", () => changeQty(Number(b.dataset.inc), 1)));
    container.querySelectorAll("[data-dec]").forEach(b => b.addEventListener("click", () => changeQty(Number(b.dataset.dec), -1)));
    container.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", () => remove(Number(b.dataset.remove))));
  }

  function open() {
    const drawer = $("#cartDrawer");
    if (!drawer) return;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    $("#cartOverlay").hidden = false;
  }
  function close() {
    const drawer = $("#cartDrawer");
    if (!drawer) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    $("#cartOverlay").hidden = true;
  }
  const isOpen = () => !!$("#cartDrawer")?.classList.contains("open");

  function init(options = {}) {
    if (typeof options.getProduct === "function") getProduct = options.getProduct;
    cart = read();

    $("#cartBtn")?.addEventListener("click", open);
    $("#cartClose")?.addEventListener("click", close);
    $("#cartOverlay")?.addEventListener("click", close);
    $("#checkoutBtn")?.addEventListener("click", () => {
      if (entries().length === 0) return;
      // Cart lives in localStorage; the checkout page reads it from there.
      window.location.href = "checkout.html";
    });
    // Escape closes the cart — unless a product modal is on top of it.
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && isOpen() && !document.querySelector("#detailModal.open")) close();
    });

    render();
  }

  window.CartUI = {
    init, add, changeQty, remove, render, open, close, entries, isOpen,
    get cart() { return cart; },
    CONFIG: { SHIPPING_FEE, FREE_SHIPPING_THRESHOLD },
  };
})();
