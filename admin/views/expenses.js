// Pengeluaran: running costs (rent, salaries, utilities, …) that come off the
// gross profit in the finance report.
import { api } from "../components/api.js";
import { money, esc } from "../components/format.js";
import { dataTable } from "../components/dataTable.js";
import { toast } from "../components/toast.js";
import {
  getMonth, monthPicker, onMonthChange, monthLabel, defaultDate, today, tgl, readRupiah, confirmAction,
} from "../components/finance-ui.js";

export async function renderExpenses(root) {
  root.innerHTML = `<p class="admin-status">Memuat pengeluaran…</p>`;
  const month = getMonth();
  let categories, expenses;
  try {
    [categories, expenses] = await Promise.all([api.finExpenseCategories(), api.finExpenses(month)]);
  } catch (err) {
    root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`;
    return;
  }
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const perCat = new Map();
  for (const e of expenses) perCat.set(e.category, (perCat.get(e.category) || 0) + e.amount);

  root.innerHTML = `
    <div class="fin-toolbar">${monthPicker()}</div>
    <div class="fin-split">
      <div class="panel">
        <div class="panel-head"><h2>Catat pengeluaran</h2></div>
        <form id="exForm" class="fin-form" autocomplete="off">
          <div class="form-grid">
            <div class="form-field"><label for="exDate">Tanggal</label><input type="date" id="exDate" max="${today()}" value="${defaultDate()}" required /></div>
            <div class="form-field"><label for="exCat">Jenis</label>
              <select id="exCat" required>${categories.map(c => `<option>${esc(c)}</option>`).join("")}</select></div>
          </div>
          <div class="form-field"><label for="exAmount">Jumlah (Rp)</label><input id="exAmount" inputmode="numeric" placeholder="mis. 1.250.000" required /></div>
          <div class="form-field"><label for="exNote">Keterangan</label><input id="exNote" placeholder="mis. Token listrik November" /></div>
          <p class="form-error" id="exErr" hidden></p>
          <button class="btn btn-primary" type="submit" id="exSave">Simpan pengeluaran</button>
        </form>
        ${perCat.size ? `
          <h3 class="fin-subhead">Per jenis, ${esc(monthLabel(month))}</h3>
          <table class="fin-mini">${[...perCat].sort((a, b) => b[1] - a[1]).map(([c, v]) =>
            `<tr><td>${esc(c)}</td><td class="num">${money(v)}</td></tr>`).join("")}</table>` : ""}
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>Pengeluaran ${esc(monthLabel(month))}</h2>
          <span class="fin-total">Total <strong>${money(total)}</strong></span>
        </div>
        ${dataTable({
          columns: [
            { label: "Tgl", render: e => `<span class="fin-date">${tgl(e.spentOn)}</span>` },
            { label: "Jenis", render: e => `${esc(e.category)}${e.note ? `<span class="muted-sm">${esc(e.note)}</span>` : ""}` },
            { label: "Jumlah", num: true, render: e => money(e.amount) },
            { label: "", render: e => `<button class="btn btn-ghost btn-xs" data-del="${e.id}">Hapus</button>` },
          ],
          rows: expenses,
          empty: `Belum ada pengeluaran di ${monthLabel(month)}.`,
        })}
      </div>
    </div>`;

  onMonthChange(root, () => renderExpenses(root));
  const $ = s => root.querySelector(s);

  $("#exForm").addEventListener("submit", async e => {
    e.preventDefault();
    const err = $("#exErr");
    err.hidden = true;
    const amount = readRupiah($("#exAmount").value);
    if (!(amount > 0)) { err.textContent = "Isi jumlah dengan angka, mis. 1.250.000."; err.hidden = false; return; }
    const btn = $("#exSave");
    btn.disabled = true;
    try {
      await api.finCreateExpense({ spentOn: $("#exDate").value, category: $("#exCat").value, amount, note: $("#exNote").value });
      toast("Pengeluaran tersimpan", "success");
      renderExpenses(root);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  });

  root.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async () => {
    const x = expenses.find(e => e.id === Number(btn.dataset.del));
    const ok = await confirmAction({ title: "Hapus pengeluaran?", message: `${x.category} ${money(x.amount)} pada ${tgl(x.spentOn)} akan dihapus.` });
    if (!ok) return;
    try {
      await api.finDeleteExpense(x.id);
      toast("Pengeluaran dihapus", "success");
      renderExpenses(root);
    } catch (ex) { toast(ex.message, "error", 6000); }
  }));
}
