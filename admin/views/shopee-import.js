// Import Shopee: upload the order export from Shopee Seller Centre
// (Pesanan Saya → Export). Each Shopee listing is matched to a website product
// once; the match is remembered for the next import. Matched lines take stock
// off the website product and carry its cost into the report. Listings sold
// with installation ("AC + PASANG +PIPA 5M") get their install package read
// from the variation; its cost comes off the selling price.
import { api } from "../components/api.js";
import { money, esc } from "../components/format.js";
import { dataTable } from "../components/dataTable.js";
import { toast } from "../components/toast.js";
import {
  getMonth, monthPicker, onMonthChange, monthLabel, tgl,
  productDatalist, productOptionLabel, pickedProductId, confirmAction, signed,
  installControl, readInstall, installCost, installText, meterPresets, readRupiah,
} from "../components/finance-ui.js";

const FEE_KEY = "sinar_shopee_fee_percent";
const readFee = () => { try { return localStorage.getItem(FEE_KEY) ?? "8"; } catch { return "8"; } };
const saveFee = v => { try { localStorage.setItem(FEE_KEY, String(v)); } catch { /* optional */ } };

const VIA = { "tersimpan": "Tersimpan", "nama": "Nama sama", "kode model": "Kode model" };

let state = null;   // { fileName, orders, skipped, listings, products } between upload and import

export async function renderShopeeImport(root) {
  if (state) return renderReview(root);
  root.innerHTML = `<p class="admin-status">Memuat…</p>`;
  const month = getMonth();
  let sales;
  try { sales = await api.finSales(month, "shopee"); }
  catch (err) { root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`; return; }
  const sum = k => sales.reduce((s, x) => s + x[k], 0);

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Import pesanan Shopee</h2></div>
      <form id="shForm" class="fin-upload">
        <ol class="fin-steps">
          <li>Buka <strong>Shopee Seller Centre → Pesanan Saya</strong>, pilih periode, lalu klik <strong>Export</strong>.</li>
          <li>Upload file <code>.xlsx</code> hasil export di sini. Pesanan yang sudah pernah diimpor otomatis dilewati.</li>
        </ol>
        <div class="fin-upload-row">
          <div class="form-field"><label for="shFile">File export Shopee</label><input type="file" id="shFile" accept=".xlsx,.xls,.csv" required /></div>
          <div class="form-field fin-fee"><label for="shFee">Perkiraan potongan Shopee (%)</label>
            <input type="number" id="shFee" min="0" max="50" step="0.1" value="${esc(readFee())}" required /></div>
          <button class="btn btn-primary" type="submit" id="shRead">Baca file</button>
        </div>
        <p class="form-hint">File export pesanan tidak memuat biaya admin &amp; layanan Shopee, jadi potongannya diperkirakan dari persentase ini. Cocokkan dengan menu Penghasilan Saya di Seller Centre.</p>
        <p class="form-error" id="shErr" hidden></p>
      </form>
    </div>

    <div class="fin-toolbar">${monthPicker()}</div>
    <div class="panel">
      <div class="panel-head">
        <h2>Pesanan Shopee ${esc(monthLabel(month))}</h2>
        <span class="fin-total">${sales.length} pesanan · <strong>${money(sum("revenue"))}</strong> · potongan ${money(sum("fee"))}</span>
      </div>
      ${dataTable({
        columns: [
          { label: "Tgl", render: s => `<span class="fin-date">${tgl(s.soldAt)}</span>` },
          { label: "Pesanan", render: s => `${s.items.map(i => `${esc(i.name)} <span class="muted-dash">×${i.qty}</span>${i.productId ? "" : ` <span class="fin-tag">tanpa stok</span>`}${
                i.installType && i.installType !== "none" ? ` <span class="fin-tag">${esc(installText(i.installType, i.installMeters))}</span>` : ""}`).join("<br>")}
              <span class="muted-sm">${esc(s.ref)} · ${esc(s.customer || "—")}</span>` },
          { label: "Penjualan", num: true, render: s => money(s.revenue) + (s.install ? `<span class="muted-sm">pasang ${money(s.install)}</span>` : "") },
          { label: "Potongan", num: true, render: s => money(s.fee) },
          { label: "Laba", num: true, render: s => s.cost && !s.unlinked ? signed(s.profit) : `<span class="muted-dash" title="Ada barang tanpa modal">—</span>` },
          { label: "", render: s => `<button class="btn btn-ghost btn-xs" data-del="${s.id}">Hapus</button>` },
        ],
        rows: sales,
        empty: `Belum ada pesanan Shopee di ${monthLabel(month)}.`,
      })}
    </div>`;

  onMonthChange(root, () => renderShopeeImport(root));
  const $ = s => root.querySelector(s);

  $("#shForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#shErr");
    err.hidden = true;
    const file = $("#shFile").files[0];
    const fee = Number($("#shFee").value);
    if (!file) return;
    if (!(fee >= 0 && fee <= 50)) { err.textContent = "Persentase potongan harus 0–50."; err.hidden = false; return; }
    saveFee(fee);
    const btn = $("#shRead");
    btn.disabled = true;
    btn.textContent = "Membaca…";
    try {
      const parsed = await api.finParseShopee(file);
      state = { ...parsed, feePercent: fee };
      renderReview(root);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = "Baca file";
    }
  });

  root.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async () => {
    const s = sales.find(x => x.id === Number(btn.dataset.del));
    const ok = await confirmAction({
      title: "Hapus pesanan Shopee?",
      message: `Pesanan ${s.ref} dihapus dari pembukuan dan barangnya dikembalikan ke stok. Pakai ini untuk pesanan yang ternyata batal atau dikembalikan.`,
    });
    if (!ok) return;
    try {
      await api.finDeleteSale(s.id);
      toast("Pesanan dihapus, stok dikembalikan", "success");
      renderShopeeImport(root);
    } catch (ex) { toast(ex.message, "error", 6000); }
  }));
}

function renderReview(root) {
  const { fileName, orders, skipped, listings, products, feePercent, rates, categories = [] } = state;
  const byId = new Map(products.map(p => [p.id, p]));
  const fresh = orders.filter(o => !o.alreadyImported);
  const revenue = fresh.reduce((s, o) => s + o.subtotal - o.discount, 0);
  const matched = listings.filter(l => l.productId != null || l.newProduct).length;
  const listingIndex = new Map(listings.map((l, i) => [l.key, i]));

  // Product cell: pick an existing website product, or "+ Produk baru" to add one.
  const productCell = (l, i) => l.newProduct ? `
      <div class="fin-newprod">
        <div class="fin-newprod-head"><span class="fin-tag ok">Produk baru</span>
          <button type="button" class="btn btn-ghost btn-xs" data-cancel-new="${i}">Batal</button></div>
        <input class="fin-match-input" data-np="name" value="${esc(l.newProduct.name)}" aria-label="Nama produk baru" />
        <div class="fin-newprod-row">
          <input class="fin-match-input" data-np="category" list="shCategories" value="${esc(l.newProduct.category)}" aria-label="Kategori" placeholder="Kategori" />
          <input class="fin-match-input" data-np="brand" value="${esc(l.newProduct.brand)}" aria-label="Merek" placeholder="Merek" />
          <input class="fin-match-input num" data-np="price" inputmode="numeric" value="${Number(l.newProduct.price || 0).toLocaleString("id-ID")}" aria-label="Harga jual" />
        </div>
      </div>` : `
      <input class="fin-match-input" data-i="${i}" list="shProducts" aria-label="Produk website untuk ${esc(l.name)}"
        value="${l.productId != null && byId.has(l.productId) ? esc(productOptionLabel(byId.get(l.productId))) : ""}"
        placeholder="Tanpa produk (stok tidak berubah)" />
      <div class="fin-match-foot">
        ${l.via ? `<span class="fin-tag ok" data-via="${i}">${esc(VIA[l.via] || l.via)}</span>` : `<span class="fin-tag" data-via="${i}" hidden></span>`}
        ${l.productId == null ? `<button type="button" class="btn btn-ghost btn-xs" data-new="${i}">+ Produk baru</button>` : ""}
      </div>`;
  // Installation applies to AC: a matched AC product, an "AC" listing, or a variation that names a package.
  const canInstall = l => (l.installType && l.installType !== "none")
    || /^ac$/i.test(byId.get(l.productId)?.category || "") || /\bac\b/i.test(l.name);
  const installTotal = () => fresh.reduce((s, o) => s + o.lines.reduce((t, ln) => {
    const l = listings[listingIndex.get(ln.key)];
    return t + ln.qty * Math.min(installCost(l.installType, l.installMeters, rates), ln.unitPrice);
  }, 0), 0);

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Periksa sebelum import</h2>
        <button class="btn btn-ghost btn-sm" id="shCancel">Pilih file lain</button>
      </div>
      <div class="fin-facts">
        <div><span>File</span><strong>${esc(fileName)}</strong></div>
        <div><span>Pesanan baru</span><strong>${fresh.length}</strong></div>
        <div><span>Sudah pernah diimpor</span><strong>${orders.length - fresh.length}</strong></div>
        <div><span>Dilewati</span><strong>${skipped.length}</strong></div>
        <div><span>Total harga jual</span><strong>${money(revenue)}</strong></div>
        <div><span>Pasang &amp; material</span><strong id="shInstallTotal">${money(installTotal())}</strong></div>
        <div><span>Potongan ${esc(String(feePercent))}%</span><strong>${money(revenue * feePercent / 100)}</strong></div>
      </div>
      ${skipped.length ? `<details class="fin-details"><summary>${skipped.length} pesanan dilewati</summary>
        <ul>${skipped.map(s => `<li>${esc(s.ref)}: ${esc(s.reason)}</li>`).join("")}</ul></details>` : ""}
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>Cocokkan produk Shopee ke produk website</h2>
        <span class="fin-total" id="shMatched">${matched} dari ${listings.length} sudah cocok</span>
      </div>
      <p class="panel-note">Produk yang dicocokkan akan mengurangi stok website dan memakai modalnya untuk menghitung laba. Kosongkan untuk barang yang tidak ada di website (mis. kipas angin): penjualannya tetap tercatat, tapi stok tidak berubah. Untuk AC, kolom <strong>Jasa pasang</strong> dibaca dari variasi Shopee (mis. “AC + PASANG +PIPA 5M”), dan biayanya dipotong dari harga jual. Semua pilihan disimpan untuk import berikutnya.</p>
      ${productDatalist("shProducts", products)}
      ${meterPresets}
      <datalist id="shCategories">${categories.map(c => `<option value="${esc(c)}"></option>`).join("")}</datalist>
      <div class="table-scroll">
        <table class="data-table fin-match">
          <thead><tr><th>Produk di Shopee</th><th class="num">Terjual</th><th>Produk website</th><th>Jasa pasang</th></tr></thead>
          <tbody>${listings.map((l, i) => `
            <tr>
              <td>${esc(l.name)}${l.variation ? `<span class="muted-sm">Variasi: ${esc(l.variation)}</span>` : ""}</td>
              <td class="num">${l.qty}</td>
              <td data-product="${i}">${productCell(l, i)}</td>
              ${canInstall(l) ? `<td data-install="${i}">
                ${installControl(`shInst${i}`, l.installType || "none", l.installMeters || 3)}
                <span class="muted-sm" data-install-cost="${i}">${l.installType && l.installType !== "none" ? `− ${money(installCost(l.installType, l.installMeters, rates))} per unit` : ""}</span>
              </td>` : `<td><span class="muted-dash">—</span></td>`}
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <p class="form-error" id="shErr" hidden></p>
      <div class="fin-actions">
        <button class="btn btn-primary" id="shImport" ${fresh.length ? "" : "disabled"}>
          ${fresh.length ? `Import ${fresh.length} pesanan` : "Semua pesanan sudah pernah diimpor"}
        </button>
      </div>
    </div>`;

  const $ = s => root.querySelector(s);
  $("#shCancel").addEventListener("click", () => { state = null; renderShopeeImport(root); });

  // "+ Produk baru": edit the proposed product inline; it's created on import.
  root.querySelector("tbody").addEventListener("click", e => {
    const btn = e.target.closest("[data-new], [data-cancel-new]");
    if (!btn) return;
    const i = Number(btn.dataset.new ?? btn.dataset.cancelNew);
    const l = listings[i];
    if (btn.dataset.new !== undefined) { l.newProduct = { ...l.proposal }; l.productId = null; l.via = null; }
    else delete l.newProduct;
    const cell = root.querySelector(`[data-product="${i}"]`);
    cell.innerHTML = productCell(l, i);
    wireMatchInput(cell.querySelector(".fin-match-input[data-i]"));
    cell.querySelector("[data-np='name']")?.focus();
    updateMatched();
  });
  root.querySelector("tbody").addEventListener("input", e => {
    const f = e.target.dataset.np;
    if (!f) return;
    const l = listings[Number(e.target.closest("[data-product]").dataset.product)];
    l.newProduct[f] = f === "price" ? readRupiah(e.target.value) : e.target.value;
  });
  const updateMatched = () => {
    $("#shMatched").textContent = `${listings.filter(l => l.productId != null || l.newProduct).length} dari ${listings.length} sudah cocok`;
  };

  function wireMatchInput(input) { if (!input) return; input.addEventListener("change", () => {
    const i = Number(input.dataset.i);
    const v = input.value.trim();
    const id = pickedProductId(v);
    const tag = root.querySelector(`[data-via="${i}"]`);
    if (!v) {
      listings[i].productId = null;
      input.classList.remove("invalid");
    } else if (id && byId.has(id)) {
      listings[i].productId = id;
      input.classList.remove("invalid");
    } else {
      input.classList.add("invalid");
      return;
    }
    listings[i].via = null;
    if (tag) tag.hidden = true;
    updateMatched();
  }); }
  root.querySelectorAll(".fin-match-input[data-i]").forEach(wireMatchInput);

  root.querySelectorAll("[data-install]").forEach(cell => {
    const update = () => {
      const i = Number(cell.dataset.install);
      const inst = readInstall(cell);
      cell.querySelector("input")?.classList.toggle("invalid", !inst.valid);
      if (!inst.valid) return;
      listings[i].installType = inst.type;
      listings[i].installMeters = inst.meters;
      cell.querySelector(`[data-install-cost="${i}"]`).textContent =
        inst.type !== "none" ? `− ${money(installCost(inst.type, inst.meters, rates))} per unit` : "";
      $("#shInstallTotal").textContent = money(installTotal());
    };
    cell.addEventListener("change", update);
    cell.addEventListener("input", update);
  });

  $("#shImport").addEventListener("click", async () => {
    const err = $("#shErr");
    err.hidden = true;
    if (root.querySelector("[data-install] input.invalid")) {
      err.textContent = "Isi panjang pipa 1–50 meter.";
      err.hidden = false;
      return;
    }
    const badNew = listings.find(l => l.newProduct && (String(l.newProduct.name || "").trim().length < 2 || !Number.isFinite(l.newProduct.price) || l.newProduct.price < 0));
    if (badNew) {
      err.textContent = `Lengkapi nama dan harga produk baru untuk "${badNew.name.slice(0, 50)}".`;
      err.hidden = false;
      return;
    }
    if (root.querySelector(".fin-match-input.invalid")) {
      err.textContent = "Ada produk yang tidak ada di daftar. Pilih dari daftar, kosongkan, atau klik + Produk baru.";
      err.hidden = false;
      return;
    }
    const btn = $("#shImport");
    btn.disabled = true;
    btn.textContent = "Mengimpor…";
    try {
      const result = await api.finCommitShopee({
        orders: fresh.map(({ ref, soldAt, buyer, discount, lines }) => ({
          ref, soldAt, buyer, discount,
          lines: lines.map(({ name, variation, qty, unitPrice }) => ({ name, variation, qty, unitPrice })),
        })),
        links: listings.map(l => ({
          name: l.name, variation: l.variation, productId: l.newProduct ? null : l.productId,
          newProduct: l.newProduct || null,
          installType: l.installType || "none", installMeters: l.installMeters ?? null,
        })),
        feePercent,
      });
      state = null;
      renderResult(root, result);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = `Import ${fresh.length} pesanan`;
    }
  });
}

function renderResult(root, r) {
  root.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Import selesai</h2></div>
      <div class="fin-facts">
        <div><span>Pesanan diimpor</span><strong>${r.imported}</strong></div>
        <div><span>Sudah ada (dilewati)</span><strong>${r.duplicates}</strong></div>
        <div><span>Penjualan</span><strong>${money(r.revenue)}</strong></div>
        <div><span>Potongan Shopee</span><strong>${money(r.fee)}</strong></div>
        <div><span>Pasang &amp; material</span><strong>${money(r.install)}</strong></div>
        <div><span>Barang tanpa produk website</span><strong>${r.unlinkedLines}</strong></div>
        <div><span>Produk baru di website</span><strong>${r.createdProducts?.length || 0}</strong></div>
      </div>
      ${r.createdProducts?.length ? `<div class="fin-note"><strong>Produk baru ditambahkan ke website (stok 0):</strong>
        <ul>${r.createdProducts.map(p => `<li>${esc(p.name)}</li>`).join("")}</ul>
        <p>Lengkapi foto dan deskripsinya di menu Products, lalu catat stoknya lewat Barang masuk.</p></div>` : ""}
      ${r.warnings.length ? `<div class="fin-note warn"><strong>Perlu dicek:</strong><ul>${r.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
      <div class="fin-actions">
        <button class="btn btn-primary" id="shAgain">Lihat pesanan Shopee</button>
      </div>
    </div>`;
  root.querySelector("#shAgain").addEventListener("click", () => renderShopeeImport(root));
}
