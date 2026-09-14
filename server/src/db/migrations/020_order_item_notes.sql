-- ============================================================================
-- Migration 020 — Per-item order notes
-- An optional free-text request the customer attaches to a line item at
-- checkout, e.g. a preferred colour or size. Free text rather than a structured
-- choice because variants aren't modelled as product options.
-- ADDITIVE / idempotent.
--
-- Nullable with no default: NULL means "no note", which is the common case, and
-- keeps every pre-existing line item untouched. Length is capped in the order
-- route (200 chars) rather than by a CHECK, so tightening or relaxing the limit
-- later doesn't need a migration against existing rows.
-- ============================================================================

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS note TEXT;
