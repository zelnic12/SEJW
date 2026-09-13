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
import { requireAuth } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// The static frontend lives one level up from server/.
const FRONTEND_DIR = path.join(__dirname, "..", "..");
// Uploaded product images live under server/uploads and are served at /uploads.
const UPLOADS_DIR = path.join(__dirname, "..", "uploads");

const app = express();

// ---- Middleware ----
app.use(cors());
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
app.use("/api/orders", ordersRouter);
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
// Analytics are admin-only — protected at the mount point.
app.use("/api/analytics", requireAuth, analyticsRouter);

// ---- Unknown API routes → 404 JSON (before static fallback) ----
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ---- Serve uploaded product images ----
app.use("/uploads", express.static(UPLOADS_DIR));

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
