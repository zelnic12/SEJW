-- ============================================================================
-- Migration 022 — Repair average cost for stock that had no recorded cost
--
-- Until this fix, recording barang masuk for a product that already had stock
-- (e.g. stock entered on the website before bookkeeping existed, avg_cost 0)
-- averaged those units in at Rp 0. Example: 59 units at 0 + 30 units at
-- Rp 2.650.000 gave a cost of Rp 893.258 instead of Rp 2.650.000.
--
-- The code now treats avg_cost 0 as "unknown" and uses the purchase price.
-- This one-time repair recomputes avg_cost from each product's recorded
-- purchases (weighted average) and re-costs the sale lines recorded since
-- bookkeeping started for those products, so HPP and profit are right.
--
-- Migrations re-run on every start, so the repair is guarded by a marker row
-- and only ever applies once.
-- ============================================================================

CREATE TABLE IF NOT EXISTS finance_repairs (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_repairs WHERE name = '022_avg_cost_unknown_stock') THEN
    RETURN;
  END IF;

  CREATE TEMP TABLE repaired_cost ON COMMIT DROP AS
    SELECT product_id,
           ROUND(SUM(quantity * unit_cost) / SUM(quantity), 2) AS avg_cost
      FROM stock_receipts
     GROUP BY product_id
    HAVING SUM(quantity) > 0;

  UPDATE products p
     SET avg_cost = rc.avg_cost
    FROM repaired_cost rc
   WHERE p.id = rc.product_id;

  -- Walk-in and Shopee sale lines for those products
  UPDATE sale_items si
     SET unit_cost = rc.avg_cost
    FROM repaired_cost rc
   WHERE si.product_id = rc.product_id;

  -- Website order lines costed since bookkeeping started (older lines are NULL
  -- and already fall back to the product's current avg_cost)
  UPDATE order_items oi
     SET unit_cost = rc.avg_cost
    FROM repaired_cost rc
   WHERE oi.product_id = rc.product_id
     AND oi.unit_cost IS NOT NULL;

  INSERT INTO finance_repairs (name) VALUES ('022_avg_cost_unknown_stock');
END $$;
