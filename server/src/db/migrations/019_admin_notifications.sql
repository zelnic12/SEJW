-- ============================================================================
-- Migration 019 — Admin notifications
-- A feed of things the admin should look at: new orders and new customer chat
-- messages. Rows are written from the existing order/message creation paths.
-- ADDITIVE / idempotent.
--
-- title/body are pre-formatted at write time on purpose: a notification is a log
-- of something that happened, so it should still read correctly after the order
-- or conversation it points at has changed or been deleted.
--
-- reference_id is TEXT because it holds either an order id ("VE-…") or a chat
-- conversation id ("42"), depending on `type`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_notifications (
  id           SERIAL      PRIMARY KEY,
  type         TEXT        NOT NULL CHECK (type IN ('new_order', 'new_message')),
  reference_id TEXT        NOT NULL,
  title        TEXT        NOT NULL,
  body         TEXT        NOT NULL DEFAULT '',
  is_read      BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The feed is always read newest-first.
CREATE INDEX IF NOT EXISTS idx_admin_notifications_created
  ON admin_notifications (created_at DESC, id DESC);

-- The 12s poll only asks for unread rows, so keep that a partial index.
CREATE INDEX IF NOT EXISTS idx_admin_notifications_unread
  ON admin_notifications (id DESC) WHERE is_read = false;
