-- ============================================================================
-- Migration 016 — Custom category icons
-- ADDITIVE / idempotent. New table only.
--
-- Deliberately NOT a categories table: which categories exist is still derived
-- from the distinct products.category values, exactly as before. This table only
-- holds an optional icon override per category name, so a category with no row
-- here simply falls back to the generic built-in icon.
-- ============================================================================

CREATE TABLE IF NOT EXISTS category_icons (
  category_name        TEXT        PRIMARY KEY,   -- matches products.category verbatim
  icon_url             TEXT        NOT NULL,      -- Cloudinary secure_url
  -- Kept so replacing or clearing an icon can delete the old Cloudinary asset.
  cloudinary_public_id TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Category text is compared case-insensitively everywhere else, so don't allow
-- "Audio" and "audio" to hold competing icons.
CREATE UNIQUE INDEX IF NOT EXISTS uq_category_icons_name_lower
  ON category_icons (lower(category_name));

DROP TRIGGER IF EXISTS trg_category_icons_updated_at ON category_icons;
CREATE TRIGGER trg_category_icons_updated_at
  BEFORE UPDATE ON category_icons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
