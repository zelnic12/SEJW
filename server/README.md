# VoltEdge — Backend API

A Node.js + Express REST API for the VoltEdge electronics store. It manages
products and orders, recomputes order totals server-side, and serves the static
frontend.

## Requirements

- Node.js ≥ 18

## Install & run

```bash
cd server
npm install
npm start        # starts on http://localhost:3000
# or: npm run dev   (auto-restart on file changes)
```

The server requires a PostgreSQL database (see **Database** below). On boot it
applies the schema automatically; seed the catalog with `npm run seed`.

Once running:

- Storefront: <http://localhost:3000/>
- API base:   <http://localhost:3000/api>
- Health:     <http://localhost:3000/api/health>

## Database (PostgreSQL)

Data is persisted in **PostgreSQL**. All data access goes through `src/store.js`,
which queries the DB via a shared connection pool (`src/db/pool.js`).

### Schema

Five tables (`src/db/schema.sql`):

- **products** — catalog (price/stock/specs as JSONB), with `updated_at` trigger.
- **product_images** — many images per product (`ON DELETE CASCADE`), ordered by `position`.
  `url` holds the Cloudinary HTTPS URL, `cloudinary_public_id` the id used to delete the asset.
- **customers** — deduplicated by unique `email`; upserted on each order.
- **orders** — public order id as PK, a **shipping snapshot**, and server-computed amounts.
- **order_items** — line items per order with **snapshotted** product name/price.

### Configuration

Connection settings come from the environment — either a single `DATABASE_URL`
or discrete vars:

```bash
# Option A
export DATABASE_URL=postgres://user:pass@localhost:5432/voltedge
# Option B
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=voltedge
```

### First-time setup

```bash
createdb voltedge          # create the database
npm run db:setup           # apply schema (migrate) + load catalog (seed)
npm start                  # migrations also run automatically on boot
```

- `npm run migrate` — apply `schema.sql` (idempotent).
- `npm run seed` — reset product tables and load the catalog + a placeholder image per product.

> **Running Postgres in the dev sandbox:** a helper is provided at
> `scripts/pg-start.sh` (initialises and starts a local PG 15 cluster and
> creates the `voltedge` database).

## Image storage (Cloudinary)

Product and banner images are stored in **Cloudinary**, not on the server's disk,
so uploads survive redeploys on hosts with an ephemeral filesystem (Railway,
Render, Fly…). Multer keeps the upload in memory and the buffer is streamed
straight to Cloudinary; the database stores only the returned `secure_url` plus
the `public_id` needed to delete the asset again.

```bash
export CLOUDINARY_CLOUD_NAME=your-cloud
export CLOUDINARY_API_KEY=...
export CLOUDINARY_API_SECRET=...
# optional, default "sinar-elektronik" — root folder for uploaded assets
export CLOUDINARY_FOLDER=sinar-elektronik
```

- The SDK is configured once in `src/cloudinary.js`; nothing else calls `cloudinary.config()`.
- Shared upload rules live in `src/upload.js`: **JPG / PNG / WebP only, max 5 MB**,
  validated (including a magic-byte check) *before* anything is sent to Cloudinary.
- Uploads land in `<CLOUDINARY_FOLDER>/products` and `<CLOUDINARY_FOLDER>/banners`.
- Deleting or replacing an image also deletes the Cloudinary asset, so nothing
  orphans. Asset cleanup is best effort and never fails the request.
- **Without credentials** the app still boots and serves everything; only upload
  routes respond `503` with a clear message.

| Response | When |
|---|---|
| `400` | wrong type, mislabelled file, larger than 5 MB, or no file at all |
| `502` | Cloudinary refused/dropped the upload |
| `503` | `CLOUDINARY_*` env vars are not set |

### Migrating pre-Cloudinary images

Images uploaded before this change are still referenced as `/uploads/...` and are
served by a legacy `express.static` mount, so existing links keep working. To move
them over:

```bash
npm run migrate:images -- --dry-run   # report what would move
npm run migrate:images                # upload + rewrite the DB rows
```

Re-runnable and non-destructive: rows already on Cloudinary are skipped, missing
files are reported and skipped, and local files are left on disk. Once every row
is migrated you can delete `server/uploads/` and the `/uploads` mount in
`src/index.js`.

## Payments (Midtrans Snap — QRIS)

Checkout uses the official [`midtrans-client`](https://www.npmjs.com/package/midtrans-client)
Snap API. When an order is placed, the server creates a Snap transaction using
the order's id as `order_id` and the **server-computed total** as `gross_amount`,
and returns a `snapToken` + `redirectUrl` the frontend can use to open the
Midtrans payment popup. Only **QRIS** channels are enabled.

Configure via environment (see `.env.example`; never hardcode keys):

```bash
MIDTRANS_SERVER_KEY=      # from Midtrans dashboard → Access Keys
MIDTRANS_CLIENT_KEY=      # publishable key (sent to the browser for the popup)
MIDTRANS_IS_PRODUCTION=false   # default sandbox; set true ONLY in production
# optional — override enabled channels (default QRIS-only):
# MIDTRANS_ENABLED_PAYMENTS=gopay,other_qris
```

Behaviour:

- **No `MIDTRANS_SERVER_KEY`** → gateway is disabled. Orders are still placed
  (with `payment_status = 'unconfigured'`, no token) so local dev/demos work
  without live credentials. `POST /api/orders` reports this as
  `paymentRequired: false`, and the confirmation screen says *"Order received"*
  with an **Amount due** — it never claims a payment was received.
- **`MIDTRANS_IS_PRODUCTION` defaults to `false`** (sandbox), so local dev never
  accidentally hits production.
- **A gateway error during checkout is fatal to the request.** Without a Snap
  token there is nothing for the customer to pay against, so the server does not
  answer `201`. Instead it cancels the order (`status = 'cancelled'`,
  `payment_status = 'failed'`), releases the reserved stock, raises no "new order"
  notification, and returns **`502`** with
  `{ error: "Gagal memproses pembayaran, coba lagi atau hubungi kami.", paymentFailed: true, orderId }`.
  The customer sees that message with their cart intact and can retry.
- The Snap token + status are stored on the order (`payment_token`,
  `payment_redirect_url`, `payment_status`).
- **Only the webhook marks an order paid.** `payment_status = 'paid'` is written
  in exactly one place (`store.applyPaymentNotification`, called only from the
  signature-verified `POST /api/payments/notification`). Nothing in the browser
  can put an order into a paid state.

### Testing the payment failure path

```bash
npm run test:payment-failure
```

Boots the API with the gateway enabled behind a stub key and forces
`snap.createTransaction()` to fail — the automated equivalent of temporarily
configuring an invalid key — then asserts the order ends up clearly failed and
never silently paid (API status, DB state, admin detail, invoice JSON and the
rendered invoice PDF). It also runs a control case with a working token to check
the happy path still reaches `awaiting_payment`.

It writes real rows, so point it at a throwaway database:

```bash
npm run db:setup && npm run test:payment-failure
```

## API reference

### Products

| Method | Path | Description | Success |
|--------|------|-------------|---------|
| GET    | `/api/products`      | List all products | 200 |
| GET    | `/api/products/:id`  | Get one product | 200 / 404 |
| POST   | `/api/products`      | Create a product | 201 |
| PUT    | `/api/products/:id`  | Update a product (partial allowed) | 200 / 404 |
| DELETE | `/api/products/:id`  | Delete a product | 204 / 404 |

**Product body** (POST requires `name`, `price`, `stock`):

```json
{
  "name": "Example Gadget",
  "brand": "Example",
  "category": "Accessories",
  "price": 49.99,
  "stock": 10,
  "emoji": "📦",
  "rating": 4.5,
  "description": "…",
  "specs": { "Weight": "300 g" }
}
```

### Orders

| Method | Path | Description | Success |
|--------|------|-------------|---------|
| POST   | `/api/orders`            | Place an order | 201 |
| GET    | `/api/orders`            | List all orders | 200 |
| GET    | `/api/orders/:id`        | Get one order | 200 / 404 |
| PATCH  | `/api/orders/:id/status` | Update fulfilment status | 200 / 404 |

`PATCH .../status` body: `{ "status": "pending" | "paid" | "shipped" | "cancelled" }`.

**Order body:**

```json
{
  "customer": {
    "name": "Jane Doe",
    "email": "jane@example.com",
    "phone": "555-123-4567",
    "address": "1 Main St",
    "city": "Metropolis",
    "postal": "12345",
    "country": "USA"
  },
  "items": [
    { "id": 7, "qty": 2 },
    { "id": 9, "qty": 1 }
  ]
}
```

Server-side behaviour when placing an order:

- Validates the customer fields and item quantities.
- Checks each item against **real product stock** (returns `409` if insufficient).
- **Recomputes totals on the server** — subtotal, shipping (free over $100,
  otherwise $9.99), 8% estimated tax, and total. Client-supplied amounts are
  never trusted.
- Persists the order and **decrements stock**.

### Authentication (admin)

The admin API and dashboard are protected by JWT-based auth.

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/api/auth/login` | Exchange `{ username, password }` for a JWT | public |
| GET  | `/api/auth/me`    | Return the current admin (validates token) | Bearer token |

Send the token as `Authorization: Bearer <token>` on protected requests.

**Configuration (env):**

- `JWT_SECRET` — token signing secret (**set this in production**; a dev fallback is used otherwise).
- `JWT_TTL` — token lifetime (default `8h`).
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_NAME` — seed/bootstrap credentials
  (defaults `admin` / `admin123`). Set a real password before deploying.

On boot the server **bootstraps a default admin** if none exists, so you always
have a way in. Seed/reset explicitly with `npm run seed:admin`.

**Route protection:**

- **Public:** `GET /api/products`, `GET /api/products/:id`, `POST /api/orders` (checkout).
- **Admin only (401 without a valid token):** product `POST`/`PUT`/`DELETE`,
  `GET /api/orders`, `GET /api/orders/:id`, `PATCH /api/orders/:id/status`, and all `/api/analytics/*`.

### Analytics (admin dashboard)

Read-only aggregate endpoints powering `/admin.html` (all require a Bearer token).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/analytics/summary`           | Revenue, order count, AOV, units, customers |
| GET | `/api/analytics/best-sellers?limit=` | Top products by units sold |
| GET | `/api/analytics/sales-by-category` | Revenue/units grouped by category |
| GET | `/api/analytics/sales-by-brand`    | Revenue/units grouped by brand |
| GET | `/api/analytics/timeseries?bucket=day\|week\|month&points=` | Revenue/orders time series |
| GET | `/api/analytics/low-stock?threshold=` | Products at/below a stock threshold |
| GET | `/api/analytics/overview`          | Everything above in one call (dashboard landing) |

> Seed demo orders for meaningful analytics with `npm run seed:orders`
> (or `npm run db:demo` to migrate + seed products + seed orders in one go).

### Categories + custom icons

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/categories` | — | Every category in the catalog: `name`, `productCount`, `iconUrl` (null = generic icon) |
| PUT | `/api/categories/:name/icon` | JWT | Upload/replace the category's icon (multipart, field `icon`) |
| DELETE | `/api/categories/:name/icon` | JWT | Clear it, reverting to the generic icon |

Categories are **not** records: which ones exist is still derived from the distinct
`products.category` values. `category_icons` (migration 016) only holds an optional
image override per category name, so:

- renaming a category on its products immediately changes the list, and an icon row
  for a name nothing uses no longer appears anywhere;
- a category with no row falls back to the built-in generic icon.

Matching is case-insensitive (a unique index on `lower(category_name)` stops
"Audio" and "audio" holding competing icons). Uploads reuse the shared Cloudinary
pipeline and validation (JPG/PNG/WebP, 5 MB, magic-byte check); replacing or
clearing an icon deletes the Cloudinary asset it replaced. Uploading for a category
no product uses returns `404`.

The storefront's "Browse by category" row renders the photo cropped into the
existing circle (`object-fit: cover`) and always keeps the category name and item
count text below it.

### Bulk product import (admin)

Three JWT-protected steps behind the dashboard's **Import products** wizard. The
parsed rows travel back to the browser between steps, so the server keeps no
import state and nothing is written to disk.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/admin/imports/products/parse`   | Multipart `.xlsx`/`.xls`/`.csv` → headers, rows, and a suggested column mapping |
| POST | `/api/admin/imports/products/preview` | Dry run: per-row parsed values, warnings, errors and duplicate flags |
| POST | `/api/admin/imports/products/commit`  | Inserts the importable rows and returns a full report |

- **Parsing** uses `exceljs`. The first row with two or more filled cells is the
  header row, so leading title/instruction rows in a Shopee export are skipped.
  Limits: 10 MB, 5,000 rows.
- **Column mapping** is guessed from Indonesian and English header aliases
  (`Nama Produk`, `Harga`, `Stok`, `Link Gambar`, `Product Name`, `Price`…) but
  always confirmed by the admin. Unmapped columns are ignored, so extra Shopee
  variant/SKU columns need no attention. Only **name** and **price** must be mapped.
- **Messy values** are cleaned before parsing: `Rp 285.000` → `285000`,
  `Rp1.250.500,00` → `1250500`, `3 pcs` → `3`. A lone separator followed by
  exactly three digits is treated as a thousands separator. The preview shows the
  original text next to the parsed number so surprises are visible.
- **Rows are classified, never dropped silently**: `ready`, `duplicate`
  (case-insensitive name match against the catalog or an earlier row in the same
  file), `error` (missing/unreadable name or price), or `empty` (blank row or a
  repeated header row). Preview and commit share the same normaliser, so the
  preview is exactly what commit does.
- **Images** are best effort: a mapped URL column is fetched (8s timeout, 5 MB
  cap, image content-type + magic-byte check, private-address hosts refused) and
  uploaded through the existing Cloudinary helper. Any failure still imports the
  product and flags it `needs an image` in the report — capped at 250 image
  fetches per import.

`src/import/products.js` holds the pure logic (parsing, alias matching, number
cleaning, row classification); `src/routes/imports.js` orchestrates.

### Aftersales (warranty claims + returns/exchanges)

Customers don't have accounts, so the **order id + the email on that order** is the
credential for opening a request (the same gate the verified-purchase review check
uses), and the returned **tracking code** is the key for looking one up afterwards.
There is deliberately no public endpoint that lists requests.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/aftersales/verify-order` | — | Check an order id + email, and list that order's items |
| POST | `/api/aftersales`              | — | Open a request (multipart; `photos` optional, up to 5) |
| GET  | `/api/aftersales/:id`          | — | Track one request by its tracking code |
| GET  | `/api/admin/aftersales?type=&status=` | JWT | All requests + per-status counts |
| GET  | `/api/admin/aftersales/:id`    | JWT | Full detail incl. the linked order and allowed next statuses |
| PATCH | `/api/admin/aftersales/:id`   | JWT | Move the status and/or write customer-visible notes |

- **Order eligibility**: only `shipped` and `completed` orders can be claimed
  against — anything else is refused with a message explaining why.
- **Workflow**: `submitted → under_review → approved → processing → completed`,
  with `rejected` as a terminal branch (like `cancelled` for orders). Invalid
  jumps are rejected with a `400` naming the allowed next steps; the admin UI only
  renders the transitions the server permits.
- **Evidence photos** reuse the Cloudinary flow (`<CLOUDINARY_FOLDER>/aftersales`);
  the DB stores the URL + `public_id`, and an upload is rolled back if the insert
  fails. Requests without photos work even when Cloudinary isn't configured.
- **`admin_notes`** is written by staff and shown to the customer on the tracking
  page. The public payload masks the email and never exposes Cloudinary ids.

Storefront: `/aftersales.html` (request form + tracking timeline), linked from the
footer of every page and from the order confirmation screen.

## Error responses

Errors are JSON: `{ "error": "…", "details": [ … ] }`.

- `400` — validation failed / invalid JSON
- `404` — resource not found
- `409` — order rejected (e.g. insufficient stock)
- `500` — internal error
