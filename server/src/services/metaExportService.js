import { createHash } from 'node:crypto';
import { NOT_TEST } from '../models/Order.js';
import { Order } from '../models/index.js';
import { EGYPT_MOBILE_REGEX, normalizePhone } from '../utils/phone.js';

/**
 * File for Meta Ads (Ads Manager → Audiences → customer list, or Events Manager → offline events).
 * Built from orders on the fly; nothing is stored. Column names are Meta's own
 * (https://www.facebook.com/business/help/2082575038703844):
 *
 *   customers file : email, phone, phone, fn, ln, ct, st, country, value
 *   orders file    : the same identifiers + event_name, event_time, value, currency
 *
 * `value` is the customer lifetime value (customers file) or the order total (orders file) in EGP,
 * a plain number without currency characters. Ads Manager hashes the identifiers in the browser,
 * so the default file is plain. `hash: 'sha256'` hashes the identifiers the way Meta's API
 * expects (lowercase hex SHA-256 of the normalised value) for tools that send the file as is.
 */

export const MAX_ROWS = 100_000;
const EMAIL_RX = /^[^\s@=+-][^\s@]*@[^\s@]+\.[^\s@]+$/;

/** Egyptian mobile → "201012345678" (Meta wants the country code, digits only). Anything else → '' */
export function toE164(value) {
  const local = normalizePhone(value);
  return EGYPT_MOBILE_REGEX.test(local) ? `20${local.slice(1)}` : '';
}

export function cleanEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  return EMAIL_RX.test(email) ? email : '';
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** "أحمد محمد علي" → fn "أحمد", ln "محمد علي". */
export function splitName(full) {
  const parts = squash(full).split(' ').filter(Boolean);
  return { fn: parts[0] || '', ln: parts.slice(1).join(' ') };
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
/** Meta's normalisation for hashed text fields: lowercase, no spaces or punctuation. */
const plain = (s) => squash(s).toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');

/** Applies the hashing option to one identifier; '' stays ''. */
function mask(value, kind, hash) {
  if (!value) return '';
  if (!hash) return value;
  if (kind === 'country') return sha256(value.toLowerCase());
  if (kind === 'text') return sha256(plain(value)) ;
  return sha256(value);
}

const egp = (minor) => ((minor || 0) / 100).toFixed(2);

const HEADERS_ID = ['email', 'phone', 'phone', 'fn', 'ln', 'ct', 'st', 'country'];

function identifierCells(c, hash) {
  const { fn, ln } = splitName(c.name);
  return [
    mask(cleanEmail(c.email), 'email', hash),
    mask(toE164(c.phone || c.phoneNormalized), 'phone', hash),
    mask(toE164(c.alternativePhone), 'phone', hash),
    mask(fn, 'text', hash),
    mask(ln, 'text', hash),
    mask(squash(c.area), 'text', hash),
    mask(squash(c.government), 'text', hash),
    mask('EG', 'country', hash),
  ];
}

/** A cell starting with = + - @ would run as a formula in Excel; plain digits and hashes are untouched. */
function cell(value) {
  let s = String(value ?? '').replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const toCsv = (rows) => `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;

function orderMatch({ from, to }) {
  const date = {};
  if (from) date.$gte = from;
  if (to) date.$lte = to;
  return Object.keys(date).length ? { when: date } : {};
}

const WHEN = { $ifNull: ['$sourceCreatedAt', '$createdAt'] };

/**
 * @param {object} f
 * @param {'customers'|'orders'} f.mode
 * @param {Date} [f.from] @param {Date} [f.to]  order date window
 * @param {number} [f.minOrders]  customers file: at least this many orders
 * @param {boolean} [f.includeReturned]  customers file: also customers whose orders came back (their value counts delivered orders only)
 * @param {'none'|'sha256'} [f.hash]
 * @returns {{ count: number, csv: string, filename: string }}
 */
export async function exportForMeta(f = {}) {
  const hash = f.hash === 'sha256';
  return f.mode === 'orders' ? ordersFile(f, hash) : customersFile(f, hash);
}

async function customersFile(f, hash) {
  const statuses = f.includeReturned ? ['delivered', 'returned'] : ['delivered'];
  const pipeline = [
    { $match: { ...NOT_TEST, deliveryStatus: { $in: statuses } } },
    { $addFields: { when: WHEN } },
    ...(Object.keys(orderMatch(f)).length ? [{ $match: orderMatch(f) }] : []),
    { $sort: { when: 1 } },
    {
      $group: {
        _id: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ['$customer.phoneNormalized', ''] } }, 0] },
            '$customer.phoneNormalized',
            { $concat: ['name:', { $ifNull: ['$customer.name', ''] }] },
          ],
        },
        name: { $last: '$customer.name' },
        phone: { $last: '$customer.phone' },
        phoneNormalized: { $last: '$customer.phoneNormalized' },
        email: { $max: '$customer.email' },
        alternativePhone: { $max: '$customer.alternativePhone' },
        government: { $last: '$customer.government' },
        area: { $last: '$customer.area' },
        orders: { $sum: 1 },
        value: { $sum: { $cond: [{ $eq: ['$deliveryStatus', 'delivered'] }, '$totalAmount', 0] } },
      },
    },
    { $match: { orders: { $gte: f.minOrders || 1 } } },
    { $sort: { value: -1, _id: 1 } },
    { $limit: MAX_ROWS },
  ];
  const customers = await Order.aggregate(pipeline).option({ maxTimeMS: 20000 });
  // A row Meta cannot match on (no usable email or phone) only adds noise.
  const rows = customers
    .map((c) => ({ ids: identifierCells(c, hash), value: egp(c.value) }))
    .filter((r) => r.ids[0] || r.ids[1] || r.ids[2]);
  return {
    count: rows.length,
    csv: toCsv([[...HEADERS_ID, 'value'], ...rows.map((r) => [...r.ids, r.value])]),
    filename: 'meta-customers.csv',
  };
}

async function ordersFile(f, hash) {
  const orders = await Order.aggregate([
    { $match: { ...NOT_TEST, deliveryStatus: 'delivered' } },
    { $addFields: { when: WHEN } },
    ...(Object.keys(orderMatch(f)).length ? [{ $match: orderMatch(f) }] : []),
    { $sort: { when: 1 } },
    { $limit: MAX_ROWS },
    { $project: { customer: 1, totalAmount: 1, currency: 1, when: 1 } },
  ]).option({ maxTimeMS: 20000 });
  const rows = orders
    .map((o) => ({
      ids: identifierCells(o.customer || {}, hash),
      event: ['Purchase', new Date(o.when).toISOString(), egp(o.totalAmount), o.currency || 'EGP'],
    }))
    .filter((r) => r.ids[0] || r.ids[1] || r.ids[2]);
  return {
    count: rows.length,
    csv: toCsv([[...HEADERS_ID, 'event_name', 'event_time', 'value', 'currency'], ...rows.map((r) => [...r.ids, ...r.event])]),
    filename: 'meta-orders.csv',
  };
}
