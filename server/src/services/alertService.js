import { AccountSecurity, SecurityAlert, User } from '../models/index.js';
import { ALERT_RETENTION_DAYS } from '../models/SecurityAlert.js';
import { getConfig } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { sendMail } from './mailService.js';

/**
 * Administrator alerts (SPEC (ح)).
 *  - Every alert is an in-app notice on the security page.
 *  - severity "security" also sends an email at once (at most one per alert
 *    per hour, so a burst becomes one email).
 *  - Every alert is a line in the end-of-day email (cron, 18:00 UTC).
 *  - Repeats (same key, unread, within 24 h) are merged: count + lastAt.
 * Raising an alert never throws: a failure is logged only.
 */

const MERGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const EMAIL_THROTTLE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const ROLE_LABELS = { admin: 'الأدمن', moderator: 'مودريتور', courier: 'مندوب' };

export function actorLabel(user) {
  if (!user) return 'النظام';
  return `${user.name} (${ROLE_LABELS[user.role] || user.role})`;
}

/** The verified personal email of the administrator, or null. */
export async function adminAlertEmail() {
  const admin = await User.findOne({ role: 'admin' }).select('_id').lean();
  if (!admin) return null;
  const sec = await AccountSecurity.findOne({ user: admin._id }).select('email emailVerifiedAt').lean();
  return sec?.email && sec.emailVerifiedAt ? sec.email : null;
}

function appLink(path = '/admin/security') {
  const origin = getConfig().clientOrigins[0];
  return origin ? `${origin}${path}` : '';
}

async function emailNow(alert) {
  const to = await adminAlertEmail();
  if (!to) return { ok: false, reason: 'NO_VERIFIED_EMAIL' };
  const times = alert.count > 1 ? ` (تكرر ${alert.count} مرات)` : '';
  return sendMail({
    to,
    subject: 'تنبيه أمني من نظام سوليتا',
    text: `${alert.message}${times}\n\nالوقت: ${new Date(alert.lastAt).toISOString()}\nالمنفّذ: ${alert.actor?.name || 'النظام'}\n\nراجع صفحة «الأمان والتنبيهات»: ${appLink()}\n\nإن لم تكن أنت، غيّر كلمة المرور فورًا.`,
  });
}

/**
 * @param {object} a
 * @param {string} a.type     machine type, e.g. "login_locked"
 * @param {string} a.message  short Arabic line (never a customer phone)
 * @param {object} [a.actor]  the user who caused it (null = system)
 * @param {string} [a.key]    merge key (default type + actor)
 * @param {'security'|'normal'} [a.severity]
 */
export async function raiseAlert({ type, message, actor = null, key, severity = 'normal' }) {
  try {
    const now = new Date();
    const mergeKey = key || `${type}:${actor?._id || 'system'}`;
    const actorDoc = actor ? { user: actor._id, name: actor.name, role: actor.role } : { user: null, name: 'النظام', role: 'system' };
    let alert = await SecurityAlert.findOneAndUpdate(
      { key: mergeKey, readAt: null, firstAt: { $gte: new Date(now - MERGE_WINDOW_MS) } },
      // A merged repeat shows up again in the next end-of-day email.
      { $inc: { count: 1 }, $set: { lastAt: now, message, actor: actorDoc, digestedAt: null } },
      { returnDocument: 'after' },
    );
    if (!alert) {
      alert = await SecurityAlert.create({
        key: mergeKey,
        type,
        severity,
        message,
        actor: actorDoc,
        firstAt: now,
        lastAt: now,
        expiresAt: new Date(now.getTime() + ALERT_RETENTION_DAYS * DAY_MS),
      });
    }
    if (severity === 'security' && (!alert.emailedAt || now - alert.emailedAt > EMAIL_THROTTLE_MS)) {
      // Claim the email slot first so concurrent repeats do not all send.
      const claimed = await SecurityAlert.updateOne(
        { _id: alert._id, emailedAt: alert.emailedAt ?? null },
        { $set: { emailedAt: now } },
      );
      if (claimed.modifiedCount) await emailNow(alert);
    }
    return alert;
  } catch (err) {
    logger.warn('Failed to raise alert', { type, error: err.message });
    return null;
  }
}

export async function listAlerts({ limit = 50 } = {}) {
  const [items, unread] = await Promise.all([
    SecurityAlert.find({}).sort({ lastAt: -1 }).limit(Math.min(limit, 200)).lean(),
    SecurityAlert.countDocuments({ readAt: null }),
  ]);
  return {
    unread,
    items: items.map((a) => ({
      id: String(a._id),
      type: a.type,
      severity: a.severity,
      message: a.message,
      actorName: a.actor?.name || null,
      count: a.count,
      firstAt: a.firstAt,
      lastAt: a.lastAt,
      read: Boolean(a.readAt),
    })),
  };
}

export function unreadAlertCount() {
  return SecurityAlert.countDocuments({ readAt: null });
}

export async function markAlertsRead() {
  await SecurityAlert.updateMany({ readAt: null }, { $set: { readAt: new Date() } });
}

/**
 * End-of-day email: every alert not yet in a digest. Sends nothing when
 * there is nothing new. Alerts are claimed before sending (a retried cron
 * finds nothing) and released again if the email fails.
 */
export async function sendDailyDigest(now = new Date()) {
  const pending = await SecurityAlert.find({ digestedAt: null, lastAt: { $lte: now } }).sort({ lastAt: 1 }).limit(200).lean();
  if (!pending.length) return { sent: false, reason: 'NOTHING_NEW', count: 0 };
  const to = await adminAlertEmail();
  if (!to) return { sent: false, reason: 'NO_VERIFIED_EMAIL', count: pending.length };
  const ids = pending.map((a) => a._id);
  await SecurityAlert.updateMany({ _id: { $in: ids }, digestedAt: null }, { $set: { digestedAt: now } });
  const lines = pending.map((a) => {
    const times = a.count > 1 ? ` (×${a.count})` : '';
    const mark = a.severity === 'security' ? '[أمني] ' : '';
    return `- ${mark}${a.message}${times}`;
  });
  // Phase 6 adds the open-tickets block here (counts and numbers only).
  const result = await sendMail({
    to,
    subject: `ملخص تنبيهات سوليتا اليوم (${pending.length})`,
    text: `تنبيهات اليوم:\n\n${lines.join('\n')}\n\nالتفاصيل: ${appLink()}`,
  });
  if (!result.ok) {
    await SecurityAlert.updateMany({ _id: { $in: ids }, digestedAt: now }, { $set: { digestedAt: null } });
    return { sent: false, reason: result.reason, count: pending.length };
  }
  return { sent: true, count: pending.length };
}
