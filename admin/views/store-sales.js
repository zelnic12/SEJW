// Penjualan toko: walk-in sales at the shop. Stock comes off the same product
// records the website sells from, so an item sold in the shop can't also be
// sold online.
import { api } from "../components/api.js";
import { money, esc } from "../components/format.js";
import { dataTable } from "../components/dataTable.js";
import { toast } from "../components/toast.js";
import {
  getMonth, monthPicker, onMonthChange, monthLabel, defaultDate, today, tgl,
  productDatalist, pickedProductId, readRupiah, confirmAction, signed,
} from "../components/finance-ui.js";

const lineRow = i => `
  <div class="fin-line" data-line="${i}">
    <div class="form-field fin-line-product"><label for="slProduct${i}">Produk</label>
      <input id="slProduct${i}" list="slProducts" data-f="product" placeholder="Ketik nama atau model" /></div>
    <div class="form-field fin-line-qty"><label for="slQty${i}">Qty</label>
      <input id="slQty${i}" type="number" min="1" step="1" value="1" data-f="qty" /></div>
    <div class="form-field fin-line-price"><label for="slPrice${i}">Harga / unit</label>
      <input id="slPrice${i}" inputmode="numeric" data-f="price" /></div>
    <button type="button" class="icon-btn fin-line-del" data-remove="${i}" aria-label="Hapus baris">✕</button>
  </div>`;

export async function renderStoreSales(root) {
  root.innerHTML = `<p class="admin-status">Memuat penjualan toko…</p>`;
  const month = getMonth();
  let products, sales;
  try {
    [products, sales] = await Promise.all([api.finProducts(), api.finSales(month, "toko")]);
  } catch (err) {
    root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`;
    return;
  }
  const byId = new Map(products.map(p => [p.id, p]));
  const sum = k => sales.reduce((s, x) => s + x[k], 0);

  root.innerHTML = `
    <div class="fin-toolbar">${monthPicker()}</div>
    <div class="fin-split">
      <div class="panel">
        <div class="panel-head"><h2>Catat penjualan toko</h2></div>
        <form id="slForm" class="fin-form" autocomplete="off">
          <div class="form-grid">
            <div class="form-field"><label for="slDate">Tanggal</label><input type="date" id="slDate" max="${today()}" value="${defaultDate()}" required /></div>
            <div class="form-field"><label for="slCustomer">Pelanggan</label><input id="slCustomer" placeholder="Opsional" /></div>
          </div>
          ${productDatalist("slProducts", products.filter(p => p.stock > 0))}
          <div id="slLines">${lineRow(0)}</div>
          <button type="button" class="btn btn-ghost btn-sm" id="slAdd">+ Tambah barang</button>
          <div class="form-grid">
            <div class="form-field"><label for="slDiscount">Diskon (Rp)</label><input id="slDiscount" inputmode="numeric" value="0" /></div>
            <div class="form-field"><label for="slNote">Catatan</label><input id="slNote" placeholder="Opsional, mis. tunai / transfer" /></div>
          </div>
          <div class="fin-sum" id="slSum"></div>
          <p class="form-error" id="slErr" hidden></p>
          <button class="btn btn-primary" type="submit" id="slSave">Simpan penjualan</button>
        </form>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>Penjualan toko ${esc(monthLabel(month))}</h2>
          <span class="fin-total">${sales.length} transaksi · <strong>${money(sum("revenue"))}</strong></span>
        </div>
        ${dataTable({
          columns: [
            { label: "Tgl", render: s => `<span class="fin-date">${tgl(s.soldAt)}</span>` },
            { label: "Barang", render: s => `${s.items.map(i => `<span title="${esc(i.name)}">${esc(byId.get(i.productId)?.shortName || i.name)}</span> <span class="muted-dash">×${i.qty}</span>`).join("<br>")}
                <span class="muted-sm">${esc([s.customer || "Umum", s.note].filter(Boolean).join(" · "))}</span>` },
            { label: "Total", num: true, render: s => money(s.revenue) + (s.discount ? `<span class="muted-sm">diskon ${money(s.discount)}</span>` : "") },
            { label: "Laba", num: true, render: s => s.cost ? signed(s.profit) : `<span class="muted-dash" title="Modal belum tercatat">—</span>` },
            { label: "", render: s => `<button class="btn btn-ghost btn-xs" data-del="${s.id}">Batalkan</button>` },
          ],
          rows: sales,
          empty: `Belum ada penjualan toko di ${monthLabel(month)}.`,
        })}
      </div>
    </div>`;

  onMonthChange(root, () => renderStoreSales(root));
  const $ = s => root.querySelector(s);
  let next = 1;

  const readLines = () => [...root.querySelectorAll("[data-line]")].map(el => {
    const productId = pickedProductId(el.querySelector('[data-f="product"]').value);
    return {
      el, productId, product: byId.get(productId),
      quantity: Number(el.querySelector('[data-f="qty"]').value),
      unitPrice: readRupiah(el.querySelector('[data-f="price"]').value),
    };
  });

  const updateSum = () => {
    const lines = readLines().filter(l => l.product && Number.isFinite(l.unitPrice) && l.quantity > 0);
    const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const discount = Math.max(0, readRupiah($("#slDiscount").value) || 0);
    const cost = lines.reduce((s, l) => s + l.quantity * l.product.avgCost, 0);
    const known = lines.every(l => l.product.avgCost > 0);
    $("#slSum").innerHTML = lines.length ? `
      <span>Total <strong>${money(subtotal - discount)}</strong></span>
      ${known ? `<span>Perkiraan laba <strong>${signed(subtotal - discount - cost)}</strong></span>` : `<span class="muted-sm">Laba muncul setelah modal produk tercatat di Barang masuk.</span>`}` : "";
  };

  $("#slLines").addEventListener("change", e => {
    if (e.target.dataset.f !== "product") return updateSum();
    const line = e.target.closest("[data-line]");
    const p = byId.get(pickedProductId(e.target.value));
    if (p) line.querySelector('[data-f="price"]').value = p.price.toLocaleString("id-ID");
    updateSum();
  });
  $("#slLines").addEventListener("input", updateSum);
  $("#slDiscount").addEventListener("input", updateSum);
  $("#slLines").addEventListener("click", e => {
    const i = e.target.dataset.remove;
    if (i === undefined) return;
    if (root.querySelectorAll("[data-line]").length > 1) e.target.closest("[data-line]").remove();
    updateSum();
  });
  $("#slAdd").addEventListener("click", () => {
    $("#slLines").insertAdjacentHTML("beforeend", lineRow(next++));
    root.querySelector(`#slProduct${next - 1}`).focus();
  });

  $("#slForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#slErr");
    err.hidden = true;
    const lines = readLines().filter(l => l.el.querySelector('[data-f="product"]').value.trim());
    const bad = lines.find(l => !l.product || !(l.quantity >= 1) || !Number.isFinite(l.unitPrice));
    if (!lines.length || bad) {
      err.textContent = !lines.length ? "Tambahkan minimal satu barang." : "Pilih produk dari daftar dan isi qty serta harganya.";
      err.hidden = false;
      return;
    }
    const discount = readRupiah($("#slDiscount").value) || 0;
    const btn = $("#slSave");
    btn.disabled = true;
    try {
      await api.finCreateSale({
        soldOn: $("#slDate").value,
        customer: $("#slCustomer").value,
        note: $("#slNote").value,
        discount: Math.max(0, discount),
        items: lines.map(l => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice })),
      });
      toast("Penjualan tersimpan, stok sudah dikurangi", "success");
      renderStoreSales(root);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false; btn.disabled = false;
    }
  });

  root.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async () => {
    const s = sales.find(x => x.id === Number(btn.dataset.del));
    const ok = await confirmAction({
      title: "Batalkan penjualan?",
      message: `Penjualan ${money(s.revenue)} dihapus dan barangnya dikembalikan ke stok.`,
      confirmLabel: "Batalkan penjualan",
    });
    if (!ok) return;
    try {
      await api.finDeleteSale(s.id);
      toast("Penjualan dibatalkan, stok dikembalikan", "success");
      renderStoreSales(root);
    } catch (ex) { toast(ex.message, "error", 6000); }
  }));
}
