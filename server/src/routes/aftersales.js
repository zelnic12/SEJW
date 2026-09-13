// ---- Aftersales service: warranty claims + returns/exchanges ----
//
// Public (no login — an order id + the email on that order is the credential,
// the same gate the verified-purchase review check uses):
//   POST /api/aftersales/verify-order  → is this order claimable, and what's on it
//   POST /api/aftersales               → open a request, returns the tracking id
//   GET  /api/aftersales/:id           → track one request by its id
//
// Admin (JWT enforced at the mount point in index.js):
//   GET   /api/admin/aftersales        → list, filterable by type + status
//   GET   /api/admin/aftersales/:id    → full detail incl. linked order + items
//   PATCH /api/admin/aftersales/:id    → move status / write customer-visible notes
//
// Evidence photos reuse the existing Cloudinary upload flow (src/cloudinary.js +
// src/upload.js): multer keeps them in memory, the buffer is streamed to
// Cloudinary, and the DB stores the returned URL + public_id.
import { Router } from "express";
import * as store from "../store.js";
import { uploadBuffer, destroyImage, FOLDERS } from "../cloudinary.js";
import { imageUpload, runUpload, uploadErrorMessage, validateImageFile, assetId } from "../upload.js";

const MAX_PHOTOS = 5;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 2000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Human-readable reason why an order can't be claimed against yet.
function ineligibleReason(status) {
  switch (status) {
    case "awaiting_payment":
      return "This order is still awaiting payment. Aftersales requests can be opened once the order has been delivered.";
    case "needs_shipping":
      return "This order hasn't shipped yet. Please open a request once you've received your item.";
    case "cancelled":
      return "This order was cancelled, so there's nothing to claim against it. Please contact us if that looks wrong.";
    default:
      return "This order isn't eligible for an aftersales request yet.";
  }
}

// Show the customer which address a request is tied to without publishing it:
// "buyer@example.com" → "b***@example.com".
function maskEmail(email) {
  const [user, domain] = String(email || "").split("@");
  if (!user || !domain) return "";
  return `${user.slice(0, 1)}***@${domain}`;
}

// The payload a tracking-id holder may see. Deliberately narrower than the admin
// view: no raw email, no Cloudinary public ids.
function publicView(request) {
  return {
    id: request.id,
    orderId: request.orderId,
    type: request.type,
    status: request.status,
    productName: request.productName,
    description: request.description,
    adminNotes: request.adminNotes,
    photos: request.photos.map(p => p.url).filter(Boolean),
    customerEmail: maskEmail(request.customerEmail),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Public router (mounted at /api/aftersales)
// ---------------------------------------------------------------------------
export const publicAftersalesRouter = Router();

// POST /api/aftersales/verify-order  { orderId, email }
// Lets the request form confirm the order up front and offer its line items to
// pick from, using exactly the same verification as the submission itself.
publicAftersalesRouter.post("/verify-order", async (req, res, next) => {
  try {
    const orderId = String(req.body?.orderId || "").trim();
    const email = String(req.body?.email || "").trim();
    if (!orderId || !email) {
      return res.status(400).json({ error: "Please enter both your order ID and the email used for the order." });
    }
    const order = await store.findOrderForAftersales(orderId, email);
    if (!order) {
      return res.status(404).json({ error: "We couldn't find an order with that ID and email address. Please check both and try again." });
    }
    if (!order.eligible) {
      return res.status(400).json({ error: ineligibleReason(order.status), orderStatus: order.status });
    }
    res.json({
      orderId: order.id,
      customerName: order.customerName,
      orderStatus: order.status,
      orderDate: order.createdAt,
      items: await store.getOrderItemsForAftersales(order.id),
    });
  } catch (err) { next(err); }
});

// POST /api/aftersales — open a request (multipart/form-data)
// Fields: orderId, customerEmail, type, productId (optional), description
// Files:  photos (optional, up to 5 images)
publicAftersalesRouter.post("/", async (req, res, next) => {
  // 1) Parse the multipart body into memory (nothing hits the disk).
  try {
    await runUpload(imageUpload.array("photos", MAX_PHOTOS), req, res);
  } catch (err) {
    return res.status(400).json({ error: uploadErrorMessage(err) });
  }

  const files = req.files || [];
  const orderId = String(req.body?.orderId || "").trim();
  const customerEmail = String(req.body?.customerEmail || "").trim();
  const type = String(req.body?.type || "").trim();
  const description = String(req.body?.description || "").trim();
  const productIdRaw = req.body?.productId;

  // 2) Shape validation first — cheap, and keeps junk away from Cloudinary.
  const errors = [];
  if (!orderId) errors.push("orderId is required");
  if (!EMAIL_RE.test(customerEmail)) errors.push("customerEmail must be a valid email address");
  if (!store.AFTERSALES_TYPES.includes(type)) {
    errors.push("type must be 'warranty_claim' or 'return_exchange'");
  }
  if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    errors.push(`description must be ${DESCRIPTION_MIN}–${DESCRIPTION_MAX} characters`);
  }
  let productId = null;
  if (productIdRaw !== undefined && productIdRaw !== null && String(productIdRaw).trim() !== "") {
    productId = Number(productIdRaw);
    if (!Number.isInteger(productId) || productId <= 0) errors.push("productId must be a positive integer");
  }
  if (files.length > MAX_PHOTOS) errors.push(`at most ${MAX_PHOTOS} photos may be attached`);
  for (const file of files) {
    const problem = validateImageFile(file);
    if (problem) errors.push(problem);
  }
  if (errors.length) return res.status(400).json({ error: "Validation failed", details: errors });

  try {
    // 3) The order must exist, belong to this email, and be fulfilled.
    const order = await store.findOrderForAftersales(orderId, customerEmail);
    if (!order) {
      return res.status(404).json({ error: "We couldn't find an order with that ID and email address. Please check both and try again." });
    }
    if (!order.eligible) {
      return res.status(400).json({ error: ineligibleReason(order.status), orderStatus: order.status });
    }

    // 4) A named product must actually be on that order.
    if (productId != null) {
      const items = await store.getOrderItemsForAftersales(order.id);
      if (!items.some(i => i.productId === productId)) {
        return res.status(400).json({ error: "That product isn't part of this order." });
      }
    }

    // 5) Upload evidence photos, then record. If the insert fails we delete the
    //    assets we just created so Cloudinary doesn't collect orphans.
    const photos = [];
    try {
      for (const file of files) {
        const asset = await uploadBuffer(file.buffer, {
          folder: FOLDERS.aftersales,
          publicId: assetId("as"),
        });
        photos.push({ url: asset.url, publicId: asset.publicId });
      }
    } catch (err) {
      await Promise.all(photos.map(p => destroyImage(p.publicId)));
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      throw err;
    }

    let created;
    try {
      created = await store.createAftersalesRequest({
        orderId: order.id,
        type,
        productId,
        // Snapshot the name from the verified order rather than trusting input.
        customerName: order.customerName,
        customerEmail,
        description,
        photos,
      });
    } catch (dbErr) {
      await Promise.all(photos.map(p => destroyImage(p.publicId)));
      throw dbErr;
    }

    // The tracking id is the only thing the customer needs to keep.
    res.status(201).json({
      id: created.id,
      status: created.status,
      type: created.type,
      createdAt: created.createdAt,
      trackingUrl: `/aftersales.html?track=${encodeURIComponent(created.id)}`,
    });
  } catch (err) { next(err); }
});

// GET /api/aftersales/:id — track a request. The tracking id IS the key, so
// there is deliberately no public endpoint that lists requests.
publicAftersalesRouter.get("/:id", async (req, res, next) => {
  try {
    const request = await store.getAftersalesRequest(req.params.id);
    if (!request) {
      return res.status(404).json({ error: "No request found with that tracking code. Please check the code and try again." });
    }
    res.json(publicView(request));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Admin router (mounted at /api/admin/aftersales — requireAuth at the mount)
// ---------------------------------------------------------------------------
export const adminAftersalesRouter = Router();

// GET /api/admin/aftersales?type=&status=
adminAftersalesRouter.get("/", async (req, res, next) => {
  try {
    const type = req.query.type ? String(req.query.type) : null;
    const status = req.query.status ? String(req.query.status) : null;
    if (type && !store.AFTERSALES_TYPES.includes(type)) {
      return res.status(400).json({ error: `Unknown type filter "${type}"` });
    }
    if (status && !store.AFTERSALES_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Unknown status filter "${status}"` });
    }
    const [requests, counts] = await Promise.all([
      store.listAftersalesRequests({ type, status }),
      store.getAftersalesStatusCounts(),
    ]);
    res.json({ requests, counts });
  } catch (err) { next(err); }
});

// GET /api/admin/aftersales/:id — request + the order it belongs to.
adminAftersalesRouter.get("/:id", async (req, res, next) => {
  try {
    const request = await store.getAftersalesRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "Request not found" });
    const order = await store.getOrder(request.orderId);
    res.json({
      ...request,
      // Tells the UI which buttons to offer, so the workflow lives in one place.
      allowedNextStatuses: store.AFTERSALES_TRANSITIONS[request.status] || [],
      order: order
        ? {
            id: order.id, status: order.status, createdAt: order.createdAt,
            customer: order.customer, amounts: order.amounts, items: order.items,
            fulfillmentMethod: order.fulfillmentMethod,
          }
        : null,
    });
  } catch (err) { next(err); }
});

// PATCH /api/admin/aftersales/:id  { status?, adminNotes? }
adminAftersalesRouter.patch("/:id", async (req, res, next) => {
  try {
    const request = await store.getAftersalesRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "Request not found" });

    const data = {};

    if (req.body?.status !== undefined) {
      const next = String(req.body.status);
      if (!store.AFTERSALES_STATUSES.includes(next)) {
        return res.status(400).json({ error: `Unknown status "${next}"` });
      }
      const allowed = store.AFTERSALES_TRANSITIONS[request.status] || [];
      // Re-saving the same status is a no-op rather than an error.
      if (next !== request.status && !allowed.includes(next)) {
        return res.status(400).json({
          error: allowed.length
            ? `Can't move a request from "${request.status}" to "${next}". Allowed next: ${allowed.join(", ")}.`
            : `"${request.status}" is a final state — this request can't be moved any further.`,
          allowedNextStatuses: allowed,
        });
      }
      data.status = next;
    }

    if (req.body?.adminNotes !== undefined) {
      const notes = String(req.body.adminNotes);
      if (notes.length > 2000) return res.status(400).json({ error: "adminNotes must be 2000 characters or fewer" });
      // Notes are shown to the customer on the tracking page.
      data.adminNotes = notes.trim() || null;
    }

    const updated = await store.updateAftersalesRequest(req.params.id, data);
    res.json({
      ...updated,
      allowedNextStatuses: store.AFTERSALES_TRANSITIONS[updated.status] || [],
    });
  } catch (err) { next(err); }
});

export default publicAftersalesRouter;
