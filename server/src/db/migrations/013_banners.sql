-- ============================================================================
-- Migration 013 — Homepage hero banners (carousel slides)
-- ADDITIVE / idempotent. Creates a new table only; no existing data touched.
-- ============================================================================

CREATE TABLE IF NOT EXISTS banners (
  id               SERIAL PRIMARY KEY,
  image_url        TEXT,                -- /uploads/banners/<file> or an external URL
  background_color TEXT,                -- fallback when no image is set (e.g. '#C8102E')
  headline         TEXT        NOT NULL,
  subtext          TEXT,
  cta_text         TEXT,                -- null/empty = no button rendered
  cta_link         TEXT,
  position         INTEGER     NOT NULL DEFAULT 0,   -- display order, ascending
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The storefront always reads "active slides in display order".
CREATE INDEX IF NOT EXISTS idx_banners_active_position ON banners (is_active, position, id);
