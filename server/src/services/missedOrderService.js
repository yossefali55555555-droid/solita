import crypto from 'node:crypto';
import { MissedOrder } from '../models/MissedOrder.js';
import { Order } from '../models/Order.js';
import { EGYPT_MOBILE_REGEX, normalizePhone } from '../utils/phone.js';
import { escapeRegex } from '../utils/sanitize.js';
import { notFound, unprocessable } from '../utils/errors.js';

/**
 * Missed orders imported from the EasyOrders export (CSV, or text copied
 * from the page). The parser accepts Arabic or English headers, comma /
 * semicolon / tab separators, quoted cells, and a single "customer" column
 * that holds both the name and the phone ("yossef ali +201097711577").
 */

export const MAX_IMPORT_CHARS = 100_000;

// ---------------------------------------------------------------- parsing

function detectDelimiter(headerLine) {
  const counts = { '\t': 0, ';': 0, ',': 0 };
  let quoted = false;
  for (const ch of headerLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

/** Split text into rows of cells, honouring quotes and quoted line breaks. */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim())) rows.push(row.map((c) => c.trim()));
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row.map((c) => c.trim()));
  return rows;
}

const HEADER_ALIASES = {
  customer: ['العميل', 'اسم العميل', 'الاسم', 'customer', 'name', 'full_name', 'customer name', 'client'],
  phone: ['الهاتف', 'رقم الهاتف', 'التليفون', 'الموبايل', 'phone', 'mobile', 'phone number', 'tel'],
  reason: ['السبب', 'سبب', 'reason', 'error', 'failure reason'],
  status: ['الحالة', 'حالة', 'status', 'state'],
  date: ['تاريخ الطلب', 'التاريخ', 'تاريخ', 'date', 'created_at', 'created at', 'createdat', 'order date'],
};

function mapHeader(cells) {
  const idx = {};
  cells.forEach((c, i) => {
    const h = c.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const [field, names] of Object.entries(HEADER_ALIASES)) {
      if (idx[field] === undefined && names.includes(h)) idx[field] = i;
    }
  });
  return idx;
}

const PHONE_IN_TEXT = /(?:\+?20|0)?\s?1[0125](?:[\s-]?\d){8}/;

/** Split "yossef ali +201097711577" into a name and a normalized phone. */
export function splitCustomer(raw) {
  const text = String(raw || '').trim();
  const m = text.match(PHONE_IN_TEXT);
  if (!m) return { name: text, phone: '' };
  const name = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  return { name, phone: m[0].replace(/[\s-]/g, '') };
}

const cairoFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Africa/Cairo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Instant for a wall-clock time in Cairo. */
export function cairoLocalToDate(y, mo, d, h, mi) {
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wanted - 2 * 3600_000;
  for (let i = 0; i < 2; i += 1) {
    const p = Object.fromEntries(cairoFmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const got = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    guess += wanted - got;
  }
  return new Date(guess);
}

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const westernDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));

/** dd/mm/yyyy hh:mm (EasyOrders dashboard, Cairo time), or ISO / yyyy-mm-dd. */
export function parseMissedDate(raw) {
  const s = westernDigits(raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|ص|م)?)?/i);
  if (m) {
    let h = m[4] ? +m[4] : 0;
    const ap = (m[6] || '').toLowerCase();
    if ((ap === 'pm' || ap === 'م') && h < 12) h += 12;
    if ((ap === 'am' || ap === 'ص') && h === 12) h = 0;
    const d = cairoLocalToDate(+m[3], +m[2], +m[1], h, m[5] ? +m[5] : 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return cairoLocalToDate(+m[1], +m[2], +m[3], 0, 0);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const REASON_LABELS = {
  otp_verify_failed: 'فشل التحقق من الرمز (OTP)',
  otp_failed: 'فشل التحقق من الرمز (OTP)',
};
export const reasonLabel = (reason) => REASON_LABELS[reason] || reason || '—';

export function makeKey({ phoneNormalized, name, eoDate, reason }) {
  return crypto
    .createHash('sha1')
    .update(`${phoneNormalized || name.toLowerCase()}|${eoDate.toISOString()}|${reason.toLowerCase()}`)
    .digest('hex');
}

/**
 * Parse the export text. Returns { rows, skipped, problem }. A row needs a
 * date and either a phone or a name; others are counted in `skipped`.
 */
export function parseMissedOrders(rawText) {
  const text = String(rawText || '').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const delimiter = detectDelimiter(firstLine);
  const table = parseDelimited(text, delimiter);
  if (table.length < 2) return { rows: [], skipped: 0, problem: 'الملف فاضي أو فيه صف واحد فقط.' };

  const idx = mapHeader(table[0]);
  if (idx.date === undefined || (idx.customer === undefined && idx.phone === undefined)) {
    return { rows: [], skipped: 0, problem: 'مش لاقي أعمدة «العميل» و«تاريخ الطلب» في أول صف. تأكد إن الملف هو تصدير الطلبات المفقودة وفيه صف العناوين.' };
  }
  const rows = [];
  let skipped = 0;
  for (const cells of table.slice(1)) {
    const eoDate = parseMissedDate(cells[idx.date] || '');
    let { name, phone } = splitCustomer(idx.customer !== undefined ? cells[idx.customer] : '');
    if (idx.phone !== undefined && cells[idx.phone]) {
      const sp = splitCustomer(cells[idx.phone]);
      phone = sp.phone || cells[idx.phone].replace(/[\s-]/g, '');
      if (!name) name = sp.name;
    }
    const phoneNormalized = normalizePhone(phone);
    const reason = (idx.reason !== undefined ? cells[idx.reason] : '').slice(0, 200);
    const eoStatus = (idx.status !== undefined ? cells[idx.status] : '').slice(0, 60);
    if (!eoDate || (!phoneNormalized && !name)) {
      skipped += 1;
      continue;
    }
    rows.push({ name: name.slice(0, 200), phone: phone.slice(0, 40), phoneNormalized, reason, eoStatus, eoDate, key: makeKey({ phoneNormalized, name, eoDate, reason }) });
  }
  return { rows, skipped, problem: null };
}

// ---------------------------------------------------------------- import / list

export async function importMissedOrders(admin, text) {
  if (String(text || '').length > MAX_IMPORT_CHARS) throw unprocessable('الملف كبير جدًا');
  const { rows, skipped, problem } = parseMissedOrders(text);
  if (problem) throw unprocessable(problem, 'BAD_IMPORT_FILE');
  const unique = [...new Map(rows.map((r) => [r.key, r])).values()];
  let created = 0;
  if (unique.length) {
    const now = new Date();
    const res = await MissedOrder.bulkWrite(
      unique.map((r) => ({
        updateOne: { filter: { key: r.key }, update: { $setOnInsert: { ...r, importedAt: now } }, upsert: true },
      })),
      { ordered: false },
    );
    created = res.upsertedCount || 0;
  }
  return { created, existing: unique.length - created, skipped, total: rows.length };
}

function buildQuery(filters) {
  const query = {};
  const status = filters.status || 'open';
  if (status === 'open') Object.assign(query, { contactedAt: null, dismissedAt: null });
  else if (status === 'contacted') Object.assign(query, { contactedAt: { $ne: null }, dismissedAt: null });
  else if (status === 'dismissed') query.dismissedAt = { $ne: null };
  if (filters.test !== 'include') query.isTest = filters.test === 'only';
  if (filters.reason) query.reason = filters.reason;
  if (filters.q) {
    const rx = new RegExp(escapeRegex(filters.q.trim()), 'i');
    const phone = normalizePhone(filters.q);
    query.$or = [{ name: rx }, { phone: rx }, ...(phone.length >= 4 ? [{ phoneNormalized: new RegExp(escapeRegex(phone)) }] : [])];
  }
  return query;
}

const TEST_NAME = /test|تجرب|تست/i;

/**
 * How worth chasing a row is:
 *  done        the same phone placed a real order afterwards
 *  unreachable no valid Egyptian mobile number to contact
 *  likely_test the phone belongs to an order marked test, the name says test,
 *              or the same phone failed 3+ times (someone trying the site)
 *  hot         a real customer who hit a problem and can be reached
 */
export function classifyMissed(item, { orderedLater, testPhones, repeats }) {
  if (orderedLater) return 'done';
  if (!EGYPT_MOBILE_REGEX.test(item.phoneNormalized || '')) return 'unreachable';
  if (testPhones.has(item.phoneNormalized) || TEST_NAME.test(item.name) || (repeats.get(item.phoneNormalized) || 0) >= 3) return 'likely_test';
  return 'hot';
}

const PRIORITY_LABELS = { hot: 'يستاهل التواصل', done: 'اشترى بعدها', unreachable: 'مفيش رقم صالح', likely_test: 'غالبًا تجربة' };

export async function listMissedOrders(filters, { skip, limit }) {
  const query = buildQuery(filters);
  const [all, counts, reasons] = await Promise.all([
    MissedOrder.find(query).sort({ eoDate: -1, _id: -1 }).limit(3000).populate('contactedBy', 'name').lean(),
    MissedOrder.aggregate([
      { $match: { isTest: false } },
      { $group: { _id: { c: { $cond: [{ $ne: ['$dismissedAt', null] }, 'dismissed', { $cond: [{ $ne: ['$contactedAt', null] }, 'contacted', 'open'] }] } }, n: { $sum: 1 } } },
    ]),
    MissedOrder.distinct('reason', { isTest: false }),
  ]);
  const phones = [...new Set(all.map((i) => i.phoneNormalized).filter(Boolean))];
  const orders = phones.length
    ? await Order.find({ 'customer.phoneNormalized': { $in: phones } }, { 'customer.phoneNormalized': 1, sourceCreatedAt: 1, createdAt: 1, easyOrdersShortId: 1, isTest: 1 }).lean()
    : [];
  const testPhones = new Set(orders.filter((o) => o.isTest).map((o) => o.customer.phoneNormalized));
  const repeats = new Map();
  for (const it of all) if (it.phoneNormalized) repeats.set(it.phoneNormalized, (repeats.get(it.phoneNormalized) || 0) + 1);

  for (const it of all) {
    it.reasonLabel = reasonLabel(it.reason);
    const later = orders.filter(
      (o) => !o.isTest && o.customer?.phoneNormalized === it.phoneNormalized && (o.sourceCreatedAt || o.createdAt) >= it.eoDate,
    );
    it.orderedLater = later.length ? { count: later.length, shortId: later[0].easyOrdersShortId || null } : null;
    it.priority = classifyMissed(it, { orderedLater: it.orderedLater, testPhones, repeats });
    it.priorityLabel = PRIORITY_LABELS[it.priority];
  }
  const priorityCounts = { hot: 0, done: 0, unreachable: 0, likely_test: 0 };
  for (const it of all) priorityCounts[it.priority] += 1;
  const filtered = filters.priority && filters.priority !== 'all' ? all.filter((i) => i.priority === filters.priority) : all;
  const c = Object.fromEntries(counts.map((x) => [x._id.c, x.n]));
  return {
    items: filtered.slice(skip, skip + limit),
    total: filtered.length,
    counts: { open: c.open || 0, contacted: c.contacted || 0, dismissed: c.dismissed || 0 },
    priorityCounts,
    reasons: reasons.filter(Boolean).map((r) => ({ value: r, label: reasonLabel(r) })),
  };
}

/** Apply one update to many rows at once (select several, mark them all). */
export async function bulkUpdateMissed(admin, ids, body) {
  const set = {};
  if (body.contacted === true) Object.assign(set, { contactedAt: new Date(), contactedBy: admin._id });
  if (body.contacted === false) Object.assign(set, { contactedAt: null, contactedBy: null });
  if (body.dismissed === true) set.dismissedAt = new Date();
  if (body.dismissed === false) set.dismissedAt = null;
  if (body.isTest !== undefined) set.isTest = body.isTest;
  const res = await MissedOrder.updateMany({ _id: { $in: ids } }, { $set: set });
  return { updated: res.modifiedCount };
}

export async function updateMissedOrder(admin, id, body) {
  const set = {};
  if (body.contacted === true) Object.assign(set, { contactedAt: new Date(), contactedBy: admin._id });
  if (body.contacted === false) Object.assign(set, { contactedAt: null, contactedBy: null });
  if (body.dismissed === true) set.dismissedAt = new Date();
  if (body.dismissed === false) set.dismissedAt = null;
  if (body.note !== undefined) set.note = body.note;
  if (body.isTest !== undefined) set.isTest = body.isTest;
  const updated = await MissedOrder.findByIdAndUpdate(id, { $set: set }, { returnDocument: 'after' }).lean();
  if (!updated) throw notFound('السجل غير موجود');
  return updated;
}
