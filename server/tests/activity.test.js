import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSION_META } from '../src/middleware/permissions.js';
import { ROUTER_SCOPE } from '../src/middleware/permissions.js';
import { COURIER_ACTIVITY, MANUAL_ACTIVITY, STAFF_ACTIVITY } from '../src/services/activityRoutes.js';
import { scrubSentence } from '../src/services/activityService.js';
import { CouponAssignment, StaffActivity, Order } from '../src/models/index.js';
import { client, createAssignedOrder, createOrder, createUser, getTestApp, loginAs } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const grants = (sections, dangerous = [], fields = []) => ({ sections, dangerous, fields: fields.map((key) => ({ key, until: null })) });

function collect(app) {
  const out = [];
  const walk = (stack, scope) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods).filter((m) => m !== '_all')) {
          out.push({ scope, method: method.toUpperCase(), path: layer.route.path, meta: layer.route.stack[0]?.handle?.[PERMISSION_META] || null });
        }
      } else if (Array.isArray(layer.handle?.stack)) walk(layer.handle.stack, layer.handle[ROUTER_SCOPE] || scope);
    }
  };
  walk(app.router.stack, 'app');
  return out;
}

describe('activity log: coverage and rules', () => {
  const routes = collect(getTestApp());

  it('every state-changing staff route has a sentence descriptor (a new route cannot go unlogged)', () => {
    const missing = routes
      .filter((r) => r.scope === 'staff' && r.method !== 'GET' && r.meta && !r.meta.adminOnly)
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => !STAFF_ACTIVITY[k] && !MANUAL_ACTIVITY.has(k));
    expect(missing).toEqual([]);
  });

  it('every descriptor points at a real route (no stale entries)', () => {
    const real = new Set(routes.filter((r) => r.scope === 'staff').map((r) => `${r.method} ${r.path}`));
    expect(Object.keys(STAFF_ACTIVITY).filter((k) => !real.has(k))).toEqual([]);
    const courier = new Set(routes.filter((r) => r.scope === 'courier').map((r) => `${r.method} ${r.path}`));
    expect(Object.keys(COURIER_ACTIVITY).filter((k) => !courier.has(k))).toEqual([]);
  });

  it('every state-changing courier route logs', () => {
    const writes = routes.filter((r) => r.scope === 'courier' && r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
    expect(writes.filter((k) => !COURIER_ACTIVITY[k])).toEqual([]);
  });

  it('no code updates or deletes StaffActivity rows (append only)', () => {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js')) files.push(full);
      }
    };
    walk(path.resolve(import.meta.dirname, '../src'));
    walk(path.resolve(import.meta.dirname, '../scripts'));
    const bad = files.filter((f) => /StaffActivity\s*\.\s*(update\w*|delete\w*|findOneAnd\w+|findByIdAnd\w+|replaceOne|remove|bulkWrite|drop)\b/.test(fs.readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });

  it('the model refuses updates and deletes', async () => {
    const row = await StaffActivity.create({ action: 'order.x', group: 'order', sentence: 'x', expiresAt: new Date(Date.now() + DAY) });
    await expect(StaffActivity.updateOne({ _id: row._id }, { $set: { sentence: 'y' } })).rejects.toThrow(/append-only/);
    await expect(StaffActivity.deleteMany({})).rejects.toThrow(/append-only/);
    row.sentence = 'z';
    await expect(row.save()).rejects.toThrow(/append-only/);
  });

  it('keeps ordinary rows 90 days and dangerous or security rows 365 days', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    await api.post('/api/admin/staff', { name: 'ن ن', phone: '01090000001' });
    const normal = await StaffActivity.findOne({ action: 'auth.login' }).lean();
    const sec = await StaffActivity.findOne({ action: 'account.created' }).lean();
    expect(Math.round((sec.expiresAt - sec.at) / DAY)).toBe(365);
    expect(normal.severity).toBe('security'); // the admin's own sign-in is a security line
    const moderator = await createUser('moderator', { permissions: grants({ orders: 'view' }) });
    await loginAs(moderator);
    const line = await StaffActivity.findOne({ actorId: moderator._id, action: 'auth.login' }).lean();
    expect(line.severity).toBe('normal');
    expect(Math.round((line.expiresAt - line.at) / DAY)).toBe(90);
  });
});

describe('activity log: sentences', () => {
  it('removes anything that looks like a phone number', () => {
    for (const t of ['01012345678', '+201012345678', '201012345678', '0020 101 234 5678', '٠١٠١٢٣٤٥٦٧٨', '010-1234-5678', 'ارقم 1234567890123']) {
      expect(scrubSentence(`اتصال بـ ${t} الآن`), t).not.toMatch(/[0-9٠-٩]{8,}|1[0125][ -]?\d{4}/);
    }
    expect(scrubSentence('طلب 1042 بمبلغ 150 ج.م')).toBe('طلب 1042 بمبلغ 150 ج.م');
    // Dates and times are not phone numbers.
    expect(scrubSentence('حتى 2026-11-28 04:36')).toBe('حتى 2026-11-28 04:36');
    expect(scrubSentence('الانتهاء من 2027-05-01 إلى 2027-06-15')).toBe('الانتهاء من 2027-05-01 إلى 2027-06-15');
  });

  it('logs a moderator order status change with before and after, and shows the last editor to the admin only', async () => {
    const admin = await createUser('admin');
    const moderator = await createUser('moderator', { name: 'أحمد', permissions: grants({ orders: 'edit' }, ['changeOrderStatus']) });
    const order = await createOrder();
    const mod = await loginAs(moderator);
    const res = await mod.patch(`/api/admin/orders/${order._id}/status`, { status: 'cancelled', reason: 'العميل طلب الإلغاء' });
    expect(res.status).toBe(200);
    const line = await StaffActivity.findOne({ action: 'order.status_changed' }).lean();
    expect(line.actorName).toBe('أحمد');
    expect(line.actorRole).toBe('moderator');
    expect(line.sentence).toContain('تغيير حالة الطلب');
    expect(line.sentence).toContain('من «جديد» إلى «ملغي»');
    expect(line.sentence).toContain('العميل طلب الإلغاء');
    expect(line.severity).toBe('normal');
    expect(line.before.status).toBe('new');
    expect(line.after.status).toBe('cancelled');
    expect(line.targets[0].type).toBe('order');
    expect(String(line.targets[0].id)).toBe(String(order._id));
    expect(JSON.stringify(line)).not.toMatch(/0\d{10}/);

    const adminApi = await loginAs(admin);
    const detail = await adminApi.get(`/api/admin/orders/${order._id}`);
    expect(detail.body.order.lastEditedBy.name).toBe('أحمد');
    const list = await adminApi.get('/api/admin/orders?cleared=include');
    expect(list.body.items.find((o) => o._id === String(order._id)).lastEditedBy.name).toBe('أحمد');
    // A moderator is never told who edited (and the field is not sent to them).
    const seen = await mod.get(`/api/admin/orders/${order._id}`);
    expect(seen.body.order.lastEditedBy).toBeUndefined();
  });

  it('does not log a refused or failed request', async () => {
    const moderator = await createUser('moderator', { permissions: grants({ orders: 'edit' }) }); // no changeOrderStatus
    const order = await createOrder();
    const mod = await loginAs(moderator);
    expect((await mod.patch(`/api/admin/orders/${order._id}/status`, { status: 'cancelled', reason: 'سبب' })).status).toBe(403);
    expect((await mod.patch(`/api/admin/orders/${order._id}/assignment`, { courierId: 'bad' })).status).toBe(400);
    expect(await StaffActivity.countDocuments({ action: { $regex: '^order\\.' } })).toBe(0);
  });

  it('writes the exact change of an expense edit and of coupon dates', async () => {
    const moderator = await createUser('moderator', { name: 'سارة', permissions: grants({ finance: 'edit', coupons: 'edit' }) });
    const api = await loginAs(moderator);
    const today = new Date().toISOString().slice(0, 10);
    const created = await api.post('/api/admin/finance/expenses', { date: today, amount: '100', category: 'ads' });
    const id = created.body.expense._id;
    await api.patch(`/api/admin/finance/expenses/${id}`, { amount: '150' });
    const upd = await StaffActivity.findOne({ action: 'finance.expense_updated' }).lean();
    expect(upd.sentence).toContain('المبلغ من 100 ج.م إلى 150 ج.م');
    expect(upd.before.amount).toBe(10000);
    expect(upd.after.amount).toBe(15000);
    expect((await StaffActivity.findOne({ action: 'finance.expense_created' }).lean()).sentence).toContain('100 ج.م');

    const coupon = await CouponAssignment.create({ code: 'abc123', seq: 1, phoneNormalized: '01099998888', assignedAt: new Date(), sentAt: new Date('2026-11-01'), expiresAt: new Date('2027-11-01') });
    await api.patch(`/api/admin/coupons/${coupon._id}/dates`, { expiresAt: '2027-05-01' });
    const dates = await StaffActivity.findOne({ action: 'coupon.dates_changed' }).lean();
    expect(dates.sentence).toContain('abc123');
    expect(dates.sentence).toContain('2027-05-01');
  });

  it('a WhatsApp press logs the prepared text and the customer name, never the number, and needs the phone permission', async () => {
    const order = await createOrder({ full_name: 'محمد علي' });
    const moderator = await createUser('moderator', { name: 'منى', permissions: grants({ orders: 'view' }, [], ['customerPhone']) });
    const mod = await loginAs(moderator);
    const text = 'أهلاً محمد، رقم هاتفك 01112223333 وطلبك رقم 1042 جاهز';
    const res = await mod.post('/api/admin/wa/click', { kind: 'confirm', id: String(order._id), text });
    expect(res.status).toBe(200);
    const line = await StaffActivity.findOne({ action: 'whatsapp.confirm_opened' }).lean();
    expect(line.sentence).toContain('فتح واتساب');
    expect(line.sentence).toContain('محمد علي');
    expect(line.sentence).toContain('طلبك رقم 1042 جاهز');
    expect(line.sentence).not.toContain('01112223333');
    expect(line.sentence).not.toContain('أرسل');

    const noPhone = await loginAs(await createUser('moderator', { permissions: grants({ orders: 'view' }) }));
    expect((await noPhone.post('/api/admin/wa/click', { kind: 'confirm', id: String(order._id), text })).status).toBe(403);
    const wrongSection = await loginAs(await createUser('moderator', { permissions: grants({ customers: 'view', orders: 'view' }, [], ['customerPhone']) }));
    expect((await wrongSection.post('/api/admin/wa/click', { kind: 'coupon', id: String(order._id), text })).status).toBe(403);
  });

  it('logs sign-ins, marks a new device, and logs a password change', async () => {
    const moderator = await createUser('moderator', { name: 'هبة', permissions: grants({ orders: 'view' }) });
    const ua = 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36';
    for (let i = 0; i < 2; i += 1) {
      const c = await client();
      const res = await c.post('/api/auth/login', { identifier: moderator.phone, password: 'Password1234' }, { 'user-agent': ua });
      expect(res.status).toBe(200);
    }
    const rows = await StaffActivity.find({ actorId: moderator._id, action: 'auth.login' }).sort({ at: 1 }).lean();
    expect(rows).toHaveLength(2);
    expect(rows[0].sentence).toBe('دخول من جهاز جديد (Chrome على Android)');
    expect(rows[1].sentence).toBe('دخول (Chrome على Android)');
    const api = await loginAs(moderator);
    await api.post('/api/auth/change-password', { currentPassword: 'Password1234', newPassword: 'Different12345' });
    expect((await StaffActivity.findOne({ action: 'auth.password_changed' }).lean()).sentence).toBe('تغيير كلمة المرور');
  });

  it('links a courier action to the log', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier', { name: 'كريم' });
    const order = await createAssignedOrder(courier, admin);
    const api = await loginAs(courier);
    const res = await api.patch(`/api/courier/orders/${order._id}/status`, { status: 'failed', reason: 'no_answer' });
    expect(res.status).toBe(200);
    const line = await StaffActivity.findOne({ action: 'delivery.courier_status' }).lean();
    expect(line.actorRole).toBe('courier');
    expect(line.sentence).toContain('من «مُسند» إلى «فشل التسليم»');
    expect((await Order.findById(order._id)).deliveryStatus).toBe('failed');
  });
});

describe('activity page', () => {
  it('is for the admin only: tabs per account, filters, pages, and a «deleted» mark', async () => {
    const admin = await createUser('admin');
    const m1 = await createUser('moderator', { name: 'أ', permissions: grants({ orders: 'edit' }, ['changeOrderStatus']) });
    const m2 = await createUser('moderator', { name: 'ب', permissions: grants({ finance: 'edit' }) });
    const o1 = await createOrder();
    const a1 = await loginAs(m1);
    await a1.patch(`/api/admin/orders/${o1._id}/status`, { status: 'cancelled', reason: 'سبب الإلغاء' });
    const a2 = await loginAs(m2);
    await a2.post('/api/admin/finance/expenses', { date: new Date().toISOString().slice(0, 10), amount: '5', category: 'ads' });

    expect((await a1.get('/api/admin/activity')).status).toBe(403);
    const api = await loginAs(admin);
    const all = await api.get('/api/admin/activity');
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThanOrEqual(5);
    const mine = await api.get(`/api/admin/activity?actor=${m1._id}`);
    expect(mine.body.items.every((i) => i.actor.id === String(m1._id))).toBe(true);
    const byGroup = await api.get('/api/admin/activity?group=finance');
    expect(byGroup.body.items.map((i) => i.action)).toEqual(['finance.expense_created']);
    expect((await api.get('/api/admin/activity?severity=danger')).body.items.every((i) => i.severity === 'danger')).toBe(true);
    expect((await api.get('/api/admin/activity?role=moderator&limit=2&page=2')).body.items.length).toBeLessThanOrEqual(2);
    expect((await api.get('/api/admin/activity?q=سبب الإلغاء')).body.total).toBe(1);

    const line = (await api.get(`/api/admin/activity?actor=${m1._id}&group=order`)).body.items[0];
    expect(line.targets[0].link).toBe(`/admin/orders/${o1._id}`);
    await Order.deleteOne({ _id: o1._id });
    const after = (await api.get(`/api/admin/activity?actor=${m1._id}&group=order`)).body.items[0];
    expect(after.targets[0].deleted).toBe(true);
    expect(after.targets[0].link).toBeNull();

    const actors = (await api.get('/api/admin/activity/actors')).body;
    expect(actors.items.map((a) => a.name)).toEqual(expect.arrayContaining(['أ', 'ب']));
    expect(actors.storage.rows).toBeGreaterThan(0);
  });
});
