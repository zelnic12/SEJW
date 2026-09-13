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
import { renderLogin } from "./views/login.js";
import { auth, api, setUnauthorizedHandler } from "./components/api.js";
import { toast } from "./components/toast.js";

const VIEWS = {
  overview: { title: "Overview", render: renderOverview },
  products: { title: "Products", render: renderProducts },
  orders:   { title: "Orders", render: renderOrders },
  promos:   { title: "Promo codes", render: renderPromos },
  banners:  { title: "Homepage banners", render: renderBanners },
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
}

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
