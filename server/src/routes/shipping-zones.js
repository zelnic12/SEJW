// ---- Shipping zones (Jabodetabek delivery coverage) ----
//
// Public:  GET /api/shipping-zones            → active zones for the checkout dropdown
// Admin:   GET/POST/PATCH /api/admin/shipping-zones  (JWT at the mount point)
//
// Delivery is priced per kecamatan. The public list is what the checkout select is
// built from; the order route re-reads the chosen zone server-side, so a stale or
// tampered selection can never set its own shipping fee.
import { Router } from "express";
import * as store from "../store.js";

// ---------------------------------------------------------------------------
// Public router (mounted at /api/shipping-zones)
// ---------------------------------------------------------------------------
export const publicShippingZonesRouter = Router();

// GET /api/shipping-zones — active zones only, ordered city → kecamatan.
// Also returns the city grouping so the client can build <optgroup>s directly.
publicShippingZonesRouter.get("/", async (req, res, next) => {
  try {
    const zones = await store.listShippingZones({ activeOnly: true });
    const cities = [];
    for (const zone of zones) {
      let group = cities.find(c => c.cityName === zone.cityName);
      if (!group) { group = { cityName: zone.cityName, zones: [] }; cities.push(group); }
      group.zones.push({ id: zone.id, districtName: zone.districtName, shippingFee: zone.shippingFee });
    }
    res.json({ zones, cities });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Admin router (mounted at /api/admin/shipping-zones — requireAuth at the mount)
// ---------------------------------------------------------------------------
export const adminShippingZonesRouter = Router();

function validateZoneInput(body, { partial = false } = {}) {
  const errors = [];
  const has = k => body[k] !== undefined && body[k] !== null;

  if (!partial || has("cityName")) {
    const city = typeof body.cityName === "string" ? body.cityName.trim() : "";
    if (city.length < 2 || city.length > 80) errors.push("cityName must be 2–80 characters");
  }
  if (!partial || has("districtName")) {
    const district = typeof body.districtName === "string" ? body.districtName.trim() : "";
    if (district.length < 2 || district.length > 80) errors.push("districtName must be 2–80 characters");
  }
  if (!partial || has("shippingFee")) {
    const fee = Number(body.shippingFee);
    if (!Number.isFinite(fee) || fee < 0) errors.push("shippingFee must be a non-negative number");
    else if (fee > 10_000_000) errors.push("shippingFee looks too large");
  }
  return errors;
}

// GET /api/admin/shipping-zones — every zone, active or not.
adminShippingZonesRouter.get("/", async (req, res, next) => {
  try {
    const zones = await store.listShippingZones();
    res.json({
      zones,
      counts: { total: zones.length, active: zones.filter(z => z.isActive).length },
    });
  } catch (err) { next(err); }
});

// POST /api/admin/shipping-zones — add a kecamatan.
adminShippingZonesRouter.post("/", async (req, res, next) => {
  try {
    const errors = validateZoneInput(req.body);
    if (errors.length) return res.status(400).json({ error: "Validation failed", details: errors });

    const cityName = req.body.cityName.trim();
    const districtName = req.body.districtName.trim();
    const existing = await store.findShippingZoneByNames(cityName, districtName);
    if (existing) {
      return res.status(409).json({ error: `“${districtName}” is already listed under ${existing.cityName}.` });
    }
    const created = await store.createShippingZone({
      cityName, districtName,
      shippingFee: Number(req.body.shippingFee),
      isActive: req.body.isActive !== false,
    });
    res.status(201).json(created);
  } catch (err) { next(err); }
});

// PATCH /api/admin/shipping-zones/:id — re-price, rename, or (de)activate.
adminShippingZonesRouter.patch("/:id", async (req, res, next) => {
  try {
    const zone = await store.getShippingZone(req.params.id);
    if (!zone) return res.status(404).json({ error: "Shipping zone not found" });

    const errors = validateZoneInput(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ error: "Validation failed", details: errors });

    const data = {};
    if (req.body.cityName !== undefined) data.cityName = req.body.cityName.trim();
    if (req.body.districtName !== undefined) data.districtName = req.body.districtName.trim();
    if (req.body.shippingFee !== undefined) data.shippingFee = Number(req.body.shippingFee);
    if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;

    // Renaming must not collide with another kecamatan in the same city.
    if (data.cityName || data.districtName) {
      const clash = await store.findShippingZoneByNames(
        data.cityName ?? zone.cityName,
        data.districtName ?? zone.districtName
      );
      if (clash && clash.id !== zone.id) {
        return res.status(409).json({ error: `“${clash.districtName}” is already listed under ${clash.cityName}.` });
      }
    }

    res.json(await store.updateShippingZone(zone.id, data));
  } catch (err) { next(err); }
});

export default publicShippingZonesRouter;
