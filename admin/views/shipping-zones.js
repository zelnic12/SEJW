// Admin Shipping Zones view — the delivery coverage map (Jabodetabek).
//
// Each row is one kecamatan with its own shipping fee. The checkout dropdown is
// built from the *active* rows here, and the order route re-reads the chosen zone
// server-side, so this table is the single source of truth for both coverage and
// ongkir. Deactivating a row removes it from checkout without losing history on
// orders that already shipped there.
import { api } from "../components/api.js";
import { money, esc } from "../components/format.js";
import { dataTable } from "../components/dataTable.js";
import { openModal } from "../components/modal.js";
import { toast } from "../components/toast.js";

// City → kecamatan, so the table reads like the checkout dropdown.
function sortZones(zones) {
  return [...zones].sort((a, b) =>
    a.cityName.localeCompare(b.cityName, "id") ||
    a.districtName.localeCompare(b.districtName, "id"));
}

function uniqueCities(zones) {
  return [...new Set(zones.map(z => z.cityName))]
    .sort((a, b) => a.localeCompare(b, "id"));
}

function matches(zone, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return zone.cityName.toLowerCase().includes(q) || zone.districtName.toLowerCase().includes(q);
}

// Shared form markup for both create and edit. `zone` is null when creating.
function zoneFormHTML(zone, cities) {
  const options = cities.map(c => `<option value="${esc(c)}"></option>`).join("");
  return `
    <form id="zoneForm">
      <div class="form-grid">
        <div class="form-field">
          <label>City / area *</label>
          <input name="cityName" list="zoneCityList" placeholder="e.g. Jakarta Selatan"
                 value="${esc(zone?.cityName ?? "")}" required />
          <datalist id="zoneCityList">${options}</datalist>
          <span class="form-hint">Groups the checkout dropdown. Reuse a name to add to that group.</span>
        </div>
        <div class="form-field">
          <label>Kecamatan *</label>
          <input name="districtName" placeholder="e.g. Kebayoran Baru"
                 value="${esc(zone?.districtName ?? "")}" required />
          <span class="form-hint">What the customer actually picks at checkout.</span>
        </div>
        <div class="form-field full">
          <label>Shipping fee (Rp) *</label>
          <input name="shippingFee" type="number" min="0" step="500"
                 value="${zone ? Number(zone.shippingFee) : ""}" required />
        </div>
      </div>
      <label class="imp-checkbox">
        <input type="checkbox" name="isActive" ${zone === null || zone.isActive ? "checked" : ""} />
        <span>
          Active — customers can pick this kecamatan at checkout
          <small>Uncheck to stop taking delivery orders here without deleting the fee history.</small>
        </span>
      </label>
      <p class="form-error" id="zoneErr" hidden></p>
    </form>`;
}

// Pull + validate the form. Returns a payload, or null after showing the error.
function readZoneForm(overlay) {
  const fd = new FormData(overlay.querySelector("#zoneForm"));
  const err = overlay.querySelector("#zoneErr");
  const fail = msg => { err.textContent = msg; err.hidden = false; return null; };

  const cityName = String(fd.get("cityName") || "").trim();
  const districtName = String(fd.get("districtName") || "").trim();
  const shippingFee = Number(fd.get("shippingFee"));

  if (cityName.length < 2) return fail("Enter the city or area name.");
  if (districtName.length < 2) return fail("Enter the kecamatan name.");
  if (!Number.isFinite(shippingFee) || shippingFee < 0) return fail("Enter a valid shipping fee (0 or more).");

  err.hidden = true;
  return { cityName, districtName, shippingFee, isActive: fd.get("isActive") === "on" };
}

function createZoneForm(root, cities) {
  openModal({
    title: "Add shipping zone",
    bodyHTML: zoneFormHTML(null, cities),
    footHTML: `
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="zoneSave">Add zone</button>`,
    onMount(overlay, close) {
      overlay.querySelector("#zoneSave").addEventListener("click", async () => {
        const payload = readZoneForm(overlay);
        if (!payload) return;
        try {
          await api.createShippingZone(payload);
          toast(`${payload.districtName} added`, "success");
          close();
          renderShippingZones(root);
        } catch (e) {
          const err = overlay.querySelector("#zoneErr");
          err.textContent = e.message;
          err.hidden = false;
        }
      });
    },
  });
}

function editZoneForm(root, zone, cities) {
  openModal({
    title: `Edit ${zone.districtName}`,
    bodyHTML: zoneFormHTML(zone, cities),
    footHTML: `
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="zoneSave">Save changes</button>`,
    onMount(overlay, close) {
      overlay.querySelector("#zoneSave").addEventListener("click", async () => {
        const payload = readZoneForm(overlay);
        if (!payload) return;
        try {
          await api.updateShippingZone(zone.id, payload);
          toast("Shipping zone updated", "success");
          close();
          renderShippingZones(root);
        } catch (e) {
          const err = overlay.querySelector("#zoneErr");
          err.textContent = e.message;
          err.hidden = false;
        }
      });
    },
  });
}

export async function renderShippingZones(root) {
  root.innerHTML = `<p class="admin-status">Loading shipping zones…</p>`;
  let payload;
  try {
    payload = await api.listShippingZones();
  } catch (err) {
    root.innerHTML = `<p class="admin-status error">${esc(err.message)}</p>`;
    return;
  }

  const all = sortZones(payload.zones || []);
  const cities = uniqueCities(all);
  const { total = all.length, active = all.filter(z => z.isActive).length } = payload.counts || {};
  // Search text survives re-renders within a single view visit.
  let query = "";

  function drawTable() {
    const rows = all.filter(z => matches(z, query));
    // Repeat the city only on the first row of each group — reads like the
    // grouped checkout dropdown without needing a custom table component.
    let lastCity = null;
    const marked = rows.map(z => {
      const first = z.cityName !== lastCity;
      lastCity = z.cityName;
      return { ...z, _firstOfCity: first };
    });

    const table = dataTable({
      columns: [
        {
          // The city is printed once per group; continuation rows leave it blank
          // so the table reads like the grouped checkout dropdown.
          key: "cityName", label: "City / area",
          render: r => r._firstOfCity ? `<strong>${esc(r.cityName)}</strong>` : "",
        },
        { key: "districtName", label: "Kecamatan", render: r => esc(r.districtName) },
        { key: "shippingFee", label: "Shipping fee", num: true, render: r => money(r.shippingFee) },
        {
          key: "isActive", label: "Status", render: r => r.isActive
            ? `<span class="badge completed">Active</span>`
            : `<span class="badge cancelled">Inactive</span>`,
        },
        {
          key: "actions", label: "", render: r => `
            <div class="row-actions">
              <button class="icon-action" data-edit="${r.id}">Edit</button>
              <button class="icon-action" data-toggle="${r.id}" data-active="${r.isActive}">${r.isActive ? "Deactivate" : "Activate"}</button>
            </div>`,
        },
      ],
      rows: marked,
      rowKey: r => r.id,
      empty: query ? `No zone matches “${query}”.` : "No shipping zones yet — add your first kecamatan.",
    });

    root.querySelector("#zonesTableHost").innerHTML = table;
    bindRowActions();
  }

  function bindRowActions() {
    root.querySelectorAll("[data-edit]").forEach(btn => {
      btn.addEventListener("click", () => {
        const zone = all.find(z => String(z.id) === btn.dataset.edit);
        if (zone) editZoneForm(root, zone, cities);
      });
    });
    root.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const nowActive = btn.dataset.active === "true";
        try {
          await api.updateShippingZone(btn.dataset.toggle, { isActive: !nowActive });
          toast(nowActive ? "Zone deactivated — removed from checkout" : "Zone activated", "success");
          renderShippingZones(root);
        } catch (e) { toast(e.message, "error"); }
      });
    });
  }

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Shipping zones (${total})</h2>
        <button class="btn btn-primary btn-sm" id="addZoneBtn">+ Add zone</button>
      </div>
      <p class="zones-intro">
        Delivery is limited to these kecamatan and priced per row. ${active} of ${total} active
        across ${cities.length} ${cities.length === 1 ? "city/area" : "cities/areas"}.
        Deactivate a row to stop taking delivery orders there — existing orders keep their fee.
      </p>
      <div class="table-toolbar">
        <div class="search-field">
          <span class="search-field-icon" aria-hidden="true">🔍</span>
          <input type="search" id="zoneSearch" class="search-field-input" autocomplete="off"
                 placeholder="Search city or kecamatan…" aria-label="Search shipping zones" />
        </div>
      </div>
      <div id="zonesTableHost"></div>
    </div>`;

  root.querySelector("#addZoneBtn").addEventListener("click", () => createZoneForm(root, cities));
  root.querySelector("#zoneSearch").addEventListener("input", e => {
    query = e.target.value.trim();
    drawTable();
  });

  drawTable();
}
