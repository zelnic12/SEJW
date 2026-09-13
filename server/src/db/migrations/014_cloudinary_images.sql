-- ============================================================================
-- Migration 014 — Cloudinary image storage
-- ADDITIVE / idempotent. Records the Cloudinary public_id next to each image URL
-- so the asset can be deleted from Cloudinary when the row is deleted/replaced.
--
-- Existing rows keep a NULL public_id: those are either the "emoji:<char>"
-- placeholders or legacy "/uploads/..." local files, both of which still render.
-- ============================================================================

ALTER TABLE product_images
  ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;

ALTER TABLE banners
  ADD COLUMN IF NOT EXISTS cloudinary_public_id TEXT;
