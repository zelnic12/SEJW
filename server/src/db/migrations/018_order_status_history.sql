-- ============================================================================
-- Migration 018 — Order status history
-- One row per status change, so the admin order detail can show a timeline of
-- how an order moved through the pipeline instead of just its current stage.
-- ADDITIVE / idempotent.
--
-- Deliberately NOT backfilled: orders placed before this migration have no
-- recorded transitions, and inventing timestamps for them would be fiction.
-- The detail view flags those orders instead (see admin/views/orders.js).
-- ============================================================================

CREATE TABLE IF NOT EXISTS order_status_history (
  id         SERIAL      PRIMARY KEY,
  order_id   TEXT        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  status     TEXT        NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The timeline is always read as "all rows for one order, oldest first".
CREATE INDEX IF NOT EXISTS idx_order_status_history_order
  ON order_status_history (order_id, changed_at, id);
