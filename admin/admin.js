// Admin dashboard entry point. Handles top-level navigation between views and
// delegates rendering to modular view functions. State lives in the URL hash
// so views are refresh-safe and linkable (#products, #orders, #sales).
import { renderOverview } from "./views/overview.js";
import { renderProducts } from "./views/products.js";
import { renderOrders } from "./views/orders.js";
import { renderSales } from "./views/sales.js";
import { renderMessages_view } from "./views/messages.js";
import { renderPromos } from "./views/promos.js";
import { renderBanners } from "./views/banners.js";
import { renderAftersales } from "./views/aftersales.js";
import { renderImport } from "./views/import.js";
import { renderCategories } from "./views/categories.js";
import { renderShippingZones } from "./views/shipping-zones.js";
import { renderLogin } from "./views/login.js";
import { auth, api, setUnauthorizedHandler } from "./components/api.js";
import { toast } from "./components/toast.js";

const VIEWS = {
  overview: { title: "Overview", render: renderOverview },
  products: { title: "Products", render: renderProducts },
  // Same view, scoped to stock = 0 — a real route so it's linkable/refreshable.
  "out-of-stock": { title: "Out of stock", render: root => renderProducts(root, { stockFilter: "out" }) },
  import:   { title: "Import products", render: renderImport },
  categories: { title: "Categories", render: renderCategories },
  orders:   { title: "Orders", render: renderOrders },
  promos:   { title: "Promo codes", render: renderPromos },
  "shipping-zones": { title: "Shipping zones", render: renderShippingZones },
  banners:  { title: "Homepage banners", render: renderBanners },
  aftersales: { title: "Aftersales", render: renderAftersales },
  messages: { title: "Messages", render: renderMessages_view },
  sales:    { title: "Sales performance", render: renderSales },
};

const root = document.getElementById("viewRoot");
const title = document.getElementById("viewTitle");
const nav = document.getElementById("adminNav");

let current = "overview";

function setActiveNav(view) {
  nav.querySelectorAll(".admin-nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
}

async function show(view) {
  const cfg = VIEWS[view] || VIEWS.overview;
  current = VIEWS[view] ? view : "overview";
  title.textContent = cfg.title;
  setActiveNav(current);
  if (location.hash !== `#${current}`) history.replaceState(null, "", `#${current}`);
  await cfg.render(root);
}

const layout = document.querySelector(".admin-layout");
const loginHost = document.getElementById("loginHost");

// Nav clicks
nav.addEventListener("click", e => {
  const btn = e.target.closest(".admin-nav-item");
  if (btn) show(btn.dataset.view);
});

// Refresh re-renders the current view.
document.getElementById("refreshBtn").addEventListener("click", () => show(current));

// Logout
document.getElementById("logoutBtn").addEventListener("click", () => {
  auth.clear();
  showLogin();
});

// Hash routing (initial + back/forward).
window.addEventListener("hashchange", () => {
  if (!auth.isAuthed()) return;
  const view = location.hash.replace("#", "") || "overview";
  if (view !== current) show(view);
});

// ---- Auth gating ----
function showLogin() {
  layout.hidden = true;
  loginHost.hidden = false;
  renderLogin(loginHost, enterDashboard);
}

function enterDashboard() {
  loginHost.hidden = true;
  loginHost.innerHTML = "";
  layout.hidden = false;
  show(location.hash.replace("#", "") || "overview");
  refreshOutOfStockBadge();
}

// ---- Out-of-stock badge in the sidebar ----
// Kept current from two sides: fetched once on entry (so the count is right
// before you've opened any product page) and updated from the event the products
// view fires whenever it loads, so a restock is reflected immediately.
function setOutOfStockBadge(count) {
  const badge = document.getElementById("outOfStockBadge");
  if (!badge) return;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

async function refreshOutOfStockBadge() {
  try {
    // threshold=0 → exactly the sold-out products (stock can't go negative).
    setOutOfStockBadge((await api.lowStock(0)).length);
  } catch {
    /* Non-critical: leave whatever the badge already shows. */
  }
}

document.addEventListener("admin:stock-counts", e => setOutOfStockBadge(e.detail.outOfStock));

// When any API call gets a 401, drop back to the login screen.
setUnauthorizedHandler(() => {
  toast("Session expired — please sign in again.", "error");
  showLogin();
});

// ---- Bootstrap ----
async function boot() {
  if (!auth.isAuthed()) { showLogin(); return; }
  // Validate the stored token before showing the dashboard.
  try {
    await api.me();
    enterDashboard();
  } catch {
    showLogin();
  }
}

boot();
