// ---- Promo codes ----
// Public: POST /api/promo-codes/validate (check a code + subtotal, no redeem).
// Admin (JWT, mounted separately): list / create / update (toggle active).
import { Router } from "express";
import * as store from "../store.js";
import { requireAuth } from "../auth.js";

// ---------------------------------------------------------------------------
// Public router (mounted at /api/promo-codes)
// ---------------------------------------------------------------------------
export const publicPromoRouter = Router();

// POST /api/promo-codes/validate  { code, subtotal }
// Returns the computed discount for UI display — does NOT redeem the code.
publicPromoRouter.post("/validate", async (req, res, next) => {
  try {
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const subtotal = Number(req.body?.subtotal);
    if (!code) return res.status(400).json({ valid: false, error: "Please enter a promo code." });
    if (!Number.isFinite(subtotal) || subtotal < 0) {
      return res.status(400).json({ valid: false, error: "Invalid cart subtotal." });
    }
    const result = await store.validatePromo(code, subtotal);
    if (!result.valid) {
      return res.status(200).json({ valid: false, error: result.reason });
    }
    res.json({
      valid: true,
      code: result.promo.code,
      discountType: result.promo.discountType,
      discountValue: result.promo.discountValue,
      discount: result.discount,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Admin router (mounted at /api/admin/promo-codes — requireAuth at mount)
// ---------------------------------------------------------------------------
export const adminPromoRouter = Router();

const DISCOUNT_TYPES = ["percentage", "fixed_amount"];

function validatePromoInput(body, { partial = false } = {}) {
  const errors = [];
  const has = k => body[k] !== undefined && body[k] !== null;
  if (!partial || has("code")) {
    if (typeof body.code !== "string" || body.code.trim().length < 2 || body.code.trim().length > 40) {
      errors.push("code must be 2–40 characters");
    }
  }
  if (!partial || has("discountType")) {
    if (!DISCOUNT_TYPES.includes(body.discountType)) errors.push("discountType must be 'percentage' or 'fixed_amount'");
  }
  if (!partial || has("discountValue")) {
    const v = Number(body.discountValue);
    if (!Number.isFinite(v) || v < 0) errors.push("discountValue must be a non-negative number");
    else if (body.discountType === "percentage" && v > 100) errors.push("percentage discountValue cannot exceed 100");
  }
  if (has("maxUses") && body.maxUses !== null && (!Number.isInteger(Number(body.maxUses)) || Number(body.maxUses) < 0)) {
    errors.push("maxUses must be a non-negative integer or null");
  }
  if (has("expiresAt") && body.expiresAt !== null && Number.isNaN(new Date(body.expiresAt).getTime())) {
    errors.push("expiresAt must be a valid date or null");
  }
  return errors;
}

// GET /api/admin/promo-codes — list all
adminPromoRouter.get("/", async (req, res, next) => {
  try { res.json(await store.listPromoCodes()); }
  catch (err) { next(err); }
});

// POST /api/admin/promo-codes — create
adminPromoRouter.post("/", async (req, res, next) => {
  try {
    const errors = validatePromoInput(req.body, { partial: false });
    if (errors.length) return res.status(400).json({ error: "Validation failed", details: errors });
    const existing = await store.findPromoByCode(req.body.code.trim());
    if (existing) return res.status(409).json({ error: "A promo code with that code already exists." });
    const created = await store.createPromoCode({
      code: req.body.code.trim(),
      discountType: req.body.discountType,
      discountValue: Number(req.body.discountValue),
      maxUses: req.body.maxUses === "" || req.body.maxUses == null ? null : Number(req.body.maxUses),
      expiresAt: req.body.expiresAt || null,
      isActive: req.body.isActive !== false,
    });
    res.status(201).json(created);
  } catch (err) { next(err); }
});

// PATCH /api/admin/promo-codes/:id — update (e.g. toggle active)
adminPromoRouter.patch("/:id", async (req, res, next) => {
  try {
    const errors = validatePromoInput(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ error: "Validation failed", details: errors });
    const data = {};
    if (req.body.code !== undefined) data.code = req.body.code.trim();
    if (req.body.discountType !== undefined) data.discountType = req.body.discountType;
    if (req.body.discountValue !== undefined) data.discountValue = Number(req.body.discountValue);
    if (req.body.maxUses !== undefined) data.maxUses = req.body.maxUses === "" || req.body.maxUses === null ? null : Number(req.body.maxUses);
    if (req.body.expiresAt !== undefined) data.expiresAt = req.body.expiresAt || null;
    if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;
    const updated = await store.updatePromoCode(req.params.id, data);
    if (!updated) return res.status(404).json({ error: "Promo code not found" });
    res.json(updated);
  } catch (err) { next(err); }
});

export default publicPromoRouter;
