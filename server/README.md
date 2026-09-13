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
  without live credentials.
- **`MIDTRANS_IS_PRODUCTION` defaults to `false`** (sandbox), so local dev never
  accidentally hits production.
- Gateway errors during checkout are **non-fatal**: the order (with reserved
  stock and fixed totals) is preserved; the client can retry payment.
- The Snap token + status are stored on the order (`payment_token`,
  `payment_redirect_url`, `payment_status`).

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

## Error responses

Errors are JSON: `{ "error": "…", "details": [ … ] }`.

- `400` — validation failed / invalid JSON
- `404` — resource not found
- `409` — order rejected (e.g. insufficient stock)
- `500` — internal error
