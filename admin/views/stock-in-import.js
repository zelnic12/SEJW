// Barang masuk from Excel: download a template listing every product, fill in
// Jumlah and Harga beli for what arrived, upload, check, save all at once.
import { api } from "../components/api.js";
import { money, esc } from "../components/format.js";
import { toast } from "../components/toast.js";
import { today, defaultDate, tgl, productDatalist, productOptionLabel, pickedProductId, readRupiah } from "../components/finance-ui.js";

// "250rb" / "3,1 jt" as well as "2.650.000"
const readCost = v => {
  const m = String(v || "").trim().toLowerCase().replace(/^rp\.?\s*/, "").match(/^(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)$/);
  return m ? Math.round(Number(m[1].replace(",", ".")) * (/^(jt|juta)$/.test(m[2]) ? 1e6 : 1e3)) : readRupiah(v);
};

const VIA = { id: "ID produk", nama: "Nama sama", "kode model": "Kode model" };

/** Start the import flow inside root; onExit() returns to the Barang masuk page. */
export async function renderStockInImport(root, onExit) {
  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Import barang masuk dari Excel</h2>
        <button class="btn btn-ghost btn-sm" id="riBack">Kembali</button>
      </div>
      <form id="riForm" class="fin-upload">
        <ol class="fin-steps">
          <li><button type="button" class="btn btn-ghost btn-sm" id="riTemplate">⬇ Unduh template</button> berisi semua produk beserta stoknya.</li>
          <li>Di Excel, isi <strong>Jumlah</strong> dan <strong>Harga beli / unit</strong> untuk barang yang datang. Baris yang jumlahnya kosong dilewati.</li>
          <li>Upload file-nya di sini, periksa hasilnya, lalu simpan.</li>
        </ol>
        <div class="fin-upload-row">
          <div class="form-field"><label for="riFile">File Excel</label><input type="file" id="riFile" accept=".xlsx,.xls,.csv" required /></div>
          <button class="btn btn-primary" type="submit" id="riRead">Baca file</button>
        </div>
        <p class="form-hint">File dari supplier juga bisa, asalkan punya kolom Produk (atau tipe), Jumlah, dan Harga beli.</p>
        <p class="form-error" id="riErr" hidden></p>
      </form>
    </div>`;

  const $ = s => root.querySelector(s);
  $("#riBack").addEventListener("click", onExit);

  $("#riTemplate").addEventListener("click", async () => {
    try {
      const blob = await api.finReceiptTemplate();
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: "template-barang-masuk.xlsx" });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { toast(err.message, "error"); }
  });

  $("#riForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#riErr");
    err.hidden = true;
    const file = $("#riFile").files[0];
    if (!file) return;
    const btn = $("#riRead");
    btn.disabled = true; btn.textContent = "Membaca…";
    try {
      const [parsed, products] = await Promise.all([api.finParseReceipts(file), api.finProducts()]);
      renderPreview(root, parsed, products, onExit);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = "Baca file";
    }
  });
}

function renderPreview(root, parsed, products, onExit) {
  const byId = new Map(products.map(p => [p.id, p]));
  const rows = parsed.rows;
  // An unreadable date isn't blocking: the row falls back to the date picked below.
  for (const r of rows) r.dateProblem = r.problems.find(p => p.startsWith("Tanggal")) || "";

  const rowProblems = r => {
    const out = r.problems.filter(p => p !== "Produk tidak ditemukan");
    if (!byId.has(r.productId)) out.unshift("Pilih produk");
    return out;
  };

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Periksa sebelum disimpan</h2>
        <button class="btn btn-ghost btn-sm" id="riBack">Pilih file lain</button>
      </div>
      <div class="fin-facts">
        <div><span>File</span><strong>${esc(parsed.fileName)}</strong></div>
        <div><span>Baris barang masuk</span><strong>${rows.length}</strong></div>
        <div><span>Total unit</span><strong id="riUnits"></strong></div>
        <div><span>Total pembelian</span><strong id="riTotal"></strong></div>
        <div><span>Perlu diperbaiki</span><strong id="riBad"></strong></div>
      </div>
      <div class="fin-upload-row fin-ri-date">
        <div class="form-field"><label for="riDate">Tanggal untuk baris tanpa tanggal</label>
          <input type="date" id="riDate" max="${today()}" value="${defaultDate()}" /></div>
        <p class="form-hint">${parsed.skipped} baris tanpa jumlah dilewati.</p>
      </div>
    </div>

    <div class="panel">
      ${productDatalist("riProducts", products)}
      ${rows.length ? `
      <div class="table-scroll">
        <table class="data-table fin-ri">
          <thead><tr><th>Baris</th><th>Produk</th><th>Tanggal</th><th class="num">Jumlah</th><th class="num">Harga beli</th><th class="num">Total</th><th>Supplier</th><th>Status</th></tr></thead>
          <tbody>${rows.map((r, i) => `
            <tr data-i="${i}">
              <td class="fin-date">${r.row}</td>
              <td>
                <input class="fin-match-input" data-f="product" list="riProducts" value="${byId.has(r.productId) ? esc(productOptionLabel(byId.get(r.productId))) : ""}"
                  placeholder="Pilih produk" aria-label="Produk baris ${r.row}" />
                <span class="muted-sm">${r.via ? `${esc(VIA[r.via] || r.via)} · ` : ""}di file: ${esc(r.productText || "—")}</span>
              </td>
              <td class="fin-date">${r.receivedOn ? tgl(r.receivedOn) : `<span class="muted-dash">${r.dateProblem ? `${esc(r.dateProblem)}, ` : ""}pakai tanggal di atas</span>`}</td>
              <td class="num"><input class="fin-cell-input num" data-f="qty" inputmode="numeric" value="${r.quantity ?? ""}" aria-label="Jumlah baris ${r.row}" /></td>
              <td class="num"><input class="fin-cell-input num" data-f="cost" inputmode="numeric" value="${r.unitCost != null ? r.unitCost.toLocaleString("id-ID") : ""}" aria-label="Harga beli baris ${r.row}" /></td>
              <td class="num" data-f="total"></td>
              <td>${esc(r.supplier || "—")}</td>
              <td data-f="status"></td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>` : `<p class="admin-status">Tidak ada baris dengan jumlah di file ini. Isi kolom Jumlah untuk barang yang datang.</p>`}
      <p class="form-error" id="riErr" hidden></p>
      <div class="fin-actions">
        <button class="btn btn-primary" id="riSave" ${rows.length ? "" : "disabled"}>Simpan ${rows.length} barang masuk</button>
      </div>
    </div>`;

  const $ = s => root.querySelector(s);
  $("#riBack").addEventListener("click", () => renderStockInImport(root, onExit));

  const refresh = () => {
    let units = 0, total = 0, bad = 0;
    root.querySelectorAll("tr[data-i]").forEach(tr => {
      const r = rows[Number(tr.dataset.i)];
      const v = tr.querySelector('[data-f="product"]').value.trim();
      r.productId = v ? pickedProductId(v) : null;
      const q = Number(tr.querySelector('[data-f="qty"]').value.replace(/\./g, ""));
      const c = readCost(tr.querySelector('[data-f="cost"]').value);
      r.quantity = Number.isInteger(q) && q >= 1 ? q : null;
      r.unitCost = Number.isFinite(c) && c >= 0 ? c : null;
      r.problems = [
        ...(r.quantity == null ? ["Jumlah harus bilangan bulat ≥ 1"] : []),
        ...(r.unitCost == null ? ["Harga beli kosong atau tidak terbaca"] : []),
      ];
      const probs = rowProblems(r);
      tr.querySelector('[data-f="product"]').classList.toggle("invalid", !byId.has(r.productId));
      tr.querySelector('[data-f="total"]').textContent = r.quantity && r.unitCost != null ? money(r.quantity * r.unitCost) : "—";
      tr.querySelector('[data-f="status"]').innerHTML = probs.length
        ? `<span class="fin-tag bad">${esc(probs.join("; "))}</span>`
        : `<span class="fin-tag ok">Siap</span>`;
      if (probs.length) bad += 1;
      else { units += r.quantity; total += r.quantity * r.unitCost; }
    });
    $("#riUnits").textContent = units.toLocaleString("id-ID");
    $("#riTotal").textContent = money(total);
    $("#riBad").textContent = bad;
    return bad;
  };
  root.querySelector("tbody")?.addEventListener("change", refresh);
  root.querySelector("tbody")?.addEventListener("input", e => { if (e.target.dataset.f !== "product") refresh(); });
  refresh();

  $("#riSave").addEventListener("click", async () => {
    const err = $("#riErr");
    err.hidden = true;
    if (refresh()) {
      err.textContent = "Masih ada baris yang perlu diperbaiki (lihat kolom Status).";
      err.hidden = false;
      return;
    }
    const fallback = $("#riDate").value;
    if (!fallback && rows.some(r => !r.receivedOn)) { err.textContent = "Isi tanggal untuk baris tanpa tanggal."; err.hidden = false; return; }
    const btn = $("#riSave");
    btn.disabled = true; btn.textContent = "Menyimpan…";
    try {
      const result = await api.finBulkReceipts(rows.map(r => ({
        row: r.row, receivedOn: r.receivedOn || fallback, productId: r.productId,
        quantity: r.quantity, unitCost: r.unitCost, supplier: r.supplier, note: r.note,
      })));
      toast(`${result.count} barang masuk tersimpan (${result.units} unit, ${money(result.total)})`, "success", 5000);
      onExit();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = `Simpan ${rows.length} barang masuk`;
    }
  });
}
