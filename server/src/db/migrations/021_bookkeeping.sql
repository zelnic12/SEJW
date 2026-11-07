-- ============================================================================
-- Migration 021 — Bookkeeping (pembukuan)
--
-- Adds what the store needs to run its books from the admin dashboard:
--   * products.avg_cost        moving-average purchase cost per unit (modal)
--   * stock_receipts           barang masuk: stock bought from suppliers
--   * expenses                 pengeluaran: rent, salaries, utilities, ...
--   * sales / sale_items       sales that don't go through the website checkout
--                              (walk-in "toko" sales and imported Shopee orders)
--   * shopee_product_links     remembers which website product a Shopee listing
--                              + variation is, so the next import matches itself
--   * order_items.unit_cost    cost snapshot at sale time for website orders
--
-- avg_cost is never exposed by the public product API (mapProduct whitelists
-- fields). Idempotent, like every migration here.
-- ============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS avg_cost NUMERIC(14,2) NOT NULL DEFAULT 0;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_avg_cost_check;
ALTER TABLE products ADD CONSTRAINT products_avg_cost_check CHECK (avg_cost >= 0);

-- Website order lines: what one unit cost the store when it was sold.
-- NULL for orders placed before this migration (the report falls back to the
-- product's current avg_cost for those).
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14,2);

-- ---- Barang masuk ----
CREATE TABLE IF NOT EXISTS stock_receipts (
  id          SERIAL PRIMARY KEY,
  received_on DATE          NOT NULL,
  product_id  INTEGER       NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  quantity    INTEGER       NOT NULL CHECK (quantity > 0),
  unit_cost   NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
  supplier    TEXT          NOT NULL DEFAULT '',
  note        TEXT          NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_receipts_received_on ON stock_receipts (received_on);
CREATE INDEX IF NOT EXISTS idx_stock_receipts_product     ON stock_receipts (product_id);

-- ---- Pengeluaran ----
CREATE TABLE IF NOT EXISTS expenses (
  id          SERIAL PRIMARY KEY,
  spent_on    DATE          NOT NULL,
  category    TEXT          NOT NULL CHECK (char_length(category) >= 1),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  note        TEXT          NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_spent_on ON expenses (spent_on);

-- ---- Penjualan toko + Shopee ----
CREATE TABLE IF NOT EXISTS sales (
  id              SERIAL PRIMARY KEY,
  channel         TEXT          NOT NULL CHECK (channel IN ('toko', 'shopee')),
  -- Shopee "No. Pesanan"; NULL for walk-in sales. Unique per channel so the
  -- same Shopee export can be uploaded twice without double counting.
  external_ref    TEXT,
  sold_at         TIMESTAMPTZ   NOT NULL,
  customer        TEXT          NOT NULL DEFAULT '',
  subtotal        NUMERIC(14,2) NOT NULL CHECK (subtotal >= 0),
  -- Seller-funded discounts (Shopee seller voucher / bundle discount).
  discount        NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  -- Marketplace fees (Shopee admin + service fees), estimated at import.
  marketplace_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (marketplace_fee >= 0),
  note            TEXT          NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (channel, external_ref)
);
CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales (sold_at);

CREATE TABLE IF NOT EXISTS sale_items (
  id           SERIAL PRIMARY KEY,
  sale_id      INTEGER       NOT NULL REFERENCES sales (id) ON DELETE CASCADE,
  -- NULL when the line isn't a stocked product (e.g. an installation service
  -- sold on Shopee) or the product was later deleted.
  product_id   INTEGER       REFERENCES products (id) ON DELETE SET NULL,
  product_name TEXT          NOT NULL,
  quantity     INTEGER       NOT NULL CHECK (quantity > 0),
  unit_price   NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  unit_cost    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0)
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items (sale_id);

-- ---- Shopee listing → website product ----
-- product_id NULL with a row present means "sell without touching stock".
CREATE TABLE IF NOT EXISTS shopee_product_links (
  shopee_name      TEXT        NOT NULL,
  shopee_variation TEXT        NOT NULL DEFAULT '',
  product_id       INTEGER     REFERENCES products (id) ON DELETE CASCADE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shopee_name, shopee_variation)
);
