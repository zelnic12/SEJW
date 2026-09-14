// Server-side money formatting, honouring the store's configured currency.
//
// Lives here rather than inside the PDF renderer because more than one place now
// needs it: invoices, and the pre-formatted admin notification text.
export function formatMoney(currency, n) {
  if (currency === "IDR") {
    // Indonesian Rupiah: thousands dots, no decimal cents.
    return "Rp " + Math.round(Number(n) || 0).toLocaleString("id-ID");
  }
  const value = Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = currency === "USD" ? "$" : "";
  return symbol ? `${symbol}${value}` : `${value} ${currency}`;
}
