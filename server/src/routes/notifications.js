// ---- Admin notifications ----
// Admin-only (requireAuth is applied at the mount point in index.js).
//
//   GET  /api/admin/notifications?unread=true&limit=20  → recent feed + unread count
//   POST /api/admin/notifications/:id/read              → mark one read
//   POST /api/admin/notifications/read-all              → mark everything read
//
// Rows are written by the order route and by store.addChatMessage; nothing here
// creates them, so there's no public write surface.
import { Router } from "express";
import * as store from "../store.js";

const router = Router();

// GET / — newest first. `unread=true` is what the dashboard polls every ~12s.
// unreadCount is always returned so the badge never needs a second request.
router.get("/", async (req, res, next) => {
  try {
    const unreadOnly = req.query.unread === "true" || req.query.unread === "1";
    const notifications = await store.listNotifications({
      unreadOnly,
      limit: req.query.limit,
    });
    res.json({
      notifications,
      unreadCount: await store.countUnreadNotifications(),
    });
  } catch (err) { next(err); }
});

// POST /read-all — declared before /:id/read so "read-all" can't be read as an id.
router.post("/read-all", async (req, res, next) => {
  try {
    const updated = await store.markAllNotificationsRead();
    res.json({ updated, unreadCount: 0 });
  } catch (err) { next(err); }
});

// POST /:id/read — marking an already-read notification again is a no-op.
router.post("/:id/read", async (req, res, next) => {
  try {
    if (!/^\d+$/.test(String(req.params.id))) {
      return res.status(400).json({ error: "Invalid notification id" });
    }
    const notification = await store.markNotificationRead(req.params.id);
    if (!notification) return res.status(404).json({ error: "Notification not found" });
    res.json({
      notification,
      unreadCount: await store.countUnreadNotifications(),
    });
  } catch (err) { next(err); }
});

export default router;
