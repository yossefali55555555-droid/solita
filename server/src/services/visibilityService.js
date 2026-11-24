import crypto from 'node:crypto';
import { getConfig } from '../config/env.js';
import { badRequest } from '../utils/errors.js';
import { hasField, hasSection, isAdmin } from './permissionService.js';

/**
 * Field visibility for staff responses (SPEC part c). One place decides what
 * a moderator may see; controllers never filter by hand.
 *
 * Two layers, both server side:
 *   1. projection: services receive the `viewer` and do not select hidden
 *      fields where the query allows it (or never put them in the result).
 *   2. serializeFor(viewer, kind, data): every staff response is shaped here.
 *      A last guard (guardResponse) re-runs the scrub on whatever a route
 *      sends, so a field a service forgot still does not reach the browser.
 */

// ---------------------------------------------------------------- viewer

/** What the signed-in user may see. Computed once per request. */
export function viewerFor(user, now = new Date()) {
  return Object.freeze({
    admin: isAdmin(user),
    phone: hasField(user, 'customerPhone', now),
    money: hasField(user, 'moneyFigures', now),
    export: hasField(user, 'export', now),
    can: (section, level = 'view') => hasSection(user, section, level),
  });
}

/** Result shown to nobody: used where a request has no staff user (tests, scripts). */
export const FULL_VIEWER = Object.freeze({
  admin: true,
  phone: true,
  money: true,
  export: true,
  can: () => true,
});

// ---------------------------------------------------------------- phone numbers

/** Egyptian mobile in any format: 01…, 201…, +201…, 00201…, with spaces or dashes. */
const PHONE_VALUE = /^\s*(?:\+|00)?(?:20)?[\s-]?0?1[0125](?:[\s-]?\d){8}\s*$/;
export const isPhoneValue = (v) => typeof v === 'string' && PHONE_VALUE.test(v);

/** True for a search text that is (or starts like) a phone number. */
export function looksLikePhone(q) {
  const s = String(q ?? '').trim();
  if (!/^[+\d][\d\s-]*$/.test(s)) return false;
  return s.replace(/\D/g, '').length >= 7;
}

/**
 * Search side channel: a moderator without the phone grant cannot search by
 * number (it would confirm which numbers exist). Called before any query.
 */
export function assertCanSearch(viewer, q) {
  if (!viewer.phone && q && looksLikePhone(q)) {
    throw badRequest('البحث برقم الهاتف غير متاح لحسابك. ابحث بالاسم أو رقم الطلب.', 'PHONE_SEARCH_FORBIDDEN');
  }
}

// ---------------------------------------------------------------- opaque customer key

const KEY_PREFIX = 'c_';

function keyMaterial() {
  return crypto.createHash('sha256').update(`solita.customer-key.v1|${getConfig().sessionSecret}`).digest();
}

/**
 * Customers are grouped by phone, so the raw key is the phone itself. The key
 * that reaches the browser is an authenticated encryption of it (AES-256-GCM,
 * deterministic IV, server secret): stable for the same customer, meaningless
 * and unforgeable for anyone else.
 */
export function encodeCustomerKey(raw) {
  const k = keyMaterial();
  const iv = crypto.createHmac('sha256', k).update(`iv|${raw}`).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([cipher.update(String(raw), 'utf8'), cipher.final()]);
  return KEY_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Raw key for an opaque one, or null if it is not ours / was tampered with. */
export function decodeCustomerKey(opaque) {
  const s = String(opaque ?? '');
  if (!s.startsWith(KEY_PREFIX)) return null;
  try {
    const buf = Buffer.from(s.slice(KEY_PREFIX.length), 'base64url');
    // Only the exact text we issued: padding bits or extra characters make it a different string.
    if (buf.length < 29 || buf.toString('base64url') !== s.slice(KEY_PREFIX.length)) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyMaterial(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- scrubbing

/** Keys that only ever hold a customer's number. */
const CUSTOMER_PHONE_KEYS = new Set(['phoneNormalized', 'alternativePhone', 'altPhone', 'ownerPhone', 'phoneTyped']);
/** `phone` here is a courier's number (visible with couriers.view). */
const COURIER_PARENTS = new Set(['courier', 'assignedTo', 'subjectCourier']);
/** Keys that hold money-only figures hidden without moneyFigures. */
const MONEY_KEYS = new Set(['totalOrdered', 'totalDelivered', 'netProfit']);

function walk(node, viewer, parentKey) {
  if (Array.isArray(node)) return node.map((v) => walk(v, viewer, parentKey));
  if (node && typeof node === 'object') {
    const staffPhone = viewer.can('couriers') && (COURIER_PARENTS.has(parentKey) || node.role === 'courier');
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (!viewer.phone && CUSTOMER_PHONE_KEYS.has(k)) continue;
      if (!viewer.phone && k === 'phone' && !staffPhone) continue;
      if (!viewer.money && MONEY_KEYS.has(k)) continue;
      // A courier's own number (couriers section) is not customer data: keep it as it is.
      out[k] = k === 'phone' && staffPhone ? v : walk(v, viewer, k);
    }
    return out;
  }
  // A value that is nothing but a phone number (e.g. a grouping key) never leaves.
  if (!viewer.phone && isPhoneValue(node)) return '';
  return node;
}

/** Plain-JSON copy of `data` (Dates/ObjectIds as strings) with hidden fields removed. */
export function scrub(viewer, data) {
  if (viewer.phone && viewer.money) return data;
  return walk(JSON.parse(JSON.stringify(data ?? null)), viewer, '');
}

// ---------------------------------------------------------------- serializeFor

const ownKeys = (items) => (Array.isArray(items) ? items : []);

const SHAPERS = {
  /** Orders, reviews, carts, missed orders, founders, labels, coupons...: field scrub only. */
  plain: (_v, d) => d,

  /** Customer list rows and one customer: opaque key, no totals without moneyFigures. */
  customer: (_v, d) => {
    const row = (c) => (c && c.key !== undefined ? { ...c, key: encodeCustomerKey(c.key) } : c);
    if (d?.customer) return { ...d, customer: row(d.customer) };
    if (Array.isArray(d?.items)) return { ...d, items: ownKeys(d.items).map(row) };
    return d;
  },

  /** Dashboard: every block follows the permission of its own section. */
  overview: (v, d) => {
    const stats = { ...d.stats };
    if (!v.can('orders')) delete stats.orders;
    if (!v.can('reviews')) delete stats.pendingReviews;
    if (!v.can('sync')) delete stats.sync;
    if (!v.can('cash')) delete stats.cash;
    const out = { stats };
    if (v.admin || v.can('sync')) out.system = d.system;
    return out;
  },

  /** Profit needs moneyFigures; sales and expenses follow the finance section. */
  profit: (v, d) => {
    if (v.money) return d;
    const rest = { ...d };
    delete rest.netProfit;
    delete rest.cash;
    return rest;
  },
};

/**
 * Shape a response for a viewer. `kind`: plain | customer | overview | profit.
 * Always ends with the generic scrub (phone keys, phone-looking values, money).
 */
export function serializeFor(viewer, kind, data) {
  const shaper = SHAPERS[kind];
  if (!shaper) throw new Error(`Unknown serializer kind "${kind}"`);
  return scrub(viewer, shaper(viewer, data));
}

/**
 * Last-resort guard: wraps res.json so that anything a staff route sends is
 * scrubbed for this viewer, even if its controller did not call serializeFor.
 * Idempotent with serializeFor.
 */
export function guardResponse(res, viewer) {
  if (viewer.phone && viewer.money) return;
  if (typeof res?.json !== 'function') return; // direct middleware calls in unit tests
  const original = res.json.bind(res);
  res.json = (body) => original(scrub(viewer, body));
}
