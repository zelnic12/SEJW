// ---- Homepage hero banner carousel ----
// Loads the admin-managed slides from GET /api/banners (active only, ordered by
// position) and renders a full-width carousel with auto-rotation, prev/next
// controls, and dot indicators.
//
// Behaviour notes:
//  • If there are no active banners the whole section is removed from the DOM,
//    so nothing empty or broken is left behind.
//  • Auto-rotation pauses on hover and whenever focus is inside the carousel,
//    and is disabled entirely for users who prefer reduced motion.
//  • Controls are real <button>s, so they work with keyboard and screen readers.
(function () {
  const ROTATE_MS = 6000;

  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function slideHTML(b, index) {
    const bg = b.imageUrl
      ? `background-image:url('${esc(b.imageUrl)}')`
      : `background-color:${esc(b.backgroundColor || "#C8102E")}`;
    const cta = b.ctaText && b.ctaLink
      ? `<a class="btn btn-light banner-cta" href="${esc(b.ctaLink)}">${esc(b.ctaText)}</a>`
      : b.ctaText
        ? `<span class="banner-cta-static">${esc(b.ctaText)}</span>`
        : "";
    return `
      <div class="banner-slide ${index === 0 ? "is-active" : ""} ${b.imageUrl ? "has-image" : ""}"
           style="${bg}" data-slide="${index}" role="group"
           aria-roledescription="slide" aria-label="Slide ${index + 1}" ${index === 0 ? "" : "aria-hidden=\"true\""}>
        <div class="container banner-slide-inner">
          <div class="banner-slide-copy">
            <h2 class="banner-headline">${esc(b.headline)}</h2>
            ${b.subtext ? `<p class="banner-subtext">${esc(b.subtext)}</p>` : ""}
            ${cta}
          </div>
        </div>
      </div>`;
  }

  function render(root, banners) {
    const multi = banners.length > 1;
    root.innerHTML = `
      <div class="banner-viewport" aria-live="off">
        ${banners.map(slideHTML).join("")}
      </div>
      ${multi ? `
      <button type="button" class="banner-nav prev" data-dir="-1" aria-label="Previous slide">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>
      </button>
      <button type="button" class="banner-nav next" data-dir="1" aria-label="Next slide">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>
      </button>
      <div class="banner-dots" role="tablist" aria-label="Choose slide">
        ${banners.map((b, i) => `
          <button type="button" class="banner-dot ${i === 0 ? "is-active" : ""}" role="tab"
                  data-dot="${i}" aria-selected="${i === 0}" aria-label="Slide ${i + 1}: ${esc(b.headline)}"></button>`).join("")}
      </div>` : ""}
    `;
  }

  function setup(root, banners) {
    render(root, banners);
    root.hidden = false;

    const slides = [...root.querySelectorAll(".banner-slide")];
    const dots = [...root.querySelectorAll(".banner-dot")];
    let current = 0;
    let timer = null;
    let paused = false;

    const reduceMotion = window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function show(next) {
      current = (next + slides.length) % slides.length;
      slides.forEach((s, i) => {
        const active = i === current;
        s.classList.toggle("is-active", active);
        if (active) s.removeAttribute("aria-hidden");
        else s.setAttribute("aria-hidden", "true");
      });
      dots.forEach((d, i) => {
        d.classList.toggle("is-active", i === current);
        d.setAttribute("aria-selected", String(i === current));
      });
    }

    function start() {
      if (timer || slides.length < 2 || reduceMotion) return;
      timer = setInterval(() => { if (!paused) show(current + 1); }, ROTATE_MS);
    }

    // Manual navigation restarts the clock so a slide isn't cut short.
    function goto(next) {
      show(next);
      if (timer) { clearInterval(timer); timer = null; start(); }
    }

    root.querySelectorAll("[data-dir]").forEach(btn => {
      btn.addEventListener("click", () => goto(current + Number(btn.dataset.dir)));
    });
    dots.forEach(dot => {
      dot.addEventListener("click", () => goto(Number(dot.dataset.dot)));
    });

    // Left/right arrows move between slides when focus is inside the carousel.
    root.addEventListener("keydown", e => {
      if (e.key === "ArrowLeft") { e.preventDefault(); goto(current - 1); }
      if (e.key === "ArrowRight") { e.preventDefault(); goto(current + 1); }
    });

    // Pause on hover and while focus is inside (so keyboard users aren't rushed).
    const pause = () => { paused = true; };
    const resume = () => { paused = false; };
    root.addEventListener("mouseenter", pause);
    root.addEventListener("mouseleave", resume);
    root.addEventListener("focusin", pause);
    root.addEventListener("focusout", e => {
      if (!root.contains(e.relatedTarget)) resume();
    });
    // Don't rotate in a hidden tab.
    document.addEventListener("visibilitychange", () => {
      paused = document.hidden;
    });

    start();
  }

  async function init(selector = "#heroCarousel") {
    const root = typeof selector === "string" ? document.querySelector(selector) : selector;
    if (!root) return;
    try {
      const res = await fetch("/api/banners");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const banners = await res.json();
      if (!Array.isArray(banners) || banners.length === 0) {
        root.remove();                      // nothing active → no empty slider
        return;
      }
      setup(root, banners);
    } catch (err) {
      console.warn("Banners unavailable:", err.message);
      root.remove();                        // fail quietly, never show a broken slider
    }
  }

  window.BannerCarousel = { init };
  document.addEventListener("DOMContentLoaded", () => init());
})();
