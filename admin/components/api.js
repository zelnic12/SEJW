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
async function uploadForm(path, formData) {
  const headers = {};
  const token = auth.getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: formData });
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

  // Promo codes (admin)
  listPromoCodes: () => request("/admin/promo-codes"),
  createPromoCode: data => request("/admin/promo-codes", { method: "POST", body: data }),
  updatePromoCode: (id, data) => request(`/admin/promo-codes/${id}`, { method: "PATCH", body: data }),

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

  // Analytics
  overview: () => request("/analytics/overview"),
  summary: () => request("/analytics/summary"),
  bestSellers: (limit = 5) => request(`/analytics/best-sellers?limit=${limit}`),
  salesByCategory: () => request("/analytics/sales-by-category"),
  salesByBrand: () => request("/analytics/sales-by-brand"),
  timeseries: (bucket = "day", points = 30) => request(`/analytics/timeseries?bucket=${bucket}&points=${points}`),
  lowStock: (threshold = 5) => request(`/analytics/low-stock?threshold=${threshold}`),
};
