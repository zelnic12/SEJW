# Sinar Elektronik — Full-Stack Electronics Store

A retail electronics store with a customer storefront, a checkout flow, a
Node.js + Express REST API, a PostgreSQL database, and an **admin dashboard**.

## Features

### Storefront (customer)
- **Product catalog** loaded from the API, with live search, category filters, and sorting.
- **Product detail** view with specs, stock status, and quantity selector.
- **Slide-out cart** with quantity controls, subtotal/shipping/total, and `localStorage` persistence.
- **Checkout page** — customer + shipping form, order summary, server-validated order placement, and a confirmation screen. Payment is behind a swappable `PaymentProvider` interface.
- Fully responsive dark-theme UI.

### Admin dashboard (`/admin.html`)
- **Login-protected** — JWT auth gates the dashboard and admin API (demo login `admin` / `admin123`).
- **Overview** — KPI cards (revenue, orders, units, customers), a 30-day sales chart, best-sellers, revenue-by-category, and low-stock alerts.
- **Product management** — add, edit, delete, and quick stock adjustments.
- **Order management** — browse orders, view details, and update fulfilment status.
- **Sales performance** — revenue/tax/shipping stats, best-selling products, revenue by category and brand, and a **daily / weekly / monthly** sales chart.
- Built from small, reusable ES-module components (stat cards, data table, modal, charts) — no frontend framework or build step.

### Pembukuan (bookkeeping) — admin sidebar
- **Laporan keuangan** — monthly profit & loss across the website, the shop (toko) and Shopee: sales, HPP (cost of goods sold), Shopee fees, expenses and net profit, plus inventory value and best sellers. Downloads as a CSV that opens in Excel.
- **Barang masuk** — record stock bought from suppliers. Stock goes up and the product's moving-average cost (`products.avg_cost`, never exposed by the public API) is updated.
- **Penjualan toko** — record walk-in sales; stock comes off the same products the website sells.
- **Import Shopee** — upload the order export from Shopee Seller Centre (Pesanan Saya → Export). Orders are grouped, cancelled ones skipped, re-uploads de-duplicated by order number, and each Shopee listing is matched to a website product once (by name or model code) and remembered.
- **Pengeluaran** — running costs such as rent, salaries and utilities.

Tables come from migration `021_bookkeeping.sql`, which runs automatically on start. Parser tests: `npm run test:shopee` in `server/`.

### Backend
- **REST API** for products (CRUD), orders (create/list/get/status), and analytics.
- **PostgreSQL** schema: `products`, `product_images`, `customers`, `orders`, `order_items`.
- Order totals are **always recomputed server-side**; stock is validated and decremented atomically.

## Project structure

```
├── index.html, script.js         # storefront
├── checkout.html, checkout.js     # checkout flow
├── cart-core.js                   # shared cart/catalog/totals helpers
├── styles.css                     # shared theme
├── admin.html                     # admin dashboard shell
├── admin/
│   ├── admin.js, admin.css        # dashboard app + styles
│   ├── components/                # reusable: api, format, statCard, dataTable, charts, modal, toast
│   └── views/                     # overview, products, orders, sales
└── server/                        # Express API + PostgreSQL (see server/README.md)
```

## Running locally

The frontend is served by the API server, so one process runs everything.

```bash
cd server
npm install
createdb voltedge
npm run db:demo        # migrate + seed products + seed demo orders (for dashboard data)
npm start              # http://localhost:3000
```

Then open:
- Storefront — <http://localhost:3000/>
- Admin dashboard — <http://localhost:3000/admin.html> (sign in with `admin` / `admin123`)

> Set `JWT_SECRET` and `ADMIN_PASSWORD` before deploying — see [`server/README.md`](server/README.md#authentication-admin).

See [`server/README.md`](server/README.md) for the full API reference and database setup.
