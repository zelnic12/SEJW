// ---- Generic category icons ----
// Maps a category name to a simple inline SVG. Matching is keyword-based, so a
// brand-new category added to a product later still gets a sensible icon (and
// falls back to a neutral "box" glyph when nothing matches).
// Exposed on window.CategoryIcons.
(function () {
  const S = (paths) =>
    `<svg class="cat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

  const LAPTOP   = S(`<rect x="3" y="5" width="18" height="11" rx="1.5"/><path d="M2 19h20"/>`);
  const PHONE    = S(`<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10.5 18.5h3"/>`);
  const AUDIO    = S(`<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13.5" width="4" height="7" rx="2"/><rect x="17.5" y="13.5" width="4" height="7" rx="2"/>`);
  const GAMING   = S(`<rect x="2.5" y="7.5" width="19" height="10" rx="5"/><path d="M8 10.5v4M6 12.5h4M15.5 11.5h.01M18 13.5h.01"/>`);
  const WATCH    = S(`<rect x="6.5" y="6.5" width="11" height="11" rx="3"/><path d="M9.5 6.5V3h5v3.5M9.5 17.5V21h5v-3.5"/>`);
  const HOME     = S(`<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5h4v5"/>`);
  const DISPLAY  = S(`<rect x="2.5" y="4" width="19" height="12.5" rx="1.5"/><path d="M8.5 20h7M12 16.5V20"/>`);
  const CAMERA   = S(`<path d="M3 8.5h3L7.5 6h9L18 8.5h3v11H3z"/><circle cx="12" cy="14" r="3.2"/>`);
  const TABLET   = S(`<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M11 18.5h2"/>`);
  const PLUG     = S(`<path d="M9 3v6M15 3v6"/><path d="M6.5 9h11v3a5.5 5.5 0 0 1-11 0z"/><path d="M12 17.5V21"/>`);
  const STORAGE  = S(`<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>`);
  const BOX      = S(`<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>`);
  const TAG      = S(`<path d="M20.5 13.5 13 21a2 2 0 0 1-2.8 0L3 13.8V3.5h10.3l7.2 7.2a2 2 0 0 1 0 2.8z"/><path d="M7.5 7.5h.01"/>`);

  // First match wins — order matters (e.g. "smart home" before "smart").
  const RULES = [
    [/laptop|notebook|computer|pc\b|macbook/, LAPTOP],
    [/phone|smartphone|mobile|handphone|hp\b/, PHONE],
    [/audio|headphone|headset|earbud|speaker|sound|music/, AUDIO],
    [/gaming|game|console|konsol/, GAMING],
    [/wearable|watch|band|fitness|jam/, WATCH],
    [/smart\s*home|home|rumah|lamp|light|appliance/, HOME],
    [/tv|television|monitor|display|screen|proyektor|projector/, DISPLAY],
    [/camera|kamera|photo|drone/, CAMERA],
    [/tablet|ipad/, TABLET],
    [/accessor|aksesor|cable|kabel|charger|adapter|power|battery/, PLUG],
    [/storage|drive|ssd|hdd|memory|card|flash/, STORAGE],
    [/deal|promo|sale|diskon/, TAG],
  ];

  // Return an inline SVG string for a category name.
  function iconFor(category) {
    const name = String(category || "").toLowerCase();
    for (const [re, svg] of RULES) if (re.test(name)) return svg;
    return BOX;
  }

  window.CategoryIcons = { iconFor, TAG, BOX };
})();
