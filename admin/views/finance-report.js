// Laporan keuangan: monthly profit & loss across the website, the shop and
// Shopee, with the numbers an owner checks every month.
import { api } from "../components/api.js";
import { money, esc } from "../components/format.js";
import { statGrid } from "../components/statCard.js";
import { toast } from "../components/toast.js";
import { getMonth, monthPicker, onMonthChange, monthLabel, downloadCsv, signed, tgl, installText } from "../components/finance-ui.js";

const CH = [["website", "Website"], ["toko", "Toko"], ["shopee", "Shopee"]];
const pct = (a, b) => (b ? `${(a / b * 100).toFixed(1).replace(".", ",")}%` : "—");

export async function renderFinanceReport(root) {
  root.innerHTML = `<p class="admin-status">Menyusun laporan…</p>`;
  const month = getMonth();
  let r;
  try { r = await api.finReport(month); }
  catch (err) { root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`; return; }
  const t = r.totals, c = r.channels;

  const row = (label, f, { cls = "", neg = false, count = false } = {}) => `
    <tr class="${cls}"><td>${label}</td>${CH.map(([k]) => `<td class="num">${fmt(f(c[k]), neg, count)}</td>`).join("")}
      <td class="num">${fmt(CH.reduce((s, [k]) => s + f(c[k]), 0), neg, count)}</td></tr>`;
  const fmt = (v, neg, count) => (count ? v.toLocaleString("id-ID") : neg ? (v ? `(${money(v)})` : money(0)) : signed(v));
  const gross = x => x.revenue + x.shipping - x.cost - x.fee;

  const warnings = [];
  if (t.noCostLines) warnings.push(`${t.noCostLines} baris penjualan belum punya modal (produk belum dicatat di Barang masuk, atau barang Shopee tanpa produk website). HPP-nya dihitung Rp 0, jadi laba di bawah lebih tinggi dari sebenarnya.`);
  const sh = c.shopee;
  if (sh.orders && sh.actualFeeOrders < sh.orders) {
    warnings.push(`Potongan Shopee untuk ${sh.orders - sh.actualFeeOrders} dari ${sh.orders} pesanan masih perkiraan. Upload laporan penghasilan Shopee di halaman Import Shopee untuk memakai angka asli.`);
  }
  if (r.inventory.withoutCost) warnings.push(`${r.inventory.withoutCost} produk punya stok tapi modalnya belum tercatat, sehingga nilai persediaan belum lengkap.`);

  root.innerHTML = `
    <div class="fin-toolbar">
      ${monthPicker()}
      <button class="btn btn-ghost btn-sm" id="frCsv">⬇ Unduh Excel (CSV)</button>
    </div>
    <div class="fin-stats">${statGrid([
      { icon: "💰", label: "Penjualan", value: money(t.revenue), sub: `${t.orders} pesanan · ${t.units} unit` },
      { icon: "📦", label: "HPP (modal terjual)", value: money(t.cost) },
      { icon: "📊", label: "Laba kotor", value: money(t.grossProfit), sub: `Margin ${pct(t.grossProfit, t.revenue + t.shipping)}` },
      { icon: "💸", label: "Pengeluaran", value: money(t.expenses) },
      { icon: t.netProfit >= 0 ? "✅" : "⚠️", label: "Laba bersih", value: (t.netProfit < 0 ? "−" : "") + money(Math.abs(t.netProfit)), sub: monthLabel(month) },
    ])}</div>
    ${warnings.length ? `<div class="fin-note warn">${warnings.map(w => `<p>${esc(w)}</p>`).join("")}</div>` : ""}
    <div class="fin-report">
      <div class="panel">
        <div class="panel-head"><h2>Laba rugi ${esc(monthLabel(month))}</h2></div>
        <div class="table-scroll">
          <table class="data-table fin-pl">
            <thead><tr><th></th>${CH.map(([, l]) => `<th class="num">${l}</th>`).join("")}<th class="num">Total</th></tr></thead>
            <tbody>
              ${row("Jumlah pesanan", x => x.orders, { count: true })}
              ${t.install ? `${row("Harga jual", x => x.gross)}
              ${row("Pasang &amp; material", x => x.install, { neg: true })}` : ""}
              ${row("Penjualan", x => x.revenue, { cls: t.install ? "fin-pl-sub" : "" })}
              ${row("Ongkir diterima", x => x.shipping)}
              ${row("HPP (modal)", x => x.cost, { neg: true })}
              ${row("Potongan marketplace", x => x.fee, { neg: true })}
              ${row("Laba kotor", gross, { cls: "fin-pl-total" })}
            </tbody>
          </table>
        </div>
        <table class="fin-mini fin-pl-bottom">
          <tr><td>Laba kotor</td><td class="num">${signed(t.grossProfit)}</td></tr>
          ${r.expenses.map(e => `<tr class="fin-indent"><td>${esc(e.category)}</td><td class="num">(${money(e.amount)})</td></tr>`).join("") ||
            `<tr class="fin-indent"><td>Belum ada pengeluaran tercatat</td><td class="num">${money(0)}</td></tr>`}
          <tr class="fin-pl-total"><td>Total pengeluaran</td><td class="num">(${money(t.expenses)})</td></tr>
          <tr class="fin-pl-net"><td>Laba bersih</td><td class="num">${signed(t.netProfit)}</td></tr>
        </table>
      </div>
      <div class="fin-report-grid">
        <div class="panel">
          <div class="panel-head"><h2>Stok &amp; pembelian</h2></div>
          <table class="fin-mini">
            <tr><td>Nilai persediaan saat ini</td><td class="num">${money(r.inventory.value)}</td></tr>
            <tr><td>Unit di gudang</td><td class="num">${r.inventory.units.toLocaleString("id-ID")}</td></tr>
            <tr><td>Pembelian barang ${esc(monthLabel(month))}</td><td class="num">${money(r.purchases.total)}</td></tr>
            <tr><td>Jumlah penerimaan barang</td><td class="num">${r.purchases.receipts}</td></tr>
          </table>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Produk terlaris</h2></div>
          ${r.topProducts.length ? `<div class="table-scroll"><table class="fin-mini fin-top">
            <tr><th>Produk</th><th class="num">Unit</th><th class="num">Penjualan</th><th class="num">Laba</th></tr>
            ${r.topProducts.map(p => `<tr><td>${esc(p.name)}</td><td class="num">${p.qty}</td><td class="num">${money(p.revenue)}</td>
              <td class="num">${p.profit == null ? `<span class="muted-dash" title="Modal belum tercatat">—</span>` : signed(p.profit)}</td></tr>`).join("")}
          </table></div>` : `<p class="admin-status">Belum ada penjualan di ${esc(monthLabel(month))}.</p>`}
        </div>
      </div>
    </div>`;

  onMonthChange(root, () => renderFinanceReport(root));

  root.querySelector("#frCsv").addEventListener("click", async () => {
    try {
      const [sales, receipts, expenses] = await Promise.all([api.finSales(month), api.finReceipts(month), api.finExpenses(month)]);
      const rows = [
        [`Laporan keuangan ${monthLabel(month)}`], [],
        ["Pos", ...CH.map(([, l]) => l), "Total"],
        ...[["Jumlah pesanan", x => x.orders], ["Harga jual", x => x.gross], ["Pasang & material", x => -x.install],
            ["Penjualan", x => x.revenue], ["Ongkir diterima", x => x.shipping],
            ["HPP (modal)", x => -x.cost], ["Potongan marketplace", x => -x.fee], ["Laba kotor", gross]]
          .map(([l, f]) => [l, ...CH.map(([k]) => f(c[k])), CH.reduce((s, [k]) => s + f(c[k]), 0)]),
        [],
        ...r.expenses.map(e => [`Pengeluaran: ${e.category}`, "", "", "", -e.amount]),
        ["Laba bersih", "", "", "", t.netProfit],
        [], ["Penjualan toko & Shopee"],
        ["Tanggal", "Saluran", "No. pesanan", "Pelanggan", "Barang", "Harga jual", "Pasang & material", "Penjualan", "Potongan", "HPP", "Laba"],
        ...sales.slice().reverse().map(s => [tgl(s.soldAt), s.channel === "toko" ? "Toko" : "Shopee", s.ref || "", s.customer,
          s.items.map(i => `${i.name} x${i.qty}${i.installType && i.installType !== "none" ? ` (${installText(i.installType, i.installMeters)})` : ""}`).join(" | "),
          s.subtotal - s.discount, s.install, s.revenue, s.fee, s.cost, s.profit]),
        [], ["Barang masuk"],
        ["Tanggal", "Produk", "Supplier", "Qty", "Harga beli", "Total"],
        ...receipts.slice().reverse().map(x => [x.receivedOn, x.productName, x.supplier, x.quantity, x.unitCost, x.total]),
        [], ["Pengeluaran"],
        ["Tanggal", "Jenis", "Keterangan", "Jumlah"],
        ...expenses.slice().reverse().map(e => [e.spentOn, e.category, e.note, e.amount]),
      ];
      downloadCsv(`laporan-keuangan-${month}.csv`, rows);
    } catch (err) { toast(err.message, "error"); }
  });
}
