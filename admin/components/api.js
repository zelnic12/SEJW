// Thin API client for the admin dashboard. Centralises fetch + error handling
// so views never touch fetch directly.

const BASE = "/api";
const TOKEN_KEY = "voltedge_admin_token";

// ---- Token storage ----
export const auth = {
  getToken: () => localStorage.getItem(TOKEN_KEY),
  setToken: t => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
  isAuthed: () => !!localStorage.getItem(TOKEN_KEY),
};

// Called when a request returns 401 so the app can show the login screen.
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

// Raised on 401 so callers can distinguish auth failures.
export class AuthError extends Error {}

async function request(path, { method = "GET", body, authRequired = true } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  const token = auth.getToken();
  if (token && authRequired) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    auth.clear();
    if (onUnauthorized) onUnauthorized();
    throw new AuthError("Your session has expired. Please sign in again.");
  }

  // 204 No Content
  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.details) ? data.details.join(" ") : "";
    const message = [data.error, detail].filter(Boolean).join(": ") || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

// Multipart upload (FormData) with the auth header — used for image uploads.
// `method` is configurable because some endpoints upsert with PUT.
async function uploadForm(path, formData, method = "POST") {
  const headers = {};
  const token = auth.getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: formData });
  if (res.status === 401) {
    auth.clear();
    if (onUnauthorized) onUnauthorized();
    throw new AuthError("Your session has expired. Please sign in again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.details) ? data.details.join(" ") : "";
    throw new Error([data.error, detail].filter(Boolean).join(": ") || `Upload failed (${res.status})`);
  }
  return data;
}

/** GET a file (e.g. an Excel template) with the admin token, as a Blob. */
async function downloadBlob(path) {
  const headers = {};
  const token = auth.getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  if (res.status === 401) {
    auth.clear();
    if (onUnauthorized) onUnauthorized();
    throw new AuthError("Your session has expired. Please sign in again.");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Download failed (${res.status})`);
  }
  return res.blob();
}

export const api = {
  // Auth
  login: (username, password) => request("/auth/login", { method: "POST", body: { username, password }, authRequired: false }),
  me: () => request("/auth/me"),

  // Products
  listProducts: () => request("/products"),
  getProduct: id => request(`/products/${id}`),
  createProduct: data => request("/products", { method: "POST", body: data }),
  updateProduct: (id, data) => request(`/products/${id}`, { method: "PUT", body: data }),
  deleteProduct: id => request(`/products/${id}`, { method: "DELETE" }),

  // Product images (admin)
  listImages: id => request(`/admin/products/${id}/images`),
  uploadImages: (id, files) => {
    const fd = new FormData();
    for (const f of files) fd.append("images", f);
    return uploadForm(`/admin/products/${id}/images`, fd);
  },
  deleteImage: (id, imageId) => request(`/admin/products/${id}/images/${imageId}`, { method: "DELETE" }),
  setMainImage: (id, imageId) => request(`/admin/products/${id}/images/${imageId}/main`, { method: "PUT" }),
  reorderImages: (id, order) => request(`/admin/products/${id}/images/reorder`, { method: "PUT", body: { order } }),

  // Store settings
  getStoreSettings: () => request("/store-settings", { authRequired: false }),
  updateStoreSettings: data => request("/store-settings", { method: "PUT", body: data }),

  // Chat (admin)
  listConversations: () => request("/admin/chat/conversations"),
  getConversation: id => request(`/admin/chat/conversations/${id}/messages`),
  replyConversation: (id, body) => request(`/admin/chat/conversations/${id}/messages`, { method: "POST", body: { body } }),

  // Categories + custom icons
  listCategories: () => request("/categories"),
  uploadCategoryIcon: (name, file) => {
    const fd = new FormData();
    fd.append("icon", file);
    return uploadForm(`/categories/${encodeURIComponent(name)}/icon`, fd, "PUT");
  },
  deleteCategoryIcon: name => request(`/categories/${encodeURIComponent(name)}/icon`, { method: "DELETE" }),

  // Bulk product import (admin)
  parseProductImport: file => {
    const fd = new FormData();
    fd.append("file", file);
    return uploadForm("/admin/imports/products/parse", fd);
  },
  previewProductImport: payload => request("/admin/imports/products/preview", { method: "POST", body: payload }),
  commitProductImport: payload => request("/admin/imports/products/commit", { method: "POST", body: payload }),

  // Aftersales requests (admin)
  listAftersalesRequests: ({ type = "", status = "" } = {}) => {
    const qs = new URLSearchParams();
    if (type) qs.set("type", type);
    if (status) qs.set("status", status);
    const suffix = qs.toString() ? `?${qs}` : "";
    return request(`/admin/aftersales${suffix}`);
  },
  getAftersalesRequest: id => request(`/admin/aftersales/${encodeURIComponent(id)}`),
  updateAftersalesRequest: (id, data) =>
    request(`/admin/aftersales/${encodeURIComponent(id)}`, { method: "PATCH", body: data }),

  // Homepage banners (admin)
  listBanners: () => request("/admin/banners"),
  createBanner: data => request("/admin/banners", { method: "POST", body: data }),
  updateBanner: (id, data) => request(`/admin/banners/${id}`, { method: "PUT", body: data }),
  deleteBanner: id => request(`/admin/banners/${id}`, { method: "DELETE" }),
  reorderBanners: order => request("/admin/banners/reorder", { method: "PUT", body: { order } }),
  uploadBannerImage: file => {
    const fd = new FormData();
    fd.append("image", file);
    return uploadForm("/admin/banners/upload", fd);
  },

  // Promo codes (admin)
  listPromoCodes: () => request("/admin/promo-codes"),
  createPromoCode: data => request("/admin/promo-codes", { method: "POST", body: data }),
  updatePromoCode: (id, data) => request(`/admin/promo-codes/${id}`, { method: "PATCH", body: data }),

  // Shipping zones (admin) — Jabodetabek delivery coverage + per-kecamatan fees
  listShippingZones: () => request("/admin/shipping-zones"),
  createShippingZone: data => request("/admin/shipping-zones", { method: "POST", body: data }),
  updateShippingZone: (id, data) => request(`/admin/shipping-zones/${id}`, { method: "PATCH", body: data }),

  // Orders
  listOrders: () => request("/orders"),
  getOrder: id => request(`/orders/${id}`),
  updateOrderStatus: (id, status) => request(`/orders/${id}/status`, { method: "PATCH", body: { status } }),
  getInvoice: id => request(`/orders/${id}/invoice`),
  // Fetch the invoice PDF as a blob (with the admin auth header) and return an
  // object URL suitable for opening in a new tab or triggering a download.
  fetchInvoicePdf: async id => {
    const headers = {};
    const token = auth.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/orders/${id}/invoice/pdf`, { headers });
    if (!res.ok) throw new Error(`Could not load invoice PDF (${res.status})`);
    return URL.createObjectURL(await res.blob());
  },

  // Notifications (admin) — new orders + new customer chat messages
  listNotifications: ({ unreadOnly = false, limit = 20 } = {}) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (unreadOnly) qs.set("unread", "true");
    return request(`/admin/notifications?${qs}`);
  },
  markNotificationRead: id => request(`/admin/notifications/${id}/read`, { method: "POST" }),
  markAllNotificationsRead: () => request("/admin/notifications/read-all", { method: "POST" }),

  // Bookkeeping (pembukuan)
  finProducts: () => request("/admin/finance/products"),
  finReceipts: month => request(`/admin/finance/receipts?month=${encodeURIComponent(month)}`),
  finLastReceipt: productId => request(`/admin/finance/receipts/last/${productId}`),
  finSuppliers: () => request("/admin/finance/suppliers"),
  finReceiptTemplate: () => downloadBlob("/admin/finance/receipts/template"),
  finParseReceipts: file => {
    const fd = new FormData();
    fd.append("file", file);
    return uploadForm("/admin/finance/receipts/parse", fd);
  },
  finBulkReceipts: rows => request("/admin/finance/receipts/bulk", { method: "POST", body: { rows } }),
  finCreateReceipt: data => request("/admin/finance/receipts", { method: "POST", body: data }),
  finDeleteReceipt: id => request(`/admin/finance/receipts/${id}`, { method: "DELETE" }),
  finExpenseCategories: () => request("/admin/finance/expense-categories"),
  finExpenses: month => request(`/admin/finance/expenses?month=${encodeURIComponent(month)}`),
  finCreateExpense: data => request("/admin/finance/expenses", { method: "POST", body: data }),
  finDeleteExpense: id => request(`/admin/finance/expenses/${id}`, { method: "DELETE" }),
  finSales: (month, channel = "") =>
    request(`/admin/finance/sales?month=${encodeURIComponent(month)}${channel ? `&channel=${channel}` : ""}`),
  finCreateSale: data => request("/admin/finance/sales", { method: "POST", body: data }),
  finDeleteSale: id => request(`/admin/finance/sales/${id}`, { method: "DELETE" }),
  finParseShopee: file => {
    const fd = new FormData();
    fd.append("file", file);
    return uploadForm("/admin/finance/shopee/parse", fd);
  },
  finCommitShopee: payload => request("/admin/finance/shopee/commit", { method: "POST", body: payload }),
  finInstallRates: () => request("/admin/finance/install-rates"),
  finSaveInstallRates: rates => request("/admin/finance/install-rates", { method: "PUT", body: rates }),
  finReport: month => request(`/admin/finance/report?month=${encodeURIComponent(month)}`),

  // Analytics
  overview: () => request("/analytics/overview"),
  summary: () => request("/analytics/summary"),
  bestSellers: (limit = 5) => request(`/analytics/best-sellers?limit=${limit}`),
  salesByCategory: () => request("/analytics/sales-by-category"),
  salesByBrand: () => request("/analytics/sales-by-brand"),
  timeseries: (bucket = "day", points = 30) => request(`/analytics/timeseries?bucket=${bucket}&points=${points}`),
  lowStock: (threshold = 5) => request(`/analytics/low-stock?threshold=${threshold}`),
};
