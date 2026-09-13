-- ============================================================================
-- Migration 015 — Aftersales service (warranty claims + returns/exchanges)
-- ADDITIVE / idempotent. New table only; nothing existing is touched.
--
-- The id is a human-friendly tracking code the customer quotes back to us
-- (AS-<base36 time>-<random>), in the same style as the order ids (VE-…).
-- ============================================================================

CREATE TABLE IF NOT EXISTS aftersales_requests (
  id             TEXT        PRIMARY KEY,
  order_id       TEXT        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  type           TEXT        NOT NULL CHECK (type IN ('warranty_claim', 'return_exchange')),
  -- Which item in the order this is about. Null = the order as a whole (and
  -- SET NULL rather than CASCADE so a delisted product doesn't erase the case).
  product_id     INTEGER     REFERENCES products (id) ON DELETE SET NULL,
  -- Contact details, snapshotted: aftersales works without a customer login,
  -- so the order id + email pair is what verifies the requester.
  customer_name  TEXT        NOT NULL,
  customer_email TEXT        NOT NULL,
  description    TEXT        NOT NULL,
  -- Evidence photos: [{ "url": "...", "publicId": "..." }] — the URL is a
  -- Cloudinary secure_url, the publicId lets us delete the asset later.
  photo_urls     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Happy path: submitted → under_review → approved → processing → completed.
  -- rejected is a terminal state off to the side (like cancelled for orders).
  status         TEXT        NOT NULL DEFAULT 'submitted'
                   CHECK (status IN ('submitted', 'under_review', 'approved', 'rejected', 'processing', 'completed')),
  -- Written by staff, shown to the customer on the tracking page.
  admin_notes    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin list is filtered by status/type and sorted newest first.
CREATE INDEX IF NOT EXISTS idx_aftersales_status  ON aftersales_requests (status);
CREATE INDEX IF NOT EXISTS idx_aftersales_type    ON aftersales_requests (type);
CREATE INDEX IF NOT EXISTS idx_aftersales_created ON aftersales_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aftersales_order   ON aftersales_requests (order_id);
-- Case-insensitive lookups by the customer's email.
CREATE INDEX IF NOT EXISTS idx_aftersales_email   ON aftersales_requests (lower(customer_email));

-- Keep updated_at fresh (uses the helper defined in schema.sql).
DROP TRIGGER IF EXISTS trg_aftersales_updated_at ON aftersales_requests;
CREATE TRIGGER trg_aftersales_updated_at
  BEFORE UPDATE ON aftersales_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
