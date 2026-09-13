// Sales performance view: revenue stats, best-sellers, sales by category/brand,
// and a daily/weekly/monthly switchable sales chart.
import { api } from "../components/api.js";
import { money, num, esc } from "../components/format.js";
import { statGrid } from "../components/statCard.js";
import { lineChart, barChart } from "../components/charts.js";
import { dataTable } from "../components/dataTable.js";

const BUCKETS = {
  day:   { points: 30, label: b => new Date(b).toLocaleDateString(undefined, { month: "short", day: "numeric" }) },
  week:  { points: 12, label: b => new Date(b).toLocaleDateString(undefined, { month: "short", day: "numeric" }) },
  month: { points: 12, label: b => new Date(b).toLocaleDateString(undefined, { month: "short", year: "2-digit" }) },
};

async function drawChart(container, bucket) {
  container.innerHTML = `<p class="admin-status">Loading…</p>`;
  try {
    const cfg = BUCKETS[bucket];
    const series = await api.timeseries(bucket, cfg.points);
    container.innerHTML = lineChart(series, { labelFmt: cfg.label });
  } catch (err) {
    container.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`;
  }
}

export async function renderSales(root) {
  root.innerHTML = `<p class="admin-status">Loading sales performance…</p>`;
  let summary, bestSellers, byCategory, byBrand;
  try {
    [summary, bestSellers, byCategory, byBrand] = await Promise.all([
      api.summary(), api.bestSellers(8), api.salesByCategory(), api.salesByBrand(),
    ]);
  } catch (err) {
    root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`;
    return;
  }

  const cards = statGrid([
    { icon: "💰", label: "Revenue", value: money(summary.revenue) },
    { icon: "🧾", label: "Orders", value: num(summary.orders) },
    { icon: "📊", label: "Avg order value", value: money(summary.avgOrderValue) },
    { icon: "🚚", label: "Shipping collected", value: money(summary.shipping) },

  ]);

  const chartPanel = `
    <div class="panel">
      <div class="panel-head">
        <h2>Sales trend</h2>
        <div class="chart-toggle" id="bucketToggle">
          <button data-bucket="day" class="active">Daily</button>
          <button data-bucket="week">Weekly</button>
          <button data-bucket="month">Monthly</button>
        </div>
      </div>
      <div id="chartContainer"></div>
    </div>`;

  const bestSellerTable = `
    <div class="panel">
      <div class="panel-head"><h2>Best-selling products</h2></div>
      ${dataTable({
        columns: [
          { key: "name", label: "Product" },
          { key: "units", label: "Units", num: true, render: r => num(r.units) },
          { key: "revenue", label: "Revenue", num: true, render: r => money(r.revenue) },
        ],
        rows: bestSellers,
        empty: "No sales yet.",
      })}
    </div>`;

  const splits = `
    <div class="panel-grid">
      <div class="panel">
        <div class="panel-head"><h2>Revenue by category</h2></div>
        ${barChart(byCategory.map(c => ({ label: c.label, value: c.revenue })))}
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Revenue by brand</h2></div>
        ${barChart(byBrand.map(b => ({ label: b.label, value: b.revenue })))}
      </div>
    </div>`;

  root.innerHTML = cards + chartPanel + bestSellerTable + splits;

  const container = root.querySelector("#chartContainer");
  drawChart(container, "day");

  root.querySelectorAll("#bucketToggle button").forEach(btn => {
    btn.addEventListener("click", () => {
      root.querySelectorAll("#bucketToggle button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      drawChart(container, btn.dataset.bucket);
    });
  });
}
