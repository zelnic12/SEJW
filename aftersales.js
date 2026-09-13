// ---- Aftersales: submit a warranty claim / return, and track it ----
// Two panels on one page: "Start a request" (verify order → describe → submit)
// and "Track a request" (tracking code → status timeline + staff notes).
// No login anywhere: the order id + the email on that order is the credential
// for submitting, and the tracking code is the key for looking a request up.
(function () {
  const { esc } = window.ProductCard;
  const $ = sel => document.querySelector(sel);
  const API = "/api";

  const MAX_PHOTOS = 5;
  const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
  const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

  // The visual step indicator. `rejected` isn't a step of its own — it replaces
  // the decision step, and the remaining steps are greyed out.
  const STEPS = [
    { key: "submitted",    label: "Submitted",    hint: "Permintaan Anda sudah kami terima." },
    { key: "under_review", label: "Under review", hint: "Tim kami sedang memeriksa permintaan." },
    { key: "approved",     label: "Approved",     hint: "Permintaan disetujui." },
    { key: "processing",   label: "Processing",   hint: "Sedang kami proses." },
    { key: "completed",    label: "Completed",    hint: "Permintaan selesai." },
  ];
  const STATUS_INDEX = { submitted: 0, under_review: 1, approved: 2, rejected: 2, processing: 3, completed: 4 };
  const STATUS_LABELS = {
    submitted: "Submitted", under_review: "Under review", approved: "Approved",
    rejected: "Rejected", processing: "Processing", completed: "Completed",
  };
  const TYPE_LABELS = { warranty_claim: "Warranty claim", return_exchange: "Return / exchange" };

  let PRODUCTS = [];
  let verifiedOrder = null;      // { orderId, customerName, items, … } once checked
  let selectedPhotos = [];       // File[] chosen for upload
  let previewUrls = [];          // object URLs to revoke when the list changes

  const fmtDateTime = iso => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("id-ID", {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  };

  function showError(el, message) {
    el.textContent = message;
    el.hidden = !message;
  }

  // ---- Tabs -----------------------------------------------------------------
  function selectTab(which) {
    const isTrack = which === "track";
    $("#tabRequest").classList.toggle("is-active", !isTrack);
    $("#tabTrack").classList.toggle("is-active", isTrack);
    $("#tabRequest").setAttribute("aria-selected", String(!isTrack));
    $("#tabTrack").setAttribute("aria-selected", String(isTrack));
    $("#panelRequest").hidden = isTrack;
    $("#panelTrack").hidden = !isTrack;
  }

  // ---- Step 1: verify the order -------------------------------------------
  async function verifyOrder(e) {
    e.preventDefault();
    const btn = $("#verifyBtn");
    const err = $("#verifyError");
    showError(err, "");
    const orderId = $("#asOrderId").value.trim();
    const email = $("#asEmail").value.trim();
    if (!orderId || !email) { showError(err, "Please fill in both fields."); return; }

    btn.disabled = true; btn.textContent = "Checking…";
    try {
      const res = await fetch(`${API}/aftersales/verify-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "We couldn't check that order right now.");

      verifiedOrder = data;
      renderOrderSummary(data);
      $("#verifyCard").hidden = true;
      $("#requestCard").hidden = false;
      $("#successCard").hidden = true;
      $("#asDescription").focus();
    } catch (e2) {
      showError(err, e2.message);
    } finally {
      btn.disabled = false; btn.textContent = "Find my order";
    }
  }

  function renderOrderSummary(order) {
    const items = order.items || [];
    $("#orderSummary").innerHTML = `
      <div class="as-order-line">
        <span class="as-order-label">Order</span>
        <strong>${esc(order.orderId)}</strong>
      </div>
      <div class="as-order-line">
        <span class="as-order-label">Placed for</span>
        <span>${esc(order.customerName || "")}${order.orderDate ? ` · ${esc(fmtDateTime(order.orderDate))}` : ""}</span>
      </div>
      <div class="as-order-line">
        <span class="as-order-label">Items</span>
        <span>${items.length ? items.map(i => `${esc(i.name)} ×${i.quantity}`).join(", ") : "—"}</span>
      </div>`;

    // Offer the order's own line items to pick from.
    const select = $("#asProduct");
    select.innerHTML = `<option value="">The order as a whole</option>` +
      items
        .filter(i => i.productId != null)
        .map(i => `<option value="${i.productId}">${esc(i.name)}</option>`)
        .join("");
  }

  // ---- Photo picking ------------------------------------------------------
  function renderPreviews() {
    previewUrls.forEach(URL.revokeObjectURL);
    previewUrls = [];
    const wrap = $("#photoPreviews");
    if (!selectedPhotos.length) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = selectedPhotos.map((file, i) => {
      const url = URL.createObjectURL(file);
      previewUrls.push(url);
      const kb = Math.round(file.size / 1024);
      return `
        <figure class="as-preview">
          <img src="${url}" alt="" />
          <figcaption>${kb} KB</figcaption>
          <button type="button" class="as-preview-remove" data-remove="${i}" aria-label="Remove ${esc(file.name)}">✕</button>
        </figure>`;
    }).join("");
    wrap.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", () => {
      selectedPhotos.splice(Number(b.dataset.remove), 1);
      renderPreviews();
    }));
  }

  function onPhotosPicked() {
    const input = $("#asPhotos");
    const err = $("#requestError");
    showError(err, "");
    for (const file of input.files) {
      if (selectedPhotos.length >= MAX_PHOTOS) {
        showError(err, `You can attach up to ${MAX_PHOTOS} photos.`);
        break;
      }
      if (!ALLOWED_PHOTO_TYPES.includes(file.type)) {
        showError(err, `"${file.name}" isn't a JPG, PNG or WebP image.`);
        continue;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        showError(err, `"${file.name}" is larger than 5 MB.`);
        continue;
      }
      selectedPhotos.push(file);
    }
    // Clear the native input so picking the same file again still fires change.
    input.value = "";
    renderPreviews();
  }

  // ---- Step 2: submit -----------------------------------------------------
  async function submitRequest(e) {
    e.preventDefault();
    const err = $("#requestError");
    showError(err, "");
    if (!verifiedOrder) { showError(err, "Please find your order first."); return; }

    const description = $("#asDescription").value.trim();
    if (description.length < 10) {
      showError(err, "Please describe the problem in at least 10 characters.");
      return;
    }

    const fd = new FormData();
    fd.append("orderId", verifiedOrder.orderId);
    fd.append("customerEmail", $("#asEmail").value.trim());
    fd.append("type", $("input[name=type]:checked").value);
    fd.append("description", description);
    const productId = $("#asProduct").value;
    if (productId) fd.append("productId", productId);
    for (const file of selectedPhotos) fd.append("photos", file);

    const btn = $("#submitRequestBtn");
    btn.disabled = true; btn.textContent = "Submitting…";
    try {
      const res = await fetch(`${API}/aftersales`, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = Array.isArray(data.details) ? data.details.join(" ") : "";
        throw new Error([data.error, detail].filter(Boolean).join(" — ") || "Could not submit your request.");
      }
      showSuccess(data);
    } catch (e2) {
      showError(err, e2.message);
    } finally {
      btn.disabled = false; btn.textContent = "Submit request";
    }
  }

  function showSuccess(data) {
    $("#requestCard").hidden = true;
    $("#verifyCard").hidden = true;
    $("#successCard").hidden = false;
    $("#successCode").textContent = data.id;
    $("#successHint").textContent =
      `${TYPE_LABELS[data.type] || data.type} · diajukan ${fmtDateTime(data.createdAt)}. ` +
      `Kami akan memperbarui status permintaan ini di halaman pelacakan.`;
    $("#goTrackBtn").dataset.code = data.id;
    // Keep the code in the URL so a refresh doesn't lose it.
    history.replaceState(null, "", `aftersales.html?track=${encodeURIComponent(data.id)}`);
    // Reset the form state for a possible second request.
    selectedPhotos = [];
    renderPreviews();
    $("#requestForm").reset();
    $("#descCount").textContent = "0";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---- Tracking -----------------------------------------------------------
  function timelineHTML(status) {
    const current = STATUS_INDEX[status] ?? 0;
    const rejected = status === "rejected";
    return `<ol class="as-timeline">${STEPS.map((step, i) => {
      let cls, label = step.label, hint = step.hint;
      if (rejected && i === 2) {
        cls = "rejected current"; label = "Rejected";
        hint = "Permintaan tidak dapat kami setujui — lihat catatan di bawah.";
      } else if (rejected && i > 2) {
        cls = "skipped";
      } else if (i < current) {
        cls = "done";
      } else if (i === current) {
        cls = "current";
      } else {
        cls = "upcoming";
      }
      const marker = cls.includes("done") ? "✓" : (cls.startsWith("rejected") ? "✕" : String(i + 1));
      return `
        <li class="as-step ${cls}">
          <span class="as-step-marker" aria-hidden="true">${marker}</span>
          <span class="as-step-text">
            <strong>${esc(label)}</strong>
            <small>${esc(hint || "")}</small>
          </span>
        </li>`;
    }).join("")}</ol>`;
  }

  function renderTracked(request) {
    const photos = request.photos || [];
    $("#trackResult").hidden = false;
    $("#trackResult").innerHTML = `
      <div class="as-track-head">
        <div>
          <span class="as-track-label">Tracking code</span>
          <h2 class="as-card-title">${esc(request.id)}</h2>
          <p class="as-card-hint">
            ${esc(TYPE_LABELS[request.type] || request.type)}
            · order ${esc(request.orderId)}
            ${request.productName ? `· ${esc(request.productName)}` : ""}
          </p>
        </div>
        <span class="as-status-badge ${esc(request.status)}">${esc(STATUS_LABELS[request.status] || request.status)}</span>
      </div>

      ${timelineHTML(request.status)}

      ${request.adminNotes ? `
        <div class="as-notes">
          <h3>Note from our team</h3>
          <p>${esc(request.adminNotes)}</p>
        </div>` : ""}

      <div class="as-track-meta">
        <div><span class="as-order-label">Submitted</span><span>${esc(fmtDateTime(request.createdAt))}</span></div>
        <div><span class="as-order-label">Last update</span><span>${esc(fmtDateTime(request.updatedAt))}</span></div>
        <div><span class="as-order-label">Contact</span><span>${esc(request.customerEmail || "—")}</span></div>
      </div>

      <div class="as-detail-block">
        <h3>What you told us</h3>
        <p class="as-description">${esc(request.description)}</p>
      </div>

      ${photos.length ? `
        <div class="as-detail-block">
          <h3>Your photos</h3>
          <div class="as-photos">
            ${photos.map((url, i) => `
              <a class="as-photo" href="${esc(url)}" target="_blank" rel="noopener" title="Open full size">
                <img src="${esc(url)}" alt="Evidence photo ${i + 1}" loading="lazy" />
              </a>`).join("")}
          </div>
        </div>` : ""}`;
  }

  async function trackRequest(e) {
    if (e) e.preventDefault();
    const err = $("#trackError");
    showError(err, "");
    const code = $("#asTrackCode").value.trim();
    if (!code) { showError(err, "Please enter your tracking code."); return; }

    const btn = $("#trackBtn");
    btn.disabled = true; btn.textContent = "Checking…";
    $("#trackResult").hidden = true;
    try {
      const res = await fetch(`${API}/aftersales/${encodeURIComponent(code)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not look that code up.");
      renderTracked(data);
      history.replaceState(null, "", `aftersales.html?track=${encodeURIComponent(data.id)}`);
    } catch (e2) {
      showError(err, e2.message);
    } finally {
      btn.disabled = false; btn.textContent = "Track";
    }
  }

  // ---- Wiring -------------------------------------------------------------
  $("#tabRequest").addEventListener("click", () => selectTab("request"));
  $("#tabTrack").addEventListener("click", () => selectTab("track"));
  $("#verifyForm").addEventListener("submit", verifyOrder);
  $("#requestForm").addEventListener("submit", submitRequest);
  $("#trackForm").addEventListener("submit", trackRequest);
  $("#asPhotos").addEventListener("change", onPhotosPicked);
  $("#asDescription").addEventListener("input", e => {
    $("#descCount").textContent = String(e.target.value.length);
  });
  $("#changeOrderBtn").addEventListener("click", () => {
    verifiedOrder = null;
    selectedPhotos = [];
    renderPreviews();
    $("#requestCard").hidden = true;
    $("#verifyCard").hidden = false;
    $("#asOrderId").focus();
  });
  $("#goTrackBtn").addEventListener("click", () => {
    $("#asTrackCode").value = $("#goTrackBtn").dataset.code || "";
    selectTab("track");
    trackRequest();
  });
  $("#copyCodeBtn").addEventListener("click", async () => {
    const btn = $("#copyCodeBtn");
    try {
      await navigator.clipboard.writeText($("#successCode").textContent.trim());
      btn.textContent = "Copied ✓";
    } catch {
      btn.textContent = "Copy manually";
    }
    setTimeout(() => { btn.textContent = "Copy code"; }, 2000);
  });

  async function init() {
    window.CartUI.init({ getProduct: id => PRODUCTS.find(p => p.id === Number(id)) });

    // The shared header menu + footer links need the catalog; the page works
    // without them, so a failure here is not fatal.
    try {
      const res = await fetch(`${API}/products`);
      if (res.ok) {
        PRODUCTS = await res.json();
        window.SiteHeader.init(PRODUCTS);
        const footer = $("#footerCategoryLinks");
        if (footer) {
          footer.innerHTML = window.SiteHeader.groupBy(PRODUCTS, "category")
            .slice(0, 5)
            .map(g => `<a href="${window.SiteHeader.categoryUrl(g.name)}">${esc(g.name)}</a>`)
            .join("");
        }
        window.CartUI.render();
      }
    } catch { /* header menu stays empty */ }

    // Deep links: ?track=AS-… opens tracking; ?order=&email= prefills the form
    // (used by the "start a request" link on the order confirmation screen).
    const params = new URLSearchParams(location.search);
    const track = params.get("track");
    const order = params.get("order");
    const email = params.get("email");
    if (track) {
      $("#asTrackCode").value = track;
      selectTab("track");
      trackRequest();
    } else if (location.hash === "#track") {
      selectTab("track");
    }
    if (order) $("#asOrderId").value = order;
    if (email) $("#asEmail").value = email;
    if (order && email && !track) {
      // Everything we need is in the link — check the order straight away.
      $("#verifyForm").dispatchEvent(new Event("submit"));
    }
  }

  init();
})();
