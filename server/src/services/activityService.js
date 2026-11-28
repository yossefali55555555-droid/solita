import mongoose from 'mongoose';
import { ACTIVITY_GROUPS, RETENTION_DAYS, SENTENCE_VERSION, SEVERITIES } from '../constants/activity.js';
import { Order, StaffActivity, User } from '../models/index.js';
import { sanitizeMetadata } from '../utils/sanitize.js';
import { logger } from '../utils/logger.js';
import { deviceLabel } from '../utils/device.js';

/**
 * Staff activity log writer and reader (SPEC (ز)). Append only.
 * Sentences never carry a phone number: `scrubSentence` replaces anything
 * that looks like one before the row is stored.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STATE_JSON = 1024;
const MAX_SENTENCE = 600;

const DIGIT = '[0-9٠-٩]';
// Egyptian mobile numbers in any common spelling (01x…, 201x…, +201x…, with spaces or dashes).
const EG_MOBILE = new RegExp(`(?<!${DIGIT})(?:\\+?(?:00)?20[\\s-]?|0)?1[0125][\\s-]?${DIGIT}{4}[\\s-]?${DIGIT}{4}(?!${DIGIT})`, 'g');
// Any other run of 9 or more digits (international numbers, ids typed by hand).
const LONG_DIGITS = new RegExp(`\\+?${DIGIT}(?:[\\s-]?${DIGIT}){8,}`, 'g');

/** Replace phone-like numbers with a placeholder, then cut to a safe length. */
export function scrubSentence(text, max = MAX_SENTENCE) {
  const clean = String(text ?? '')
    .replace(EG_MOBILE, '[رقم]')
    .replace(LONG_DIGITS, '[رقم]')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function scrubDeep(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubSentence(value, 200);
  if (typeof value !== 'object' || depth > 3) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrubDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/phone|mobile|tel\b/i.test(k)) continue; // numbers are never logged
    out[k] = scrubDeep(v, depth + 1);
  }
  return out;
}

/** Keep before/after small (about 1KB) and free of secrets and numbers. */
export function clampState(value) {
  if (value === undefined || value === null) return undefined;
  const safe = scrubDeep(sanitizeMetadata(value));
  if (JSON.stringify(safe).length <= MAX_STATE_JSON) return safe;
  return { _truncated: true, keys: Object.keys(safe || {}).slice(0, 20) };
}

export function groupOf(action) {
  const group = String(action).split('.')[0];
  return ACTIVITY_GROUPS[group] ? group : 'other';
}

export function retentionDays(severity) {
  return RETENTION_DAYS[severity] || RETENTION_DAYS.normal;
}

/**
 * Append one line. Returns the stored row, or throws (callers that must not
 * fail the user's action use `recordActivitySafely`).
 *
 * @param {object} a
 * @param {object|null} a.actor        the User document (null = system)
 * @param {string} a.action            e.g. "order.status_changed"
 * @param {string} a.sentence          the Arabic sentence WITHOUT the actor name
 * @param {'normal'|'danger'|'security'} [a.severity]
 * @param {{type:string,id?:any,label?:string}[]} [a.targets]
 * @param {object} [a.before]  @param {object} [a.after]  only the changed fields
 * @param {object} [a.session] a mongoose session when written inside a transaction
 */
export async function recordActivity({ actor, action, sentence, severity = 'normal', targets = [], before, after, sessionId = null, session = null, at = new Date() }) {
  if (!SEVERITIES.includes(severity)) severity = 'normal';
  const doc = {
    at,
    actorId: actor?._id || null,
    actorName: actor?.name || 'النظام',
    actorRole: actor?.role || 'system',
    action,
    group: groupOf(action),
    severity,
    targets: targets.slice(0, 4).map((t) => ({
      type: t.type,
      id: t.id === undefined || t.id === null ? undefined : String(t.id),
      label: t.label ? scrubSentence(t.label, 120) : undefined,
    })),
    before: clampState(before),
    after: clampState(after),
    sentence: scrubSentence(sentence),
    sentenceVersion: SENTENCE_VERSION,
    sessionId: sessionId || null,
    expiresAt: new Date(at.getTime() + retentionDays(severity) * DAY_MS),
  };
  const [row] = await StaffActivity.create([doc], session ? { session } : undefined);
  return row;
}

/** Same, but a failure is only logged (the user's action already happened). */
export async function recordActivitySafely(args) {
  try {
    return await recordActivity(args);
  } catch (err) {
    logger.warn('Failed to write staff activity', { action: args?.action, error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------- reading

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LINKS = {
  order: (id) => `/admin/orders/${id}`,
  courier: (id) => `/admin/couriers/${id}`,
  user: (id) => `/admin/staff/${id}`,
};

/** Which of the linked items still exist (a deleted item shows as «محذوف»). */
async function existingTargets(items) {
  const ids = (type) => [...new Set(items.flatMap((i) => i.targets.filter((t) => t.type === type && /^[a-f\d]{24}$/i.test(t.id || '')).map((t) => t.id)))];
  const [orders, users] = await Promise.all([
    ids('order').length ? Order.find({ _id: { $in: ids('order') } }).select('_id').lean() : [],
    [...ids('courier'), ...ids('user')].length ? User.find({ _id: { $in: [...ids('courier'), ...ids('user')] } }).select('_id').lean() : [],
  ]);
  return { order: new Set(orders.map((o) => String(o._id))), user: new Set(users.map((u) => String(u._id))) };
}

function shape(row, exist) {
  return {
    id: String(row._id),
    at: row.at,
    actor: { id: row.actorId ? String(row.actorId) : null, name: row.actorName, role: row.actorRole },
    action: row.action,
    group: row.group,
    severity: row.severity,
    sentence: row.sentence,
    before: row.before ?? null,
    after: row.after ?? null,
    targets: (row.targets || []).map((t) => {
      const make = LINKS[t.type];
      const pool = t.type === 'order' ? exist.order : exist.user;
      const known = make && t.id && /^[a-f\d]{24}$/i.test(t.id);
      return {
        type: t.type,
        label: t.label || null,
        link: known && pool.has(t.id) ? make(t.id) : null,
        deleted: Boolean(known && !pool.has(t.id)),
      };
    }),
  };
}

/** Admin activity page. Filters: actor, role, group, severity, dates, text. */
export async function listActivity({ actor, role, group, severity, from, to, q, page = 1, limit = 30 } = {}) {
  const filter = {};
  if (actor && mongoose.isValidObjectId(actor)) filter.actorId = new mongoose.Types.ObjectId(actor);
  if (role) filter.actorRole = role;
  if (group && ACTIVITY_GROUPS[group]) filter.group = group;
  if (severity && SEVERITIES.includes(severity)) filter.severity = severity;
  if (from || to) {
    filter.at = {};
    if (from) filter.at.$gte = new Date(from);
    if (to) filter.at.$lte = new Date(to);
  }
  if (q) filter.sentence = { $regex: escapeRegex(String(q).slice(0, 80)), $options: 'i' };
  const size = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * size;
  const [rows, total] = await Promise.all([
    StaffActivity.find(filter).sort({ at: -1, _id: -1 }).skip(skip).limit(size).lean(),
    StaffActivity.countDocuments(filter),
  ]);
  const exist = await existingTargets(rows);
  return { items: rows.map((r) => shape(r, exist)), total, page: Math.max(Number(page) || 1, 1), limit: size };
}

/** Everyone who can appear in the log (tabs of the activity page). */
export async function listActors() {
  const users = await User.find({ role: { $in: ['admin', 'moderator', 'courier'] } })
    .select('name role status isActive')
    .sort({ role: 1, name: 1 })
    .lean();
  return users.map((u) => ({
    id: String(u._id),
    name: u.name,
    role: u.role,
    active: u.role === 'courier' ? Boolean(u.isActive) : (u.status || 'active') === 'active',
  }));
}

/** The last person who changed each order, for the orders list and detail (admin only). */
export async function lastEditors(orderIds) {
  const ids = [...new Set(orderIds.map(String))];
  if (!ids.length) return {};
  const rows = await StaffActivity.aggregate([
    { $match: { group: { $in: ['order', 'delivery'] }, 'targets.type': 'order', 'targets.id': { $in: ids } } },
    { $sort: { at: -1 } },
    { $unwind: '$targets' },
    { $match: { 'targets.type': 'order', 'targets.id': { $in: ids } } },
    { $group: { _id: '$targets.id', name: { $first: '$actorName' }, role: { $first: '$actorRole' }, at: { $first: '$at' }, sentence: { $first: '$sentence' } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, { name: r.name, role: r.role, at: r.at, sentence: r.sentence }]));
}

/** Rows and storage used by the log (shown to the admin; the owner keeps Atlas under 512MB). */
export async function activityStorage() {
  const [count, stats] = await Promise.all([
    StaffActivity.estimatedDocumentCount(),
    StaffActivity.collection.aggregate([{ $collStats: { storageStats: {} } }]).toArray().catch(() => []),
  ]);
  const s = stats[0]?.storageStats || {};
  return { rows: count, dataBytes: s.size || 0, indexBytes: s.totalIndexSize || 0, storageBytes: s.storageSize || 0 };
}

// ---------------------------------------------------------------- sign-in lines

/** «دخول» or «دخول من جهاز جديد» (a device this account has not signed in from during the retention window). */
export async function recordLogin(user, { userAgent, sessionId = null } = {}) {
  const device = deviceLabel(userAgent);
  try {
    const known = await StaffActivity.exists({ actorId: user._id, action: 'auth.login', 'after.device': device });
    return await recordActivity({
      actor: user,
      action: 'auth.login',
      severity: user.role === 'admin' ? 'security' : 'normal',
      sentence: known ? `دخول (${device})` : `دخول من جهاز جديد (${device})`,
      after: { device, newDevice: !known },
      sessionId,
    });
  } catch (err) {
    logger.warn('Failed to write the sign-in line', { error: err.message });
    return null;
  }
}
