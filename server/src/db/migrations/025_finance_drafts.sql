-- ============================================================================
-- Migration 025 — Unfinished imports (drafts)
--
-- A Shopee income report is read, then reviewed (product matches, quantities,
-- AC installation) before it is imported. The review is kept here so closing
-- the browser or refreshing doesn't lose it. One draft per kind; it is removed
-- when the import is done or discarded. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS finance_drafts (
  kind        TEXT        PRIMARY KEY,
  data        JSONB       NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
