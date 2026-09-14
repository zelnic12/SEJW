// ---- Order invoices: mounted at /api/orders ----
// GET /api/orders/:id/invoice       → invoice JSON
// GET /api/orders/:id/invoice/pdf   → invoice PDF (A4)
//
// Access control: EITHER a valid admin JWT (Authorization: Bearer) OR the
// correct per-order access token (?token=...). This lets an unauthenticated
// customer view only their own invoice, while admins can view any invoice —
// without introducing a customer login system.
import { Router } from "express";
import * as store from "../store.js";
import { verifyToken } from "../auth.js";
import { streamInvoicePdf } from "../invoice/pdf.js";

const router = Router();

// Resolve the order and authorize access. Attaches req.order on success.
async function authorizeInvoice(req, res, next) {
  try {
    const order = await store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Path 1: valid admin JWT.
    let isAdmin = false;
    const authz = req.headers.authorization || "";
    if (authz.startsWith("Bearer ")) {
      try {
        const payload = verifyToken(authz.slice(7));
        const admin = await store.getAdminById(payload.sub);
        if (admin) isAdmin = true;
      } catch { /* fall through to token check */ }
    }

    // Path 2: correct per-order access token.
    const token = req.query.token || req.headers["x-invoice-token"];
    const tokenOk = order.accessToken && token && String(token) === order.accessToken;

    if (!isAdmin && !tokenOk) {
      return res.status(403).json({ error: "Not authorized to view this invoice" });
    }

    req.order = order;
    next();
  } catch (err) { next(err); }
}

// Build the invoice payload (order + store info). Never trusts client data —
// everything comes from the stored order.
async function buildInvoice(order) {
  const settings = await store.getStoreSettings();
  return {
    invoiceNo: order.invoiceNo || order.id,
    order: {
      id: order.id,
      createdAt: order.createdAt,
      status: order.status,
      // The order's real payment state — never a hardcoded "paid". An invoice
      // for an unpaid order must not claim it was settled.
      paymentStatus: order.paymentStatus || "pending",
    },
    store: settings,
    customer: order.customer,
    items: order.items.map(it => ({
      name: it.name,
      qty: it.qty,
      unitPrice: it.price,
      regularPrice: it.regularPrice,
      discounted: it.regularPrice != null && it.regularPrice > it.price,
      lineTotal: +(it.price * it.qty).toFixed(2),
    })),
    amounts: order.amounts,
  };
}

// GET /api/orders/:id/invoice — JSON
router.get("/:id/invoice", authorizeInvoice, async (req, res, next) => {
  try {
    res.json(await buildInvoice(req.order));
  } catch (err) { next(err); }
});

// GET /api/orders/:id/invoice/pdf — PDF
router.get("/:id/invoice/pdf", authorizeInvoice, async (req, res, next) => {
  try {
    const settings = await store.getStoreSettings();
    const filename = `${req.order.invoiceNo || req.order.id}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    const disposition = req.query.download ? "attachment" : "inline";
    res.setHeader("Content-Disposition", `${disposition}; filename="${filename}"`);
    streamInvoicePdf(req.order, settings, res);
  } catch (err) { next(err); }
});

export default router;
