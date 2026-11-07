// Import Shopee: upload the order export from Shopee Seller Centre
// (Pesanan Saya → Export). Each Shopee listing is matched to a website product
// once; the match is remembered for the next import. Matched lines take stock
// off the website product and carry its cost into the report.
import { api } from "../components/api.js";
import { money, esc } from "../components/format.js";
import { dataTable } from "../components/dataTable.js";
import { toast } from "../components/toast.js";
import {
  getMonth, monthPicker, onMonthChange, monthLabel, tgl,
  productDatalist, productOptionLabel, pickedProductId, confirmAction, signed,
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
          { label: "Pesanan", render: s => `${s.items.map(i => `${esc(i.name)} <span class="muted-dash">×${i.qty}</span>${i.productId ? "" : ` <span class="fin-tag">tanpa stok</span>`}`).join("<br>")}
              <span class="muted-sm">${esc(s.ref)} · ${esc(s.customer || "—")}</span>` },
          { label: "Penjualan", num: true, render: s => money(s.revenue) },
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
  const { fileName, orders, skipped, listings, products, feePercent } = state;
  const byId = new Map(products.map(p => [p.id, p]));
  const fresh = orders.filter(o => !o.alreadyImported);
  const revenue = fresh.reduce((s, o) => s + o.subtotal - o.discount, 0);
  const matched = listings.filter(l => l.productId != null).length;

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
        <div><span>Total penjualan</span><strong>${money(revenue)}</strong></div>
        <div><span>Potongan ${esc(String(feePercent))}%</span><strong>${money(revenue * feePercent / 100)}</strong></div>
      </div>
      ${skipped.length ? `<details class="fin-details"><summary>${skipped.length} pesanan dilewati</summary>
        <ul>${skipped.map(s => `<li>${esc(s.ref)}: ${esc(s.reason)}</li>`).join("")}</ul></details>` : ""}
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>Cocokkan produk Shopee ke produk website</h2>
        <span class="fin-total">${matched} dari ${listings.length} sudah cocok</span>
      </div>
      <p class="panel-note">Produk yang dicocokkan akan mengurangi stok website dan memakai modalnya untuk menghitung laba. Kosongkan untuk barang yang tidak ada di website (mis. kipas angin atau jasa pasang): penjualannya tetap tercatat, tapi stok tidak berubah. Pilihan Anda disimpan untuk import berikutnya.</p>
      ${productDatalist("shProducts", products)}
      <div class="table-scroll">
        <table class="data-table fin-match">
          <thead><tr><th>Produk di Shopee</th><th class="num">Terjual</th><th>Produk website</th></tr></thead>
          <tbody>${listings.map((l, i) => `
            <tr>
              <td>${esc(l.name)}${l.variation ? `<span class="muted-sm">Variasi: ${esc(l.variation)}</span>` : ""}</td>
              <td class="num">${l.qty}</td>
              <td>
                <input class="fin-match-input" data-i="${i}" list="shProducts" aria-label="Produk website untuk ${esc(l.name)}"
                  value="${l.productId != null && byId.has(l.productId) ? esc(productOptionLabel(byId.get(l.productId))) : ""}"
                  placeholder="Tanpa produk (stok tidak berubah)" />
                ${l.via ? `<span class="fin-tag ok" data-via="${i}">${esc(VIA[l.via] || l.via)}</span>` : `<span class="fin-tag" data-via="${i}" hidden></span>`}
              </td>
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

  root.querySelectorAll(".fin-match-input").forEach(input => input.addEventListener("change", () => {
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
    tag.hidden = true;
  }));

  $("#shImport").addEventListener("click", async () => {
    const err = $("#shErr");
    err.hidden = true;
    if (root.querySelector(".fin-match-input.invalid")) {
      err.textContent = "Ada produk yang tidak ada di daftar. Pilih dari daftar atau kosongkan.";
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
        links: listings.map(l => ({ name: l.name, variation: l.variation, productId: l.productId })),
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
        <div><span>Barang tanpa produk website</span><strong>${r.unlinkedLines}</strong></div>
      </div>
      ${r.warnings.length ? `<div class="fin-note warn"><strong>Perlu dicek:</strong><ul>${r.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul></div>` : ""}
      <div class="fin-actions">
        <button class="btn btn-primary" id="shAgain">Lihat pesanan Shopee</button>
      </div>
    </div>`;
  root.querySelector("#shAgain").addEventListener("click", () => renderShopeeImport(root));
}
