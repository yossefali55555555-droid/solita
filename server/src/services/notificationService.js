import { Notification } from '../models/index.js';
import { logger } from '../utils/logger.js';

/** Create an in-app notification. Never fails the calling workflow. */
export async function notify(userId, type, message, orderId = null) {
  if (!userId) return null;
  try {
    return await Notification.create({ user: userId, type, message, order: orderId });
  } catch (err) {
    logger.warn('Failed to create notification', { type, error: err.message });
    return null;
  }
}

export async function listNotifications(userId, { unreadOnly = false, limit = 30 } = {}) {
  const filter = { user: userId };
  if (unreadOnly) filter.readAt = null;
  const [items, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({ user: userId, readAt: null }),
  ]);
  return { items, unread };
}

export async function markAllRead(userId) {
  await Notification.updateMany({ user: userId, readAt: null }, { $set: { readAt: new Date() } });
}
