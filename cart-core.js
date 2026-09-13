// ---- Shared cart core ----
// Loaded by both the storefront (script.js) and checkout (checkout.js) so the
// two pages agree on products, pricing and totals. Exposed on window.VoltEdge.

(function (global) {
  const STORAGE_KEY = "voltedge_cart";

  // Pricing config — keep checkout and storefront math in sync.
  // Shipping is priced per Jabodetabek kecamatan (see /api/shipping-zones) and
  // resolved server-side at checkout, so there's no flat fee or threshold here.
  // No tax is charged.
  const CONFIG = {};

  const API_BASE = "/api";

  // Product catalog. Loaded from the API via loadProducts(); the array below is
  // a fallback so the cart can still render if the API is briefly unavailable.
  let PRODUCTS = [
    {
      id: 1, name: "AeroBook Pro 14", brand: "Aero", category: "Laptops",
      price: 1499.00, rating: 4.8, emoji: "💻", stock: 12,
      description: "A pro-grade 14-inch laptop built for creators and developers. All-day battery, a stunning display, and serious performance in a thin aluminium body.",
      specs: { Display: "14.2\" Liquid Retina, 120Hz", Processor: "AeroChip M3 Pro (10-core)", Memory: "16GB unified", Storage: "512GB SSD", Battery: "Up to 18 hours", Weight: "1.6 kg" }
    },
    {
      id: 2, name: "AeroBook Air 13", brand: "Aero", category: "Laptops",
      price: 999.00, rating: 4.6, emoji: "💻", stock: 25,
      description: "Featherlight and fanless, the Air 13 is the everyday laptop for work, study and streaming. Silent, cool, and impossibly portable.",
      specs: { Display: "13.6\" Liquid Retina", Processor: "AeroChip M3 (8-core)", Memory: "8GB unified", Storage: "256GB SSD", Battery: "Up to 20 hours", Weight: "1.24 kg" }
    },
    {
      id: 3, name: "Nimbus Gaming Laptop", brand: "Nimbus", category: "Laptops",
      price: 1899.00, rating: 4.7, emoji: "💻", stock: 5,
      description: "A high-refresh gaming powerhouse with desktop-class graphics and advanced vapor-chamber cooling. Play the latest titles at max settings.",
      specs: { Display: "16\" QHD+ 240Hz", Processor: "Octa-core 5.0GHz", Graphics: "RTX 4070 8GB", Memory: "32GB DDR5", Storage: "1TB NVMe SSD", Battery: "Up to 6 hours" }
    },
    {
      id: 4, name: "Pulse X Smartphone", brand: "Pulse", category: "Phones",
      price: 899.00, rating: 4.5, emoji: "📱", stock: 40,
      description: "The flagship Pulse X pairs a pro camera system with a brilliant OLED display and blazing-fast 5G. Photography and performance without compromise.",
      specs: { Display: "6.5\" OLED 120Hz", Camera: "50MP triple system", Chipset: "PulseCore 9", Storage: "256GB", Battery: "4500 mAh", Charging: "65W fast charge" }
    },
    {
      id: 5, name: "Pulse Lite Smartphone", brand: "Pulse", category: "Phones",
      price: 449.00, rating: 4.2, emoji: "📱", stock: 0,
      description: "All the Pulse essentials at an approachable price. Great battery life, a crisp display, and a dependable dual camera for everyday shots.",
      specs: { Display: "6.4\" LCD 90Hz", Camera: "48MP dual system", Chipset: "PulseCore 6", Storage: "128GB", Battery: "5000 mAh", Charging: "33W fast charge" }
    },
    {
      id: 6, name: "Pulse Ultra 5G", brand: "Pulse", category: "Phones",
      price: 1199.00, rating: 4.9, emoji: "📱", stock: 8,
      description: "The most advanced Pulse ever. A quad-camera array, titanium frame, and the fastest chipset in the lineup for those who want it all.",
      specs: { Display: "6.8\" LTPO OLED 120Hz", Camera: "108MP quad system", Chipset: "PulseCore 9 Ultra", Storage: "512GB", Battery: "5000 mAh", Charging: "100W fast charge" }
    },
    {
      id: 7, name: "EchoBuds Pro", brand: "Echo", category: "Audio",
      price: 199.00, rating: 4.6, emoji: "🎧", stock: 60,
      description: "True-wireless earbuds with adaptive active noise cancellation and rich, balanced sound. Compact charging case with wireless charging.",
      specs: { Type: "In-ear true wireless", "Noise cancelling": "Adaptive ANC", Battery: "6h + 24h case", Connectivity: "Bluetooth 5.3", "Water resistance": "IPX4", Charging: "USB-C + Qi wireless" }
    },
    {
      id: 8, name: "SonicWave Headphones", brand: "Sonic", category: "Audio",
      price: 279.00, rating: 4.7, emoji: "🎧", stock: 18,
      description: "Over-ear wireless headphones with plush memory-foam cushions and studio-grade drivers for immersive, fatigue-free listening.",
      specs: { Type: "Over-ear wireless", "Noise cancelling": "Hybrid ANC", Battery: "Up to 40 hours", Connectivity: "Bluetooth 5.2", Drivers: "40mm dynamic", Weight: "255 g" }
    },
    {
      id: 9, name: "BoomBox Mini Speaker", brand: "Boom", category: "Audio",
      price: 89.00, rating: 4.3, emoji: "🔊", stock: 33,
      description: "A pocket-sized Bluetooth speaker with surprising punch. Rugged, waterproof, and ready for the beach, the trail, or the shower.",
      specs: { Type: "Portable Bluetooth", Output: "12W", Battery: "Up to 12 hours", "Water resistance": "IP67", Connectivity: "Bluetooth 5.1", Weight: "540 g" }
    },
    {
      id: 10, name: "Vortex Console X", brand: "Vortex", category: "Gaming",
      price: 499.00, rating: 4.8, emoji: "🎮", stock: 0,
      description: "The next-gen Vortex Console X delivers 4K gaming at up to 120fps, near-instant load times, and a huge library of titles.",
      specs: { Resolution: "Up to 4K 120fps", Storage: "1TB SSD", Memory: "16GB GDDR6", "Optical drive": "4K UHD Blu-ray", Ports: "HDMI 2.1, 3x USB", Output: "8K ready" }
    },
    {
      id: 11, name: "Vortex Wireless Pad", brand: "Vortex", category: "Gaming",
      price: 69.00, rating: 4.4, emoji: "🎮", stock: 50,
      description: "A precision wireless controller with textured grips, haptic triggers, and a rechargeable battery that lasts through marathon sessions.",
      specs: { Connectivity: "Wireless + USB-C", Battery: "Up to 30 hours", Feedback: "Haptic triggers", Compatibility: "Console X, PC", "3.5mm jack": "Yes", Weight: "280 g" }
    },
    {
      id: 12, name: "RayCast 4K Monitor", brand: "RayCast", category: "Gaming",
      price: 549.00, rating: 4.6, emoji: "🖥️", stock: 9,
      description: "A 27-inch 4K gaming monitor with a 144Hz refresh rate, 1ms response and HDR for crisp, tear-free, vibrant gameplay.",
      specs: { Size: "27\" IPS", Resolution: "3840 × 2160 (4K)", "Refresh rate": "144Hz", "Response time": "1ms", HDR: "DisplayHDR 600", Ports: "HDMI 2.1, DisplayPort" }
    },
    {
      id: 13, name: "HomeHub Smart Speaker", brand: "HomeHub", category: "Smart Home",
      price: 129.00, rating: 4.1, emoji: "🏠", stock: 22,
      description: "A voice-controlled smart speaker that plays your music, answers questions, and controls your smart home — all hands-free.",
      specs: { Assistant: "Built-in voice AI", Audio: "360° room-filling", Connectivity: "Wi-Fi + Bluetooth", "Smart home": "Matter / Thread hub", Mics: "4 far-field", Power: "AC powered" }
    },
    {
      id: 14, name: "GlowBulb Smart Light", brand: "Glow", category: "Smart Home",
      price: 29.00, rating: 4.0, emoji: "💡", stock: 120,
      description: "A color-changing smart bulb with 16 million colors, schedules and voice control. Set the perfect mood from your phone.",
      specs: { Colors: "16 million", Brightness: "800 lumens", Connectivity: "Wi-Fi (no hub)", Control: "App + voice", Lifespan: "25,000 hours", Fitting: "E27 / A19" }
    },
    {
      id: 15, name: "SecureCam 2K", brand: "Secure", category: "Smart Home",
      price: 149.00, rating: 4.5, emoji: "📷", stock: 14,
      description: "A 2K indoor security camera with night vision, motion alerts and two-way audio. Keep an eye on home from anywhere.",
      specs: { Resolution: "2K (2304 × 1296)", "Night vision": "Infrared, 10m", Field: "130° wide angle", Audio: "Two-way", Storage: "microSD + cloud", Connectivity: "Wi-Fi" }
    },
    {
      id: 16, name: "ChronoWatch Series 6", brand: "Chrono", category: "Wearables",
      price: 399.00, rating: 4.7, emoji: "⌚", stock: 16,
      description: "A premium smartwatch with advanced health tracking, GPS and an always-on display. Your fitness coach and daily assistant on your wrist.",
      specs: { Display: "1.9\" AMOLED always-on", Health: "ECG, SpO2, heart rate", GPS: "Dual-band", Battery: "Up to 36 hours", "Water resistance": "50m", Connectivity: "Bluetooth + LTE" }
    },
    {
      id: 17, name: "FitBand Active", brand: "Chrono", category: "Wearables",
      price: 99.00, rating: 4.2, emoji: "⌚", stock: 45,
      description: "A slim fitness band that tracks steps, sleep and workouts with a week-long battery. Motivation you can wear all day.",
      specs: { Display: "1.1\" AMOLED", Health: "Heart rate, sleep, SpO2", Battery: "Up to 7 days", "Water resistance": "5 ATM", Modes: "30+ sport modes", Weight: "24 g" }
    },
    {
      id: 18, name: "PowerCell 20K Battery", brand: "PowerCell", category: "Accessories",
      price: 49.00, rating: 4.6, emoji: "🔋", stock: 80,
      description: "A 20,000mAh power bank with fast charging and three ports. Keep your phone, tablet and earbuds topped up on the go.",
      specs: { Capacity: "20,000 mAh", Output: "65W USB-C PD", Ports: "2x USB-C, 1x USB-A", Input: "USB-C fast recharge", Display: "LED charge level", Weight: "355 g" }
    },
  ];

  // ---- Shared helpers ----
  // Indonesian Rupiah: "Rp " prefix, thousands dots, no decimal cents.
  const money = n => "Rp " + Math.round(Number(n) || 0).toLocaleString("id-ID");
  const getProduct = id => PRODUCTS.find(p => p.id === Number(id));
  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function loadCart() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
    catch { return {}; }
  }
  function saveCart(cart) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
  }
  function clearCart() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // Resolve the raw cart map into product line items.
  function cartEntries(cart) {
    cart = cart || loadCart();
    return Object.entries(cart)
      .map(([id, qty]) => ({ product: getProduct(id), qty }))
      .filter(e => e.product);
  }

  // Load the catalog from the API, replacing the fallback data.
  async function loadProducts() {
    const res = await fetch(`${API_BASE}/products`);
    if (!res.ok) throw new Error(`Failed to load products (HTTP ${res.status})`);
    PRODUCTS = await res.json();
    return PRODUCTS;
  }

  // The effective (charged) price for a product — the promotional price when a
  // valid sale is active, else the regular price. Mirrors the server's
  // authoritative rule (the backend still recomputes totals on checkout).
  function priceOf(product) {
    const price = Number(product.price);
    const sale = product.salePrice == null ? null : Number(product.salePrice);
    if (product.effectivePrice != null) return Number(product.effectivePrice);
    return sale != null && sale >= 0 && sale < price ? sale : price;
  }

  // The single source of truth for order math (used by cart, checkout, summary).
  // Note: this is for DISPLAY only — the server independently recomputes totals
  // from DB prices when the order is placed.
  // `shipping` is supplied by the caller once a delivery zone is known (0 for
  // pickup, or before a kecamatan has been chosen). No tax line any more.
  function computeTotals(cart, shipping = 0) {
    const entries = cartEntries(cart);
    const subtotal = entries.reduce((s, e) => s + e.qty * priceOf(e.product), 0);
    const ship = Number(shipping) || 0;
    const total = +(subtotal + ship).toFixed(2);
    const count = entries.reduce((s, e) => s + e.qty, 0);
    return { entries, subtotal, shipping: ship, total, count };
  }

  global.VoltEdge = {
    STORAGE_KEY, CONFIG,
    get PRODUCTS() { return PRODUCTS; },
    money, esc, getProduct, loadProducts, priceOf,
    loadCart, saveCart, clearCart, cartEntries, computeTotals,
  };
})(window);
