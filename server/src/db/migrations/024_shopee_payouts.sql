-- ============================================================================
-- Migration 024 — Shopee payouts (Laporan Penghasilan)
--
-- The order export has no Shopee fees, so imports estimate them. The income
-- report ("Penghasilan Saya → Sudah Dilepas → Export") has, per order, what
-- Shopee actually released to the seller. Each payout is kept here and, when
-- the order is in the books, sets its real fee:
--   marketplace_fee = (subtotal - discount) - payout
-- Payouts uploaded before their orders are applied when the orders arrive.
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS shopee_payouts (
  order_ref     TEXT          PRIMARY KEY,
  released_on   DATE,
  product_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  payout        NUMERIC(14,2) NOT NULL,
  fees          JSONB         NOT NULL DEFAULT '{}'::jsonb,
  uploaded_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

ALTER TABLE sales ADD COLUMN IF NOT EXISTS payout NUMERIC(14,2);
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payout_on DATE;
-- 'estimate' (percentage at import) or 'actual' (from the income report)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS fee_source TEXT NOT NULL DEFAULT 'estimate';
