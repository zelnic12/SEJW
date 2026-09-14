// Shared formatting + safety helpers for the admin UI.

// Indonesian Rupiah: "Rp " prefix, thousands dots, no decimal cents.
export const money = n =>
  "Rp " + Math.round(Number(n) || 0).toLocaleString("id-ID");

export const num = n => Number(n || 0).toLocaleString();

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Format an ISO date as e.g. "Sep 10, 2026" or with time.
export function fmtDate(iso, withTime = false) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const opts = withTime
    ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

/**
 * Square image thumbnail with a graceful glyph fallback.
 *
 * Shared by the products table, the product edit preview and the order views so
 * they all resolve images identically. Three cases, in order:
 *   1. a real image URL          → <img>
 *   2. an "emoji:<char>" URL     → that glyph (the seed placeholder scheme)
 *   3. no url at all             → `emoji`, or 📦 when even that is gone
 *      (e.g. an order line whose product was deleted)
 *
 * `cls` names the size variant; its `-emoji` sibling styles the glyph form.
 */
export function thumb({ url = null, emoji = null, alt = "", cls = "row-thumb" } = {}) {
  if (typeof url === "string" && url && !url.startsWith("emoji:")) {
    return `<span class="${cls}"><img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" /></span>`;
  }
  const glyph = (typeof url === "string" && url.startsWith("emoji:")) ? url.slice(6) : emoji;
  return `<span class="${cls} ${cls}-emoji" role="img" aria-label="${esc(alt)}">${esc(glyph || "📦")}</span>`;
}

// Relative time for feeds: "just now", "5 minutes ago", "3 days ago".
// Falls back to an absolute date once it's older than a week, since "23 days ago"
// is less useful than the date itself.
export function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const secs = Math.round((Date.now() - then) / 1000);
  // Clamp negatives: a client clock slightly ahead of the server shouldn't
  // produce "in 2 minutes" for something that just happened.
  if (secs < 45) return "just now";

  const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (secs < 3600) return plural(Math.floor(secs / 60), "minute");
  if (secs < 86400) return plural(Math.floor(secs / 3600), "hour");
  if (secs < 604800) return plural(Math.floor(secs / 86400), "day");
  // Past a week the exact date is more useful than "23 days ago".
  return fmtDate(iso);
}

// Stock status → { label, className }
export function stockStatus(stock) {
  if (stock <= 0) return { label: "Out", className: "out" };
  if (stock <= 5) return { label: "Low", className: "low" };
  return { label: "OK", className: "ok" };
}
