// Import Shopee: upload the income report from Seller Centre
// (Keuangan → Penghasilan Saya → Sudah Dilepas → Export). One file gives the
// orders, their products and what Shopee actually released, so fees are real,
// not estimated. The report has no quantities or variations: quantities are
// worked out from unit prices (and can be corrected), and AC installation is
// chosen per sale in the review. Each Shopee product is matched to a website
// product once, or added as a new one; the match is remembered.
import { api } from "../components/api.js";
import { money, esc } from "../components/format.js";
import { dataTable } from "../components/dataTable.js";
import { toast } from "../components/toast.js";
import {
  getMonth, monthPicker, onMonthChange, monthLabel, tgl,
  productDatalist, productOptionLabel, pickedProductId, confirmAction, signed,
  installControl, readInstall, installCost, installText, meterPresets, readRupiah, editInstallDialog,
} from "../components/finance-ui.js";

const VIA = { "tersimpan": "Tersimpan", "nama": "Nama sama", "kode model": "Kode model" };
const isACText = s => /\bac\b|air\s+conditioner/i.test(s) && !/air\s*cooler|tower\s*fan|portable/i.test(s);

let state = null;   // parsed income report between upload and import

// The review is saved to the server as a draft, so closing the browser or
// refreshing doesn't lose it. Saves are debounced while the admin edits.
const DRAFT = "shopee-income";
let saveTimer = null;
let saveStatus = () => {};
function persist(now = false) {
  clearTimeout(saveTimer);
  const run = async () => {
    if (!state) return;
    saveStatus("Menyimpan draft…");
    try {
      const r = await api.finSaveDraft(DRAFT, state);
      state.savedAt = r.updatedAt;
      saveStatus(`Draft tersimpan ${jam(r.updatedAt)}`);
    } catch (ex) { saveStatus(`Draft gagal disimpan: ${ex.message}`, true); }
  };
  if (now) return run();
  saveTimer = setTimeout(run, 600);
}
async function discardDraft() {
  clearTimeout(saveTimer);
  state = null;
  try { await api.finDeleteDraft(DRAFT); } catch { /* removed on the next import anyway */ }
}
const jam = s => new Date(s).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });

export async function renderShopeeImport(root) {
  if (state) return renderReview(root);
  root.innerHTML = `<p class="admin-status">Memuat…</p>`;
  const month = getMonth();
  let sales, rates, draft;
  try {
    [sales, rates, draft] = await Promise.all([
      api.finSales(month, "shopee"), api.finInstallRates(), api.finDraft(DRAFT).catch(() => null),
    ]);
  }
  catch (err) { root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`; return; }
  const sum = k => sales.reduce((s, x) => s + (x[k] ?? 0), 0);
  const estimated = sales.filter(s => s.feeSource !== "actual").length;

  const d = draft?.data;
  const draftFresh = d ? d.orders.filter(o => !o.alreadyImported).length : 0;
  root.innerHTML = `
    ${d ? `
    <div class="panel fin-draft">
      <div>
        <h2>Import belum selesai</h2>
        <p>${esc(d.fileName || "Laporan penghasilan")} · ${draftFresh} pesanan baru · disimpan ${esc(jam(draft.updatedAt))}. Pesanan ini <strong>belum masuk</strong> pembukuan sampai Anda menekan Import.</p>
      </div>
      <div class="fin-draft-actions">
        <button class="btn btn-ghost btn-sm" id="drDiscard">Buang</button>
        <button class="btn btn-primary btn-sm" id="drResume">Lanjutkan</button>
      </div>
    </div>` : ""}
    <div class="panel">
      <div class="panel-head"><h2>Import penghasilan Shopee</h2></div>
      <form id="inForm" class="fin-upload">
        <ol class="fin-steps">
          <li>Buka <strong>Seller Centre → Keuangan → Penghasilan Saya → Sudah Dilepas</strong>, pilih periode, lalu <strong>Export</strong>.</li>
          <li>Upload file-nya di sini, periksa produk, jumlah, dan jasa pasang AC, lalu import. Pesanan yang sudah pernah diimpor otomatis dilewati.</li>
        </ol>
        <div class="fin-upload-row">
          <div class="form-field"><label for="inFile">File laporan penghasilan</label><input type="file" id="inFile" accept=".xlsx" required /></div>
          <button class="btn btn-primary" type="submit" id="inRead">Baca file</button>
        </div>
        <p class="form-hint">Potongan Shopee dan dana yang diterima diambil langsung dari laporan, jadi laba di laporan keuangan memakai angka asli.</p>
        <p class="form-error" id="inErr" hidden></p>
      </form>
    </div>

    <div class="fin-toolbar">${monthPicker()}</div>
    <div class="panel fin-shopee-list">
      <div class="panel-head">
        <h2>Pesanan Shopee ${esc(monthLabel(month))}</h2>
        <span class="fin-total">${sales.length} pesanan · <strong>${money(sum("revenue"))}</strong> · potongan ${money(sum("fee"))} · dana diterima ${money(sum("payout"))}</span>
      </div>
      ${estimated ? `<p class="fin-note warn">${estimated} pesanan potongannya masih perkiraan (diimpor dari export pesanan). Upload laporan penghasilan yang memuat pesanan itu untuk memakai angka asli.</p>` : ""}
      ${dataTable({
        columns: [
          { label: "Tgl", render: s => `<span class="fin-date">${tgl(s.soldAt)}</span>` },
          { label: "Pesanan", render: s => `${s.items.map(i => `${esc(i.name)} <span class="muted-dash">×${i.qty}</span>${i.productId ? "" : ` <span class="fin-tag">tanpa stok</span>`}${
                i.installType && i.installType !== "none" ? ` <span class="fin-tag">${esc(installText(i.installType, i.installMeters))}</span>` : ""}${
                isACText(i.name) ? ` <button type="button" class="btn btn-ghost btn-xs" data-inst="${s.id}:${i.id}">Ubah pasang</button>` : ""}`).join("<br>")}
              <span class="muted-sm">${esc(s.ref)} · ${esc(s.customer || "—")}</span>` },
          { label: "Penjualan", num: true, render: s => money(s.revenue) + (s.install ? `<span class="muted-sm">pasang ${money(s.install)}</span>` : "") },
          { label: "Potongan", num: true, render: s => s.feeSource === "actual"
              ? money(s.fee)
              : `<span title="Perkiraan">≈ ${money(s.fee)}</span><span class="muted-sm">perkiraan</span>` },
          { label: "Dana diterima", num: true, render: s => s.payout != null
              ? `${money(s.payout)}${s.payoutOn ? `<span class="muted-sm">${tgl(s.payoutOn)}</span>` : ""}` : `<span class="muted-dash">—</span>` },
          { label: "Laba", num: true, render: s => s.cost && !s.unlinked ? signed(s.profit) : `<span class="muted-dash" title="Ada barang tanpa modal">—</span>` },
          { label: "", render: s => `<button class="btn btn-ghost btn-xs" data-del="${s.id}">Hapus</button>` },
        ],
        rows: sales,
        empty: `Belum ada pesanan Shopee di ${monthLabel(month)}.`,
      })}
    </div>`;

  onMonthChange(root, () => renderShopeeImport(root));
  const $ = s => root.querySelector(s);

  if (d) {
    $("#drResume").addEventListener("click", () => { state = { ...d, savedAt: draft.updatedAt }; renderReview(root); });
    $("#drDiscard").addEventListener("click", async () => {
      const ok = await confirmAction({
        title: "Buang import yang belum selesai?",
        message: `Hasil pemeriksaan ${d.fileName || "laporan"} dihapus. Pesanan yang sudah diimpor sebelumnya tidak terpengaruh.`,
        confirmLabel: "Buang",
      });
      if (!ok) return;
      await discardDraft();
      renderShopeeImport(root);
    });
  }

  $("#inForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#inErr");
    err.hidden = true;
    const file = $("#inFile").files[0];
    if (!file) return;
    const btn = $("#inRead");
    btn.disabled = true; btn.textContent = "Membaca…";
    try {
      state = await api.finParseShopeeIncome(file);
      renderReview(root);
      persist(true);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = "Baca file";
    }
  });

  root.querySelectorAll("[data-inst]").forEach(btn => btn.addEventListener("click", async () => {
    const [saleId, itemId] = btn.dataset.inst.split(":").map(Number);
    const item = sales.find(x => x.id === saleId)?.items.find(i => i.id === itemId);
    if (item && await editInstallDialog({ api, toast, saleId, item, rates })) renderShopeeImport(root);
  }));

  root.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async () => {
    const s = sales.find(x => x.id === Number(btn.dataset.del));
    const ok = await confirmAction({
      title: "Hapus pesanan Shopee?",
      message: `Pesanan ${s.ref} dihapus dari pembukuan dan barangnya dikembalikan ke stok.`,
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
  const { fileName, orders, listings, products, rates, categories = [] } = state;
  const byId = new Map(products.map(p => [p.id, p]));
  const listingBy = new Map(listings.map((l, i) => [l.key, i]));
  const fresh = orders.filter(o => !o.alreadyImported);
  const gross = fresh.reduce((s, o) => s + o.productPrice - o.discount, 0);
  const payout = fresh.reduce((s, o) => s + o.payout, 0);

  // Lines worth a look: AC (installation), and quantities worked out from price.
  const lineRows = [];
  fresh.forEach((o, oi) => o.lines.forEach((ln, li) => {
    const l = listings[listingBy.get(ln.key)];
    const product = byId.get(l.productId);
    const ac = isACText(ln.name) || /^ac$/i.test(product?.category || "") || /^ac$/i.test(l.newProduct?.category || "");
    if (ac || ln.qty > 1 || ln.checkQty) lineRows.push({ o, oi, ln, li, ac });
  }));

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

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Periksa sebelum import</h2>
        <span class="fin-save-status" id="shSaved">${state.savedAt ? `Draft tersimpan ${esc(jam(state.savedAt))}` : ""}</span>
        <button class="btn btn-ghost btn-sm" id="shCancel">Pilih file lain</button>
      </div>
      <div class="fin-facts">
        <div><span>File</span><strong>${esc(fileName)}</strong></div>
        <div><span>Pesanan baru</span><strong>${fresh.length}</strong></div>
        <div><span>Sudah pernah diimpor</span><strong>${orders.length - fresh.length}</strong></div>
        <div><span>Harga produk</span><strong>${money(gross)}</strong></div>
        <div><span>Dana diterima</span><strong>${money(payout)}</strong></div>
        <div><span>Potongan Shopee</span><strong>${money(Math.max(0, gross - payout))}${gross ? ` (${((gross - payout) / gross * 100).toFixed(2).replace(".", ",")}%)` : ""}</strong></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>1. Cocokkan produk</h2>
        <span class="fin-total" id="shMatched"></span>
      </div>
      <p class="panel-note">Produk yang dicocokkan mengurangi stok website dan memakai modalnya untuk menghitung laba. Klik <strong>+ Produk baru</strong> untuk barang yang belum ada di website, atau kosongkan agar penjualannya tercatat tanpa mengubah stok. Pilihan disimpan untuk import berikutnya.</p>
      ${productDatalist("shProducts", products)}
      <datalist id="shCategories">${categories.map(c => `<option value="${esc(c)}"></option>`).join("")}</datalist>
      <div class="table-scroll">
        <table class="data-table fin-match">
          <thead><tr><th>Produk di Shopee</th><th class="num">Pesanan</th><th>Produk website</th></tr></thead>
          <tbody id="shListings">${listings.map((l, i) => `
            <tr>
              <td>${esc(l.name)}</td>
              <td class="num">${l.orders}</td>
              <td data-product="${i}">${productCell(l, i)}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>2. Jumlah &amp; jasa pasang</h2></div>
      <p class="panel-note">Laporan penghasilan tidak memuat jumlah unit dan variasi. Jumlah dihitung dari harga satuan; periksa baris bertanda. Untuk AC, pilih jasa pasang sesuai pesanannya: biayanya dipotong dari harga jual.</p>
      ${meterPresets}
      ${lineRows.length ? `
      <div class="table-scroll">
        <table class="data-table fin-lines">
          <thead><tr><th>Pesanan</th><th>Produk</th><th class="num">Total harga</th><th class="num">Qty</th><th class="num">Harga / unit</th><th>Jasa pasang</th></tr></thead>
          <tbody id="shLines">${lineRows.map((r, k) => `
            <tr data-line="${k}">
              <td class="fin-date">${tgl(r.o.soldAt)}<span class="muted-sm">${esc(r.o.ref)}</span></td>
              <td>${esc(r.ln.name)}${r.ln.checkQty ? `<span class="fin-tag bad">periksa jumlah</span>` : r.ln.qty > 1 ? `<span class="fin-tag">dihitung dari harga</span>` : ""}</td>
              <td class="num">${money(r.ln.amount)}</td>
              <td class="num"><input class="fin-cell-input num fin-qty" data-f="qty" inputmode="numeric" value="${r.ln.qty}" aria-label="Jumlah" /></td>
              <td class="num" data-f="unit">${money(r.ln.amount / r.ln.qty)}</td>
              <td data-install>${r.ac ? `${installControl(`ln${k}`, r.ln.installType, r.ln.installMeters || 3)}
                <span class="muted-sm" data-f="icost"></span>` : `<span class="muted-dash">—</span>`}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>` : `<p class="admin-status">Tidak ada penjualan AC atau jumlah yang perlu diperiksa.</p>`}
      <p class="form-error" id="shErr" hidden></p>
      <div class="fin-actions">
        <button class="btn btn-primary" id="shImport">${fresh.length ? `Import ${fresh.length} pesanan` : "Perbarui dana diterima"}</button>
      </div>
    </div>`;

  const $ = s => root.querySelector(s);
  saveStatus = (msg, bad = false) => {
    const el = root.querySelector("#shSaved");
    if (el) { el.textContent = msg; el.classList.toggle("bad", bad); }
  };
  $("#shCancel").addEventListener("click", async () => {
    const ok = await confirmAction({
      title: "Pilih file lain?",
      message: "Hasil pemeriksaan file ini (produk, jumlah, jasa pasang) dibuang dan belum ada pesanan yang diimpor.",
      confirmLabel: "Buang & pilih file lain",
    });
    if (!ok) return;
    await discardDraft();
    renderShopeeImport(root);
  });

  const updateMatched = () => {
    $("#shMatched").textContent = `${listings.filter(l => l.productId != null || l.newProduct).length} dari ${listings.length} sudah cocok`;
  };
  updateMatched();

  function wireMatchInput(input) {
    if (!input) return;
    input.addEventListener("change", () => {
      const i = Number(input.dataset.i);
      const v = input.value.trim();
      const id = pickedProductId(v);
      const tag = root.querySelector(`[data-via="${i}"]`);
      if (!v) { listings[i].productId = null; input.classList.remove("invalid"); }
      else if (id && byId.has(id)) { listings[i].productId = id; input.classList.remove("invalid"); }
      else { input.classList.add("invalid"); return; }
      listings[i].via = null;
      if (tag) tag.hidden = true;
      updateMatched();
      persist();
    });
  }
  root.querySelectorAll(".fin-match-input[data-i]").forEach(wireMatchInput);

  $("#shListings").addEventListener("click", e => {
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
    persist();
  });
  $("#shListings").addEventListener("input", e => {
    const f = e.target.dataset.np;
    if (!f) return;
    const l = listings[Number(e.target.closest("[data-product]").dataset.product)];
    l.newProduct[f] = f === "price" ? readRupiah(e.target.value) : e.target.value;
    persist();
  });

  // Quantity and installation per line
  const refreshLine = tr => {
    const r = lineRows[Number(tr.dataset.line)];
    const q = Number(tr.querySelector('[data-f="qty"]').value);
    const okQty = Number.isInteger(q) && q >= 1 && q <= 1000;
    tr.querySelector('[data-f="qty"]').classList.toggle("invalid", !okQty);
    if (okQty) r.ln.qty = q;
    tr.querySelector('[data-f="unit"]').textContent = okQty ? money(r.ln.amount / q) : "—";
    const cell = tr.querySelector("[data-install]");
    if (r.ac && cell.querySelector("select")) {
      const inst = readInstall(cell);
      cell.querySelector("input")?.classList.toggle("invalid", !inst.valid);
      if (inst.valid) { r.ln.installType = inst.type; r.ln.installMeters = inst.meters; }
      cell.querySelector('[data-f="icost"]').textContent =
        inst.valid && inst.type !== "none" ? `− ${money(installCost(inst.type, inst.meters, rates))} per unit` : "";
    }
    persist();
  };
  $("#shLines")?.addEventListener("change", e => refreshLine(e.target.closest("tr")));
  $("#shLines")?.addEventListener("input", e => refreshLine(e.target.closest("tr")));

  $("#shImport").addEventListener("click", async () => {
    const err = $("#shErr");
    const fail = msg => { err.textContent = msg; err.hidden = false; };
    err.hidden = true;
    if (root.querySelector(".fin-match-input.invalid")) return fail("Ada produk yang tidak ada di daftar. Pilih dari daftar, kosongkan, atau klik + Produk baru.");
    if (root.querySelector("#shLines input.invalid")) return fail("Periksa jumlah dan panjang pipa yang ditandai merah.");
    const badNew = listings.find(l => l.newProduct && (String(l.newProduct.name || "").trim().length < 2 || !Number.isFinite(l.newProduct.price) || l.newProduct.price < 0));
    if (badNew) return fail(`Lengkapi nama dan harga produk baru untuk "${badNew.name.slice(0, 50)}".`);

    const btn = $("#shImport");
    btn.disabled = true; btn.textContent = "Mengimpor…";
    clearTimeout(saveTimer);
    try {
      const result = await api.finCommitShopeeIncome({
        orders: fresh.map(o => ({
          ref: o.ref, soldAt: o.soldAt, buyer: o.buyer, discount: o.discount,
          lines: o.lines.map(ln => ({
            name: ln.name, variation: "", qty: ln.qty, unitPrice: ln.amount / ln.qty,
            installType: ln.installType || "none", installMeters: ln.installMeters ?? null,
          })),
        })),
        links: listings.map(l => ({
          name: l.name, variation: "", productId: l.newProduct ? null : l.productId,
          newProduct: l.newProduct || null, installType: "none", installMeters: null,
        })),
        payouts: orders.map(o => ({ ref: o.ref, releasedOn: o.releasedOn, productPrice: o.productPrice, payout: o.payout, fees: o.fees })),
      });
      state = null;   // the server removed the draft with the import
      renderResult(root, result);
    } catch (ex) {
      fail(ex.message);
      persist(true);
      btn.disabled = false; btn.textContent = fresh.length ? `Import ${fresh.length} pesanan` : "Perbarui dana diterima";
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
        <div><span>Harga produk</span><strong>${money(r.revenue)}</strong></div>
        <div><span>Potongan Shopee</span><strong>${money(r.fee)}</strong></div>
        <div><span>Pasang &amp; material</span><strong>${money(r.install)}</strong></div>
        <div><span>Produk baru di website</span><strong>${r.createdProducts?.length || 0}</strong></div>
      </div>
      ${r.createdProducts?.length ? `<div class="fin-note"><strong>Produk baru ditambahkan ke website (stok 0):</strong>
        <ul>${r.createdProducts.map(p => `<li>${esc(p.name)}</li>`).join("")}</ul>
        <p>Lengkapi foto dan deskripsinya di menu Products, lalu catat stoknya lewat Barang masuk.</p></div>` : ""}
      ${r.warnings?.length ? `<div class="fin-note warn"><strong>Perlu dicek:</strong><ul>${r.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
      <div class="fin-actions">
        <button class="btn btn-primary" id="shAgain">Lihat pesanan Shopee</button>
      </div>
    </div>`;
  root.querySelector("#shAgain").addEventListener("click", () => renderShopeeImport(root));
}
