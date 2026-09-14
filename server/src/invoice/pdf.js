// ---- Server-side PDF invoice generation (pdfkit) ----
// Programmatic PDF (no browser/canvas). A4, white background, Sinar Elektronik
// red accents, clean typography, print-friendly.
import PDFDocument from "pdfkit";
import { formatMoney } from "../money.js";

// Brand + layout constants.
const RED = "#C8102E";
const DARK = "#1A1A1A";
const MUTED = "#666666";
const BORDER = "#E5E5E5";
const PAGE_MARGIN = 48;

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Stream a PDF invoice to `res`.
 * @param {object} order  order in mapOrder() shape
 * @param {object} store  store settings (name, address, etc.)
 * @param {Writable} res  destination stream (Express response)
 */
export function streamInvoicePdf(order, store, res) {
  const currency = store.currency || "USD";
  const money = n => formatMoney(currency, n);
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });
  doc.pipe(res);

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - PAGE_MARGIN * 2;
  const left = PAGE_MARGIN;
  const right = pageWidth - PAGE_MARGIN;

  // ---- Header: brand + INVOICE title ----
  // Red logo square with "SE".
  doc.roundedRect(left, 46, 34, 34, 6).fill(RED);
  doc.fillColor("#fff").font("Helvetica-Bold").fontSize(15).text("SE", left, 55, { width: 34, align: "center" });

  doc.fillColor(DARK).font("Helvetica-Bold").fontSize(16).text(store.name || "Sinar Elektronik", left + 44, 50);
  doc.fillColor(MUTED).font("Helvetica").fontSize(9);
  let sy = 70;
  const storeLines = [
    store.tagline,
    [store.address, store.city, store.postal].filter(Boolean).join(", "),
    store.country,
    [store.phone, store.email].filter(Boolean).join(" · "),
    store.taxId ? `Tax ID: ${store.taxId}` : "",
  ].filter(Boolean);
  for (const line of storeLines) { doc.text(line, left + 44, sy); sy += 12; }

  // INVOICE title (right).
  doc.fillColor(RED).font("Helvetica-Bold").fontSize(24).text("INVOICE", left, 50, { width: contentWidth, align: "right" });
  doc.fillColor(MUTED).font("Helvetica").fontSize(10)
    .text(order.invoiceNo || order.id, left, 80, { width: contentWidth, align: "right" });

  // Divider.
  let y = Math.max(sy, 100) + 4;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).lineWidth(1).stroke();
  y += 16;

  // ---- Meta row: invoice/order info (left) + bill-to (right) ----
  const colGap = 24;
  const colW = (contentWidth - colGap) / 2;

  const labelVal = (x, yy, label, val) => {
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(label.toUpperCase(), x, yy);
    doc.fillColor(DARK).font("Helvetica-Bold").fontSize(10).text(val || "—", x, yy + 10, { width: colW });
  };

  const startY = y;
  labelVal(left, y, "Invoice number", order.invoiceNo || "—"); y += 26;
  labelVal(left, y, "Order number", order.id); y += 26;
  labelVal(left, y, "Order date", fmtDate(order.createdAt)); y += 26;
  labelVal(left, y, "Status", `${(order.status || "").toUpperCase()} · PAID`);

  // Bill-to (right column).
  let ry = startY;
  const rx = left + colW + colGap;
  const c = order.customer || {};
  doc.fillColor(MUTED).font("Helvetica").fontSize(8).text("BILL TO", rx, ry); ry += 12;
  doc.fillColor(DARK).font("Helvetica-Bold").fontSize(11).text(c.name || "—", rx, ry, { width: colW }); ry += 15;
  doc.fillColor(MUTED).font("Helvetica").fontSize(9);
  const custLines = [
    c.email, c.phone,
    c.address,
    // Kecamatan, kota, postal code — the district is present for delivery orders.
    [c.district, c.city, c.postal].filter(Boolean).join(", "),
    c.country,
  ].filter(Boolean);
  for (const line of custLines) { doc.text(line, rx, ry, { width: colW }); ry += 12; }

  y = Math.max(y + 20, ry + 12);

  // ---- Items table ----
  const cols = {
    name: left,
    qty: left + contentWidth * 0.52,
    price: left + contentWidth * 0.64,
    total: left + contentWidth * 0.82,
  };
  const colRightEdge = right;

  // Header band.
  doc.rect(left, y, contentWidth, 22).fill("#F7F7F7");
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(9);
  doc.text("PRODUCT", cols.name + 6, y + 7, { width: contentWidth * 0.5 });
  doc.text("QTY", cols.qty, y + 7, { width: contentWidth * 0.1, align: "right" });
  doc.text("PRICE", cols.price, y + 7, { width: contentWidth * 0.16, align: "right" });
  doc.text("TOTAL", cols.total, y + 7, { width: colRightEdge - cols.total - 6, align: "right" });
  y += 22;

  // Rows.
  doc.font("Helvetica").fontSize(10);
  for (const it of order.items || []) {
    const lineTotal = it.price * it.qty;
    const discounted = it.regularPrice != null && it.regularPrice > it.price;
    const rowH = discounted ? 30 : 22;

    doc.fillColor(DARK).text(it.name, cols.name + 6, y + 6, { width: contentWidth * 0.5 - 6 });
    doc.fillColor(DARK).text(String(it.qty), cols.qty, y + 6, { width: contentWidth * 0.1, align: "right" });
    doc.fillColor(DARK).text(money(it.price), cols.price, y + 6, { width: contentWidth * 0.16, align: "right" });
    doc.fillColor(DARK).text(money(lineTotal), cols.total, y + 6, { width: colRightEdge - cols.total - 6, align: "right" });

    if (discounted) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(8)
        .text(`was ${money(it.regularPrice)} each`, cols.price, y + 19, { width: colRightEdge - cols.price - 6, align: "right" });
      doc.font("Helvetica").fontSize(10);
    }

    y += rowH;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).lineWidth(0.5).stroke();
  }

  // ---- Totals block (right aligned) ----
  y += 14;
  const totalsX = left + contentWidth * 0.58;
  const totalsW = right - totalsX;
  const a = order.amounts || {};

  const totalRow = (label, val, opts = {}) => {
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.bold ? 12 : 10)
      .fillColor(opts.color || (opts.bold ? DARK : MUTED));
    doc.text(label, totalsX, y, { width: totalsW * 0.5 });
    doc.fillColor(opts.color || DARK).text(val, totalsX + totalsW * 0.5, y, { width: totalsW * 0.5, align: "right" });
    y += opts.bold ? 20 : 16;
  };

  totalRow("Subtotal", money(a.subtotal));
  if (a.discount && a.discount > 0) totalRow("Discount", `− ${money(a.discount)}`, { color: RED });
  // Shipping names the kecamatan it was priced for, when there is one.
  totalRow(
    order.customer?.district ? `Shipping (${order.customer.district})` : "Shipping",
    a.shipping === 0 ? "Free" : money(a.shipping)
  );
  // No tax line: tax was removed from checkout.

  // Grand total with red rule.
  doc.moveTo(totalsX, y + 2).lineTo(right, y + 2).strokeColor(RED).lineWidth(1.5).stroke();
  y += 10;
  totalRow("Grand Total", money(a.total), { bold: true, color: RED });

  // ---- Footer ----
  // Anchor near the bottom only if there's room; otherwise place it just below
  // the totals so a normal invoice stays on one page.
  const bottomAnchor = doc.page.height - 70;
  const footerY = y + 24 < bottomAnchor ? bottomAnchor : y + 24;
  doc.moveTo(left, footerY).lineTo(right, footerY).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fillColor(MUTED).font("Helvetica").fontSize(8)
    .text(`Thank you for shopping at ${store.name || "Sinar Elektronik"}.`, left, footerY + 10, { width: contentWidth, align: "center" });
  if (store.bankInfo) {
    doc.text(store.bankInfo, left, footerY + 24, { width: contentWidth, align: "center" });
  }
  doc.text("This is a system-generated invoice.", left, footerY + (store.bankInfo ? 38 : 24), { width: contentWidth, align: "center" });

  doc.end();
}
