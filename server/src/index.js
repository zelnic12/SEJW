// ---- VoltEdge API server ----
import 'dotenv/config';
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initStore } from "./store.js";
import productsRouter from "./routes/products.js";
import ordersRouter from "./routes/orders.js";
import analyticsRouter from "./routes/analytics.js";
import authRouter from "./routes/auth.js";
import imagesRouter from "./routes/images.js";
import invoicesRouter from "./routes/invoices.js";
import storeSettingsRouter from "./routes/store-settings.js";
import { publicChatRouter, adminChatRouter } from "./routes/chat.js";
import paymentsRouter from "./routes/payments.js";
import { publicPromoRouter, adminPromoRouter } from "./routes/promo-codes.js";
import { publicBannersRouter, adminBannersRouter } from "./routes/banners.js";
import brandLogosRouter from "./routes/brand-logos.js";
import { publicAftersalesRouter, adminAftersalesRouter } from "./routes/aftersales.js";
import importsRouter from "./routes/imports.js";
import categoriesRouter from "./routes/categories.js";
import { publicShippingZonesRouter, adminShippingZonesRouter } from "./routes/shipping-zones.js";
import notificationsRouter from "./routes/notifications.js";
import { requireAuth } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// The static frontend lives one level up from server/.
const FRONTEND_DIR = path.join(__dirname, "..", "..");
// LEGACY ONLY: images uploaded before the move to Cloudinary. New uploads go
// straight to Cloudinary's CDN and never touch this folder — see src/cloudinary.js.
const LEGACY_UPLOADS_DIR = path.join(__dirname, "..", "uploads");

const app = express();

// ---- Middleware ----
app.use(cors());
// The bulk product import posts the whole parsed spreadsheet back as JSON, which
// is far bigger than express's 100 kB default. Scoping a larger limit to that
// path only — registered first, because body-parser skips a body it has already
// parsed, so this wins for /api/admin/imports and the default applies elsewhere.
app.use("/api/admin/imports", express.json({ limit: "8mb" }));
app.use(express.json());

// Simple request log.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// ---- Health check ----
app.get("/api/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// ---- API routes ----
app.use("/api/auth", authRouter);
app.use("/api/products", productsRouter);
// Categories: public list (name + count + custom icon), admin-only icon upload.
app.use("/api/categories", categoriesRouter);
app.use("/api/orders", ordersRouter);
// Delivery coverage: public list for the checkout dropdown, admin CRUD (JWT).
app.use("/api/shipping-zones", publicShippingZonesRouter);
app.use("/api/admin/shipping-zones", requireAuth, adminShippingZonesRouter);
app.use("/api/store-settings", storeSettingsRouter);
// Admin image management (upload/delete/set-main/reorder). Auth enforced inside.
app.use("/api/admin/products", imagesRouter);
// Order invoices (JSON + PDF). Access control (admin JWT or per-order token) inside.
app.use("/api/orders", invoicesRouter);
// Midtrans payment notifications (public webhook, signature-verified inside).
app.use("/api/payments", paymentsRouter);
// Live chat: public customer endpoints (session-token scoped, no login).
app.use("/api/chat", publicChatRouter);
// Live chat: admin endpoints (JWT-protected at the mount point).
app.use("/api/admin/chat", requireAuth, adminChatRouter);
// Promo codes: public validate endpoint + admin CRUD (JWT).
app.use("/api/promo-codes", publicPromoRouter);
app.use("/api/admin/promo-codes", requireAuth, adminPromoRouter);
// Homepage hero banners: public read of active slides + admin CRUD (JWT).
app.use("/api/banners", publicBannersRouter);
app.use("/api/admin/banners", requireAuth, adminBannersRouter);
// Which brands have a logo file (public, read-only) — used by the brand row.
app.use("/api/brand-logos", brandLogosRouter);
// Aftersales: public submit/track (order id + email is the credential) and
// admin case management (JWT).
app.use("/api/aftersales", publicAftersalesRouter);
app.use("/api/admin/aftersales", requireAuth, adminAftersalesRouter);
// Bulk product import from a spreadsheet (parse → preview → commit).
app.use("/api/admin/imports", requireAuth, importsRouter);
// Analytics are admin-only — protected at the mount point.
app.use("/api/analytics", requireAuth, analyticsRouter);

// New-order / new-message feed for the dashboard's notification bell.
app.use("/api/admin/notifications", requireAuth, notificationsRouter);

// ---- Unknown API routes → 404 JSON (before static fallback) ----
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ---- LEGACY: serve pre-Cloudinary uploads ----
// Kept so image URLs already stored in the database ("/uploads/products/…")
// don't 404 after the migration. Nothing new is ever written here.
// Safe to delete this mount (and the server/uploads folder) once
// `npm run migrate:images` has moved the remaining local files to Cloudinary.
app.use("/uploads", express.static(LEGACY_UPLOADS_DIR));

// ---- Serve the static frontend ----
app.use(express.static(FRONTEND_DIR));

// ---- Central error handler ----
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  res.status(500).json({ error: "Internal server error" });
});

// ---- Start ----
initStore()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`VoltEdge API listening on http://localhost:${PORT}`);
      console.log(`  Storefront:  http://localhost:${PORT}/`);
      console.log(`  API base:    http://localhost:${PORT}/api`);
    });
  })
  .catch(err => {
    console.error("Failed to initialise data store:", err);
    process.exit(1);
  });

export default app;
