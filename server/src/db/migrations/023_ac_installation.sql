-- ============================================================================
-- Migration 023 — AC installation (jasa pasang) on sales
--
-- AC can be sold with installation. The price entered for such a sale covers
-- the AC plus the installer's fee and materials; bookkeeping subtracts that
-- cost from the selling price so the AC's sales and profit are right.
--
--   install_type   none | full (jasa + material) | service (jasa saja)
--                  | material (material saja, "paket tanpa pasang")
--   install_meters pipe/cable length for full and material
--   install_cost   cost per unit at the time of sale (rates can change later)
--
-- Rates live in finance_settings so the admin can change them. Idempotent.
-- ============================================================================

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS install_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS install_meters INTEGER;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS install_cost NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS sale_items_install_type_check;
ALTER TABLE sale_items ADD CONSTRAINT sale_items_install_type_check
  CHECK (install_type IN ('none', 'full', 'service', 'material'));
ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS sale_items_install_cost_check;
ALTER TABLE sale_items ADD CONSTRAINT sale_items_install_cost_check CHECK (install_cost >= 0);

-- A Shopee listing's install package is remembered with its product link.
ALTER TABLE shopee_product_links ADD COLUMN IF NOT EXISTS install_type TEXT NOT NULL DEFAULT 'none';
ALTER TABLE shopee_product_links ADD COLUMN IF NOT EXISTS install_meters INTEGER;

CREATE TABLE IF NOT EXISTS finance_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO finance_settings (key, value) VALUES
  ('install_rates', '{"service": 250000, "pipePerMeter": 75000, "cablePerMeter": 13500, "ductTape": 5000, "drainHose": 5000, "bracket": 34000}')
ON CONFLICT (key) DO NOTHING;
