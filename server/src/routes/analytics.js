// ---- Analytics router: /api/analytics ----
// Read-only aggregate endpoints powering the admin dashboard.
import { Router } from "express";
import * as store from "../store.js";

const router = Router();

// GET /api/analytics/summary — headline KPIs
router.get("/summary", async (req, res, next) => {
  try { res.json(await store.getSummary()); }
  catch (err) { next(err); }
});

// GET /api/analytics/best-sellers?limit=5
router.get("/best-sellers", async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 5));
    res.json(await store.getBestSellers(limit));
  } catch (err) { next(err); }
});

// GET /api/analytics/sales-by-category
router.get("/sales-by-category", async (req, res, next) => {
  try { res.json(await store.getSalesByCategory()); }
  catch (err) { next(err); }
});

// GET /api/analytics/sales-by-brand
router.get("/sales-by-brand", async (req, res, next) => {
  try { res.json(await store.getSalesByBrand()); }
  catch (err) { next(err); }
});

// GET /api/analytics/timeseries?bucket=day|week|month&points=30
router.get("/timeseries", async (req, res, next) => {
  try {
    const bucket = ["day", "week", "month"].includes(req.query.bucket) ? req.query.bucket : "day";
    const points = Math.min(90, Math.max(2, Number(req.query.points) || 30));
    res.json(await store.getSalesTimeSeries(bucket, points));
  } catch (err) { next(err); }
});

// GET /api/analytics/low-stock?threshold=5
router.get("/low-stock", async (req, res, next) => {
  try {
    // An explicit threshold=0 is a legitimate request ("only sold-out products")
    // — don't let `|| 5` swallow it. Missing/garbage falls back to 5.
    const raw = req.query.threshold;
    const parsed = raw === undefined || raw === "" ? 5 : Number(raw);
    const threshold = Number.isFinite(parsed) ? Math.max(0, parsed) : 5;
    res.json(await store.getLowStock(threshold));
  } catch (err) { next(err); }
});

// GET /api/analytics/overview — everything the dashboard landing needs in one call
router.get("/overview", async (req, res, next) => {
  try {
    const [summary, bestSellers, byCategory, byBrand, timeseries, lowStock] = await Promise.all([
      store.getSummary(),
      store.getBestSellers(5),
      store.getSalesByCategory(),
      store.getSalesByBrand(),
      store.getSalesTimeSeries("day", 30),
      store.getLowStock(5),
    ]);
    res.json({ summary, bestSellers, byCategory, byBrand, timeseries, lowStock });
  } catch (err) { next(err); }
});

export default router;
