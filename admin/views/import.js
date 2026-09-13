// Admin "Import products" view: a four-step wizard over the bulk-import API.
//
//   1 Upload     → POST /admin/imports/products/parse   (headers + rows + guesses)
//   2 Map        → the admin confirms which column is which field
//   3 Preview    → POST .../preview  (dry run: parsed values + per-row problems)
//   4 Results    → POST .../commit   (imported / skipped / failed report)
//
// The parsed rows live here in the browser between steps, so the server keeps no
// import state and the same rows the admin previewed are the ones committed.
import { api } from "../components/api.js";
import { money, esc } from "../components/format.js";
import { toast } from "../components/toast.js";

const STEPS = ["Upload file", "Map columns", "Preview", "Results"];

const state = {
  step: 1,
  fileName: "",
  parsed: null,      // { headers, rows, sheetName, totalRows, truncated, firstDataRow, fields }
  mapping: null,
  preview: null,
  results: null,
  fetchImages: true,
};

function resetState() {
  Object.assign(state, {
    step: 1, fileName: "", parsed: null, mapping: null, preview: null, results: null, fetchImages: true,
  });
}

const STATUS_LABELS = { ready: "Will import", duplicate: "Duplicate", error: "Can't import", empty: "Skipped" };
const OUTCOME_LABELS = { imported: "Imported", skipped: "Skipped", failed: "Failed" };

const stepsBar = () => `
  <ol class="imp-steps">
    ${STEPS.map((label, i) => {
      const n = i + 1;
      const cls = n < state.step ? "done" : n === state.step ? "current" : "upcoming";
      return `<li class="imp-step ${cls}"><span class="imp-step-num">${n < state.step ? "✓" : n}</span>${esc(label)}</li>`;
    }).join("")}
  </ol>`;

// Notes shown per row: errors first (they block the row), then warnings.
const noteList = row => {
  const items = [...(row.errors || []).map(t => ({ t, cls: "error" })), ...(row.warnings || []).map(t => ({ t, cls: "warn" }))];
  if (!items.length) return `<span class="muted-sm">—</span>`;
  return `<ul class="imp-notes">${items.map(i => `<li class="${i.cls}">${esc(i.t)}</li>`).join("")}</ul>`;
};

// ---------------------------------------------------------------------------
// Step 1 — upload
// ---------------------------------------------------------------------------
function renderUpload(root) {
  root.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Import products</h2></div>
      ${stepsBar()}
      <div class="imp-body">
        <p class="panel-note imp-intro">
          Upload a product export from Shopee Seller Centre (or any spreadsheet) as
          <strong>.xlsx</strong>, <strong>.xls</strong> or <strong>.csv</strong>. You'll choose which
          column means what, then review a preview before anything is saved.
        </p>
        <div class="imp-drop">
          <input type="file" id="impFile" accept=".xlsx,.xls,.csv" />
          <button class="btn btn-primary" id="impRead">Read file</button>
        </div>
        <p class="form-hint">Up to 10 MB and 5,000 rows per import. Nothing is written to the catalog at this step.</p>
        <p class="form-error" id="impError" hidden></p>
      </div>
    </div>`;

  const err = root.querySelector("#impError");
  root.querySelector("#impRead").addEventListener("click", async () => {
    const input = root.querySelector("#impFile");
    const file = input.files && input.files[0];
    err.hidden = true;
    if (!file) { err.textContent = "Choose a spreadsheet first."; err.hidden = false; return; }

    const btn = root.querySelector("#impRead");
    btn.disabled = true; btn.textContent = "Reading…";
    try {
      const parsed = await api.parseProductImport(file);
      state.parsed = parsed;
      state.fileName = parsed.fileName || file.name;
      state.mapping = { ...parsed.suggestedMapping };
      state.step = 2;
      render(root);
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      btn.disabled = false; btn.textContent = "Read file";
    }
  });
}

// ---------------------------------------------------------------------------
// Step 2 — column mapping
// ---------------------------------------------------------------------------
function renderMapping(root) {
  const { headers, rows, sheetName, totalRows, truncated, fields } = state.parsed;

  // First non-empty value in a column — makes it obvious whether a guess is right.
  const sampleFor = index => {
    if (index === null || index === undefined || index === "") return "";
    for (const row of rows.slice(0, 50)) {
      const v = row[Number(index)];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
    }
    return "";
  };

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Import products</h2>
        <button class="btn btn-ghost btn-sm" id="impStartOver">Choose a different file</button>
      </div>
      ${stepsBar()}
      <div class="imp-body">
        <div class="imp-filemeta">
          <div><span class="imp-label">File</span><strong>${esc(state.fileName)}</strong></div>
          <div><span class="imp-label">Sheet</span><span>${esc(sheetName || "—")}</span></div>
          <div><span class="imp-label">Data rows</span><span>${totalRows}</span></div>
          <div><span class="imp-label">Columns</span><span>${headers.length}</span></div>
        </div>
        ${truncated ? `<p class="imp-warn">Only the first 5,000 rows were read from this file.</p>` : ""}

        <p class="panel-note">
          We've pre-selected the columns that look right — check each one before continuing.
          Anything left as <em>Not imported</em> is ignored (extra Shopee columns like variant
          or SKU can stay unmapped).
        </p>

        <div class="table-scroll">
          <table class="data-table imp-map-table">
            <thead><tr><th>Product field</th><th>Spreadsheet column</th><th>Example value</th></tr></thead>
            <tbody>
              ${fields.map(field => `
                <tr>
                  <td>
                    <strong>${esc(field.label)}</strong>${field.required ? ` <span class="imp-req">required</span>` : ""}
                    ${field.hint ? `<span class="muted-sm">${esc(field.hint)}</span>` : ""}
                  </td>
                  <td>
                    <select class="imp-select" data-field="${esc(field.key)}" aria-label="Column for ${esc(field.label)}">
                      <option value="">— Not imported —</option>
                      ${headers.map((h, i) => `
                        <option value="${i}" ${String(state.mapping[field.key]) === String(i) ? "selected" : ""}>
                          ${esc(h)}
                        </option>`).join("")}
                    </select>
                  </td>
                  <td class="imp-sample" data-sample="${esc(field.key)}">${esc(sampleFor(state.mapping[field.key]))}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>

        <p class="form-error" id="impError" hidden></p>
        <div class="imp-actions">
          <button class="btn btn-primary" id="impPreview">Preview import</button>
        </div>
      </div>
    </div>`;

  root.querySelectorAll(".imp-select").forEach(select => {
    select.addEventListener("change", () => {
      const field = select.dataset.field;
      state.mapping[field] = select.value === "" ? null : Number(select.value);
      const cell = root.querySelector(`[data-sample="${field}"]`);
      if (cell) cell.textContent = sampleFor(state.mapping[field]);
    });
  });

  root.querySelector("#impStartOver").addEventListener("click", () => { resetState(); render(root); });

  const err = root.querySelector("#impError");
  root.querySelector("#impPreview").addEventListener("click", async () => {
    err.hidden = true;
    const missing = fields.filter(f => f.required && (state.mapping[f.key] === null || state.mapping[f.key] === undefined));
    if (missing.length) {
      err.textContent = `Map a column for: ${missing.map(f => f.label).join(", ")}.`;
      err.hidden = false;
      return;
    }
    const btn = root.querySelector("#impPreview");
    btn.disabled = true; btn.textContent = "Checking rows…";
    try {
      state.preview = await api.previewProductImport({
        headers, rows, mapping: state.mapping, firstDataRow: state.parsed.firstDataRow,
      });
      state.step = 3;
      render(root);
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      btn.disabled = false; btn.textContent = "Preview import";
    }
  });
}

// ---------------------------------------------------------------------------
// Step 3 — preview
// ---------------------------------------------------------------------------
function renderPreview(root) {
  const { summary, rows, problems, previewRows } = state.preview;
  const imageMapped = state.mapping.imageUrl !== null && state.mapping.imageUrl !== undefined;
  // Problems that fall outside the preview window are worth surfacing too.
  const extraProblems = (problems || []).filter(p => p.rowNumber > (rows[rows.length - 1]?.rowNumber ?? 0));

  const priceCell = row => {
    if (!row.values || row.values.price === null) return `<span class="imp-bad">—</span>`;
    const raw = String(row.raw.price ?? "");
    const parsed = money(row.values.price);
    // Show the original text when cleaning changed it, so surprises are visible.
    return raw && raw.replace(/[^\d]/g, "") !== String(row.values.price).replace(/[^\d]/g, "")
      ? `${parsed}<span class="muted-sm">from “${esc(raw)}”</span>`
      : parsed;
  };

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h2>Import products</h2>
        <button class="btn btn-ghost btn-sm" id="impBack">← Back to mapping</button>
      </div>
      ${stepsBar()}
      <div class="imp-body">
        <div class="imp-chips">
          <span class="imp-chip ready">${summary.ready} will import</span>
          <span class="imp-chip duplicate">${summary.duplicates} duplicate${summary.duplicates === 1 ? "" : "s"}</span>
          <span class="imp-chip error">${summary.errors} can't import</span>
          <span class="imp-chip empty">${summary.empty} blank row${summary.empty === 1 ? "" : "s"} skipped</span>
        </div>

        <p class="panel-note">
          Showing the first ${previewRows} of ${summary.total} rows exactly as they'd be imported.
          Duplicates (a product with the same name already exists) and rows with errors are skipped —
          everything else is created.
        </p>

        <div class="table-scroll">
          <table class="data-table imp-preview-table">
            <thead>
              <tr><th>Row</th><th>Status</th><th>Name</th><th>Category</th><th>Brand</th>
                  <th class="num">Price</th><th class="num">Stock</th><th>Image</th><th>Notes</th></tr>
            </thead>
            <tbody>
              ${rows.map(row => `
                <tr class="imp-row-${esc(row.status)}">
                  <td>${row.rowNumber}</td>
                  <td><span class="badge imp-${esc(row.status)}">${esc(STATUS_LABELS[row.status] || row.status)}</span></td>
                  <td>${esc(row.values?.name || row.raw?.name || "—")}</td>
                  <td>${esc(row.values?.category || "—")}</td>
                  <td>${esc(row.values?.brand || "—")}</td>
                  <td class="num">${priceCell(row)}</td>
                  <td class="num">${row.values ? row.values.stock : "—"}</td>
                  <td>${row.values?.imageUrl ? `<span class="imp-ok">yes</span>` : `<span class="muted-sm">—</span>`}</td>
                  <td>${noteList(row)}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>

        ${extraProblems.length ? `
          <div class="imp-problems">
            <h4>${extraProblems.length} more row${extraProblems.length === 1 ? "" : "s"} further down the file need attention</h4>
            <ul>
              ${extraProblems.slice(0, 25).map(p => `
                <li><strong>Row ${p.rowNumber}</strong> ${esc(p.raw?.name || "")} —
                  ${esc([...(p.errors || []), ...(p.warnings || [])].join("; "))}</li>`).join("")}
            </ul>
          </div>` : ""}

        ${imageMapped ? `
          <label class="imp-checkbox">
            <input type="checkbox" id="impFetchImages" ${state.fetchImages ? "checked" : ""} />
            <span>
              Download images from the mapped URL column and store them in Cloudinary
              <small>Rows whose image can't be fetched are still imported and flagged “needs an image”. Adds time to the import.</small>
            </span>
          </label>` : ""}

        <p class="form-error" id="impError" hidden></p>
        <div class="imp-actions">
          <button class="btn btn-primary" id="impCommit" ${summary.ready === 0 ? "disabled" : ""}>
            Import ${summary.ready} product${summary.ready === 1 ? "" : "s"}
          </button>
          ${summary.ready === 0 ? `<span class="muted-sm">Nothing to import — adjust the mapping or fix the file.</span>` : ""}
        </div>
      </div>
    </div>`;

  root.querySelector("#impBack").addEventListener("click", () => { state.step = 2; render(root); });
  root.querySelector("#impFetchImages")?.addEventListener("change", e => { state.fetchImages = e.target.checked; });

  const err = root.querySelector("#impError");
  root.querySelector("#impCommit").addEventListener("click", async () => {
    err.hidden = true;
    const btn = root.querySelector("#impCommit");
    btn.disabled = true;
    btn.textContent = state.fetchImages && imageMapped ? "Importing (fetching images)…" : "Importing…";
    try {
      state.results = await api.commitProductImport({
        headers: state.parsed.headers,
        rows: state.parsed.rows,
        mapping: state.mapping,
        firstDataRow: state.parsed.firstDataRow,
        fetchImages: state.fetchImages,
      });
      state.step = 4;
      toast(`${state.results.summary.imported} products imported`, "success");
      render(root);
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
      btn.disabled = false; btn.textContent = `Import ${summary.ready} products`;
    }
  });
}

// ---------------------------------------------------------------------------
// Step 4 — results
// ---------------------------------------------------------------------------
function renderResults(root) {
  const { summary, results } = state.results;
  const shown = results.filter(r => r.outcome !== "imported" || r.needsImage || r.reasons.length);

  root.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h2>Import finished</h2></div>
      ${stepsBar()}
      <div class="imp-body">
        <p class="imp-headline">
          <strong>${summary.imported} imported</strong>,
          ${summary.skippedDuplicates} skipped as duplicate${summary.skippedDuplicates === 1 ? "" : "s"},
          ${summary.failed} failed${summary.emptyRowsSkipped ? `, ${summary.emptyRowsSkipped} blank row${summary.emptyRowsSkipped === 1 ? "" : "s"} ignored` : ""}.
        </p>
        ${summary.needsImage ? `
          <p class="imp-warn">
            ${summary.needsImage} product${summary.needsImage === 1 ? "" : "s"} came in without an image —
            add one from the product's edit form when you get a chance. The reason is listed below.
          </p>` : ""}

        ${shown.length ? `
          <div class="table-scroll">
            <table class="data-table">
              <thead><tr><th>Row</th><th>Product</th><th>Outcome</th><th>Details</th></tr></thead>
              <tbody>
                ${shown.map(r => `
                  <tr>
                    <td>${r.rowNumber}</td>
                    <td>${esc(r.name)}</td>
                    <td>
                      <span class="badge imp-outcome-${esc(r.outcome)}">${esc(OUTCOME_LABELS[r.outcome] || r.outcome)}</span>
                      ${r.needsImage ? `<span class="badge imp-needs-image">needs an image</span>` : ""}
                    </td>
                    <td>${r.reasons.length ? `<ul class="imp-notes">${r.reasons.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<span class="muted-sm">—</span>`}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>`
        : `<p class="admin-status">Every row imported cleanly.</p>`}

        <div class="imp-actions">
          <button class="btn btn-primary" id="impGoProducts">View products</button>
          <button class="btn btn-ghost" id="impAnother">Import another file</button>
        </div>
      </div>
    </div>`;

  root.querySelector("#impGoProducts").addEventListener("click", () => {
    resetState();
    location.hash = "#products";
  });
  root.querySelector("#impAnother").addEventListener("click", () => { resetState(); render(root); });
}

function render(root) {
  if (state.step === 2 && state.parsed) return renderMapping(root);
  if (state.step === 3 && state.preview) return renderPreview(root);
  if (state.step === 4 && state.results) return renderResults(root);
  return renderUpload(root);
}

export async function renderImport(root) {
  // Entering the view fresh (e.g. from the nav) always starts at step 1; the
  // refresh button re-renders whatever step is in progress.
  render(root);
}
