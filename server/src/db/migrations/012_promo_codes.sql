-- ============================================================================
-- Migration 012 — Promo / discount codes
-- ADDITIVE / idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS promo_codes (
  id             SERIAL PRIMARY KEY,
  code           TEXT        NOT NULL,
  discount_type  TEXT        NOT NULL CHECK (discount_type IN ('percentage', 'fixed_amount')),
  discount_value NUMERIC(12,2) NOT NULL CHECK (discount_value >= 0),
  max_uses       INTEGER     CHECK (max_uses IS NULL OR max_uses >= 0),  -- null = unlimited
  used_count     INTEGER     NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at     TIMESTAMPTZ,                                            -- null = no expiry
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness on the code (e.g. SHOPEE15 == shopee15).
CREATE UNIQUE INDEX IF NOT EXISTS uq_promo_codes_code ON promo_codes (lower(code));

-- Record which code (if any) was applied to an order.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS promo_code TEXT;
