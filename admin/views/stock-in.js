// Barang masuk: record stock bought from suppliers. Each entry adds to the
// product's stock and updates its average cost (modal), which the finance
// report uses for HPP.
import { api } from "../components/api.js";
import { money, esc } from "../components/format.js";
import { dataTable } from "../components/dataTable.js";
import { toast } from "../components/toast.js";
import {
  getMonth, monthPicker, onMonthChange, monthLabel, defaultDate, today, tgl,
  productDatalist, pickedProductId, readRupiah, confirmAction,
} from "../components/finance-ui.js";
import { renderStockInImport } from "./stock-in-import.js";

export async function renderStockIn(root) {
  root.innerHTML = `<p class="admin-status">Memuat barang masuk…</p>`;
  const month = getMonth();
  let products, receipts, suppliers;
  try {
    [products, receipts, suppliers] = await Promise.all([api.finProducts(), api.finReceipts(month), api.finSuppliers()]);
  } catch (err) {
    root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`;
    return;
  }
  const byId = new Map(products.map(p => [p.id, p]));
  const total = receipts.reduce((s, r) => s + r.total, 0);
  const noCost = products.filter(p => p.stock > 0 && p.avgCost === 0).length;

  root.innerHTML = `
    <div class="fin-toolbar">${monthPicker()}<button class="btn btn-ghost btn-sm" id="rcImport">⬆ Import Excel</button></div>
    <div class="fin-split">
      <div class="panel">
        <div class="panel-head"><h2>Catat barang masuk</h2></div>
        <form id="rcForm" class="fin-form" autocomplete="off">
          <div class="form-field"><label for="rcDate">Tanggal</label><input type="date" id="rcDate" max="${today()}" value="${defaultDate()}" required /></div>
          <div class="form-field"><label for="rcProduct">Produk</label>
            <input id="rcProduct" list="rcProducts" placeholder="Ketik nama atau model, mis. TAC-05CSD" required />
            ${productDatalist("rcProducts", products)}
          </div>
          <div class="fin-newprod-offer" id="rcOffer" hidden>
            <span>Produk ini belum ada di website.</span>
            <button type="button" class="btn btn-ghost btn-xs" id="rcNewBtn">+ Tambah produk baru</button>
          </div>
          <fieldset class="fin-newprod-box" id="rcNew" hidden>
            <legend>Produk baru <button type="button" class="btn btn-ghost btn-xs" id="rcNewCancel">Batal</button></legend>
            <div class="form-field"><label for="npName">Nama produk</label><input id="npName" placeholder="mis. Midea MSCE-05CRF8 AC 1/2 PK" /></div>
            <div class="form-grid">
              <div class="form-field"><label for="npBrand">Merek</label><input id="npBrand" /></div>
              <div class="form-field"><label for="npCategory">Kategori</label><input id="npCategory" list="npCategories" /></div>
            </div>
            <datalist id="npCategories">${[...new Set(products.map(p => p.category).filter(Boolean))].sort().map(c => `<option value="${esc(c)}"></option>`).join("")}</datalist>
            <div class="form-field"><label for="npPrice">Harga jual di website (Rp)</label><input id="npPrice" inputmode="numeric" placeholder="mis. 3.299.000" /></div>
            <p class="form-hint">Produk ditambahkan ke website dengan stok dari barang masuk ini. Foto dan deskripsinya bisa dilengkapi di menu Products.</p>
          </fieldset>
          <div class="form-grid">
            <div class="form-field"><label for="rcQty">Jumlah (unit)</label><input type="number" id="rcQty" min="1" step="1" value="1" required /></div>
            <div class="form-field"><label for="rcCost">Harga beli / unit (Rp)</label><input id="rcCost" inputmode="numeric" placeholder="mis. 2.450.000" required /></div>
          </div>
          <div class="form-field"><label for="rcSupplier">Supplier</label>
            <input id="rcSupplier" list="rcSuppliers" placeholder="mis. CV Sinar Jaya" />
            <datalist id="rcSuppliers">${suppliers.map(s => `<option value="${esc(s)}"></option>`).join("")}</datalist>
          </div>
          <div class="form-field"><label for="rcNote">Catatan</label><input id="rcNote" placeholder="Opsional, mis. no. faktur" /></div>
          <p class="form-hint" id="rcHint">Stok produk bertambah dan modal rata-ratanya diperbarui otomatis.</p>
          <p class="form-error" id="rcErr" hidden></p>
          <button class="btn btn-primary" type="submit" id="rcSave">Simpan barang masuk</button>
        </form>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>Barang masuk ${esc(monthLabel(month))}</h2>
          <span class="fin-total">Total pembelian <strong>${money(total)}</strong></span>
        </div>
        ${noCost ? `<p class="fin-note warn">${noCost} produk punya stok tapi modalnya belum tercatat. Catat barang masuknya di sini supaya laba di laporan akurat.</p>` : ""}
        ${dataTable({
          columns: [
            { label: "Tgl", render: r => `<span class="fin-date">${tgl(r.receivedOn)}</span>` },
            { label: "Produk", render: r => `<span title="${esc(r.productName)}">${esc(byId.get(r.productId)?.shortName || r.productName)}</span><span class="muted-sm">${esc([r.supplier, r.note].filter(Boolean).join(" · ") || "—")}</span>` },
            { label: "Qty", num: true, render: r => r.quantity.toLocaleString("id-ID") },
            { label: "Harga beli", num: true, render: r => money(r.unitCost) },
            { label: "Total", num: true, render: r => money(r.total) },
            { label: "", render: r => `<button class="btn btn-ghost btn-xs" data-del="${r.id}">Hapus</button>` },
          ],
          rows: receipts,
          empty: `Belum ada barang masuk di ${monthLabel(month)}.`,
        })}
      </div>
    </div>`;

  onMonthChange(root, () => renderStockIn(root));
  root.querySelector("#rcImport").addEventListener("click", () => renderStockInImport(root, () => renderStockIn(root)));

  const $ = s => root.querySelector(s);
  const hint = $("#rcHint");

  $("#rcProduct").addEventListener("change", async () => {
    const id = pickedProductId($("#rcProduct").value);
    const p = byId.get(id);
    if (!p) return;
    const full = `${p.name}. `;
    hint.textContent = full + (p.avgCost
      ? `Stok sekarang ${p.stock} · modal rata-rata ${money(p.avgCost)}`
      : p.stock > 0
        ? `Stok sekarang ${p.stock} belum punya modal. Harga beli yang Anda isi akan dipakai sebagai modal untuk semua stok produk ini.`
        : `Stok sekarang 0 · modal belum ada`);
    try {
      const last = await api.finLastReceipt(id);
      if (last) {
        if (!$("#rcCost").value) $("#rcCost").value = last.unitCost.toLocaleString("id-ID");
        if (!$("#rcSupplier").value) $("#rcSupplier").value = last.supplier;
        hint.textContent += ` · harga beli terakhir ${money(last.unitCost)}`;
      }
    } catch { /* prefill is a convenience */ }
  });

  // Typed a product that isn't on the website: offer to add it.
  let newMode = false;
  const setNewMode = async on => {
    newMode = on;
    $("#rcNew").hidden = !on;
    $("#rcOffer").hidden = true;
    $("#rcProduct").disabled = on;
    if (!on) { $("#rcProduct").focus(); return; }
    const typed = $("#rcProduct").value.trim();
    $("#npName").value = typed;
    $("#npName").focus();
    try {
      const p = await api.finNewProductProposal(typed);
      if (!$("#npBrand").value) $("#npBrand").value = p.brand || "";
      if (!$("#npCategory").value) $("#npCategory").value = p.category || "";
    } catch { /* the admin can type them */ }
  };
  const updateOffer = () => {
    const v = $("#rcProduct").value.trim();
    $("#rcOffer").hidden = newMode || !v || pickedProductId(v) != null;
  };
  $("#rcProduct").addEventListener("input", updateOffer);
  $("#rcProduct").addEventListener("change", updateOffer);
  $("#rcNewBtn").addEventListener("click", () => setNewMode(true));
  $("#rcNewCancel").addEventListener("click", () => setNewMode(false));

  $("#rcForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#rcErr");
    err.hidden = true;
    const productId = pickedProductId($("#rcProduct").value);
    const unitCost = readRupiah($("#rcCost").value);
    let newProduct = null;
    if (newMode) {
      const price = readRupiah($("#npPrice").value);
      newProduct = { name: $("#npName").value.trim(), brand: $("#npBrand").value.trim(), category: $("#npCategory").value.trim(), price };
      if (newProduct.name.length < 2) { err.textContent = "Isi nama produk baru."; err.hidden = false; return; }
      if (!(price > 0)) { err.textContent = "Isi harga jual produk baru di website."; err.hidden = false; return; }
    } else if (!productId || !byId.has(productId)) {
      err.textContent = "Pilih produk dari daftar, atau klik + Tambah produk baru.";
      err.hidden = false;
      updateOffer();
      return;
    }
    if (!Number.isFinite(unitCost) || unitCost < 0) { err.textContent = "Isi harga beli dengan angka, mis. 2.450.000."; err.hidden = false; return; }
    const btn = $("#rcSave");
    btn.disabled = true;
    try {
      const res = await api.finCreateReceipt({
        receivedOn: $("#rcDate").value,
        ...(newProduct ? { productId: null, newProduct } : { productId }),
        quantity: Number($("#rcQty").value), unitCost,
        supplier: $("#rcSupplier").value, note: $("#rcNote").value,
      });
      toast(res.createdProduct ? `Produk baru ditambahkan ke website dan barang masuk tersimpan` : "Barang masuk tersimpan", "success", 4000);
      renderStockIn(root);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false; btn.disabled = false;
    }
  });

  root.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async () => {
    const r = receipts.find(x => x.id === Number(btn.dataset.del));
    const ok = await confirmAction({
      title: "Hapus barang masuk?",
      message: `${r.quantity} unit ${byId.get(r.productId)?.shortName || r.productName} akan dikurangi dari stok, dan modal rata-ratanya dihitung ulang.`,
    });
    if (!ok) return;
    try {
      await api.finDeleteReceipt(r.id);
      toast("Barang masuk dihapus", "success");
      renderStockIn(root);
    } catch (ex) { toast(ex.message, "error", 6000); }
  }));
}
