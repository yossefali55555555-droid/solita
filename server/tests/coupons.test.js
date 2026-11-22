import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CouponAssignment, Founder, Order } from '../src/models/index.js';
import { addToPool, assignCouponOnDelivery, ensureCouponForOrder, evaluateCoupon } from '../src/services/couponService.js';
import { assignFounderForOrder } from '../src/services/founderService.js';
import { createOrder, createUser, getTestApp, loginAs } from './helpers.js';

const STOREFRONT = 'https://solita.myeasyorders.com';
let phoneCounter = 0;
const nextPhone = () => `0110${String(2000000 + ++phoneCounter)}`;
let ip = 0;

function check(body) {
  ip += 1;
  return request(getTestApp())
    .post('/api/public/coupon-check')
    .set('Origin', STOREFRONT)
    .set('X-Forwarded-For', `10.9.${Math.floor(ip / 250)}.${(ip % 250) + 1}`)
    .send(body);
}

async function delivered(overrides = {}) {
  const order = await createOrder({ phone: nextPhone(), ...overrides });
  await Order.updateOne({ _id: order._id }, { $set: { deliveryStatus: 'delivered', deliveredAt: new Date() } });
  return Order.findById(order._id);
}

const DAY = 24 * 60 * 60 * 1000;

describe('customer-bound coupons: assignment', () => {
  it('gives the next code in the pool, one per phone, valid for exactly 365 days', async () => {
    expect(await addToPool(['ST30-A1', 'st30-b2', 'st30-c3', 'ST30-A1'])).toEqual({ added: 3, skipped: 0 });
    expect(await addToPool(['st30-a1', 'st30-d4'])).toEqual({ added: 1, skipped: 1 });

    const o1 = await delivered();
    const o2 = await delivered();
    const a = await assignCouponOnDelivery(o1);
    const b = await assignCouponOnDelivery(o2);
    expect([a.code, b.code]).toEqual(['st30-a1', 'st30-b2']);
    expect(Math.round((a.expiresAt - a.assignedAt) / DAY)).toBe(365);

    // Same customer again: same code, no new one used.
    const again = await delivered({ phone: o1.customer.phone });
    expect((await assignCouponOnDelivery(again)).code).toBe('st30-a1');
    expect(await CouponAssignment.countDocuments({ phoneNormalized: { $ne: null } })).toBe(2);
  });

  it('does not assign for an order that is not delivered, and returns null when the pool is empty', async () => {
    await addToPool(['st30-only']);
    const pending = await createOrder({ phone: nextPhone() });
    expect(await assignCouponOnDelivery(pending)).toBeNull();
    expect((await ensureCouponForOrder(await delivered())).code).toBe('st30-only');
    expect(await ensureCouponForOrder(await delivered())).toBeNull();
  });
});

describe('customer-bound coupons: who may use a code', () => {
  it('lets only the assigned phone use it, with one message for every failure', async () => {
    await addToPool(['st30-own']);
    const order = await delivered();
    await ensureCouponForOrder(order);
    const phone = order.customer.phoneNormalized;

    expect((await check({ code: 'ST30-OWN', phone })).body).toEqual({ ok: true });
    expect((await check({ code: 'st30-own', phone: '+2 ' + phone })).body).toEqual({ ok: true });

    const other = await check({ code: 'st30-own', phone: '01099999999' });
    const unassigned = await (async () => {
      await addToPool(['st30-free']);
      return check({ code: 'st30-free', phone });
    })();
    expect(other.body).toEqual({ ok: false, message: 'هذا الكود به مشكلة ولا يمكن استخدامه.' });
    expect(unassigned.body).toEqual(other.body);

    // No phone typed yet: ask for it, do not reveal anything.
    const nophone = await check({ code: 'st30-own' });
    expect(nophone.body.ok).toBe(false);
    expect(nophone.body.reason).toBe('phone_required');

    // Codes we do not manage are left to EasyOrders.
    expect((await check({ code: 'some-other-code', phone })).body).toEqual({ ok: true });
  });

  it('can be used on many orders, until it expires', async () => {
    await addToPool(['st30-use', 'st30-old']);
    const a = await delivered();
    const b = await delivered();
    await ensureCouponForOrder(a);
    await ensureCouponForOrder(b);

    await createOrder({ phone: a.customer.phone, coupon_code: 'st30-use' });
    await createOrder({ phone: a.customer.phone, coupon_code: 'st30-use' });
    expect((await evaluateCoupon('st30-use', a.customer.phoneNormalized)).allowed).toBe(true);
    expect(await Order.countDocuments({ 'couponFlag.active': true })).toBe(0);

    await CouponAssignment.updateOne({ code: 'st30-old' }, { $set: { expiresAt: new Date(Date.now() - DAY) } });
    expect((await check({ code: 'st30-old', phone: b.customer.phoneNormalized })).body.ok).toBe(false);
  });

  it('ignores a coupon that is not bound to customers', async () => {
    await addToPool(['st30-free2']);
    await CouponAssignment.updateOne({ code: 'st30-free2' }, { $set: { bound: false } });
    expect((await check({ code: 'st30-free2', phone: '01011112222' })).body).toEqual({ ok: true });
    // And it never goes to a customer from the pool.
    expect(await ensureCouponForOrder(await delivered())).toBeNull();
  });

  it('applies the same rule to a founder personal code and its 12 months', async () => {
    const order = await delivered();
    const founder = await assignFounderForOrder(order);
    await Founder.updateOne({ _id: founder._id }, { $set: { personalCode: 'f01-me' } });
    expect((await check({ code: 'f01-me', phone: order.customer.phoneNormalized })).body.ok).toBe(true);
    expect((await check({ code: 'f01-me', phone: '01088888888' })).body.ok).toBe(false);
    await Founder.updateOne({ _id: founder._id }, { $set: { benefitUntil: new Date(Date.now() - DAY) } });
    expect((await check({ code: 'f01-me', phone: order.customer.phoneNormalized })).body.ok).toBe(false);
  });

  it('only accepts the storefront origin and validates the body', async () => {
    const bad = await request(getTestApp()).post('/api/public/coupon-check').set('Origin', 'https://evil.example').send({ code: 'x' });
    expect(bad.status).toBe(403);
    expect((await check({ code: 'x', extra: 1 })).status).toBe(400);
  });
});

describe('orders that arrive with someone else\'s coupon', () => {
  it('flags the order, and lists it in the coupons tab', async () => {
    await addToPool(['st30-flag']);
    const owner = await delivered();
    await ensureCouponForOrder(owner);
    const own = await createOrder({ phone: owner.customer.phone, coupon_code: 'ST30-FLAG' });
    expect(own.couponFlag?.active).toBeFalsy();

    const stolen = await createOrder({ phone: nextPhone(), coupon_code: 'st30-flag' });
    const fresh = await Order.findById(stolen._id).lean();
    expect(fresh.couponFlag).toMatchObject({ active: true, reason: 'wrong_phone' });
    expect(fresh.couponCode).toBe('st30-flag');

    const admin = await loginAs(await createUser('admin'));
    const list = await admin.get('/api/admin/coupons');
    expect(list.status).toBe(200);
    expect(list.body.flagged.map((o) => String(o._id))).toContain(String(stolen._id));
    expect(list.body.summary).toMatchObject({ total: 1, assigned: 1, flagged: 1 });

    const flagged = await admin.get('/api/admin/orders?couponFlagged=true');
    expect(flagged.body.items.map((o) => String(o._id))).toEqual([String(stolen._id)]);
  });
});

describe('coupons admin API and order buttons', () => {
  it('is admin only', async () => {
    expect((await request(getTestApp()).get('/api/admin/coupons')).status).toBe(401);
    const courier = await loginAs(await createUser('courier'));
    expect((await courier.get('/api/admin/coupons')).status).toBe(403);
  });

  it('adds codes, assigns from an order row, marks sent, and lists unconfirmed orders', async () => {
    const admin = await loginAs(await createUser('admin'));
    const added = await admin.post('/api/admin/coupons', { codes: ['ST30-X1', 'st30-x2'] });
    expect(added.status).toBe(201);
    expect(added.body.added).toBe(2);
    expect((await admin.post('/api/admin/coupons', { codes: ['bad code!'] })).status).toBe(422);

    const order = await createOrder({ phone: nextPhone(), status: 'pending' });
    const given = await admin.post(`/api/admin/orders/${order._id}/coupon`);
    expect(given.body.coupon.code).toBe('st30-x1');
    // Pressing again gives the same code.
    expect((await admin.post(`/api/admin/orders/${order._id}/coupon`)).body.coupon.code).toBe('st30-x1');

    const sent = await admin.post(`/api/admin/coupons/${given.body.coupon._id}/sent`);
    expect(sent.status).toBe(200);

    const listed = await admin.get('/api/admin/orders');
    const row = listed.body.items.find((o) => String(o._id) === String(order._id));
    expect(row.couponAssignment.code).toBe('st30-x1');
    expect(row.couponAssignment.sentAt).toBeTruthy();

    const detail = await admin.get(`/api/admin/orders/${order._id}`);
    expect(detail.body.order.couponAssignment.code).toBe('st30-x1');

    const unconfirmed = await admin.get('/api/admin/orders?unconfirmed=true');
    expect(unconfirmed.body.items.map((o) => String(o._id))).toEqual([String(order._id)]);

    const conf = await admin.post(`/api/admin/orders/${order._id}/confirmation-sent`);
    expect(conf.status).toBe(200);
    expect((await Order.findById(order._id)).confirmationSentAt).toBeTruthy();

    // Manual assign, then release (not used yet).
    const rows = (await admin.get('/api/admin/coupons')).body.items;
    const free = rows.find((r) => !r.phoneNormalized);
    const manual = await admin.post(`/api/admin/coupons/${free._id}/assign`, { phone: '01012345678', name: 'سارة' });
    expect(manual.status).toBe(200);
    expect(Math.round((new Date(manual.body.coupon.expiresAt) - new Date(manual.body.coupon.assignedAt)) / DAY)).toBe(365);
    expect((await admin.post(`/api/admin/coupons/${free._id}/release`)).status).toBe(200);
  });
});

describe('wrong attempts are logged for the owner', () => {
  it('records who tried, what they typed and which device, and notifies the admins once', async () => {
    const { CouponAttempt, Notification, StorefrontCart } = await import('../src/models/index.js');
    const admin = await createUser('admin');
    await addToPool(['st30-spy']);
    const owner = await delivered();
    await ensureCouponForOrder(owner);

    const visitorId = 'test-visitor-0000000000000001';
    await StorefrontCart.create({
      visitorId,
      items: [{ slug: 's', name: 'S', size: '42', qty: 1, price: 100000 }],
      value: 100000,
      itemsCount: 1,
      customer: { name: 'منتحل', phone: '01077777777', phoneNormalized: '01077777777' },
      status: 'open',
      active: true,
      lastSeenAt: new Date(),
      lastActivityAt: new Date(),
    });

    const body = { code: 'ST30-SPY', phone: '٠١٠٩٩٩٩٩٩٩٩', name: 'منتحل', visitorId, stage: 'apply' };
    expect((await check(body)).body.ok).toBe(false);
    expect((await check(body)).body.ok).toBe(false);
    expect((await check({ code: 'st30-spy', phone: '123', visitorId })).body.ok).toBe(false);
    // No phone typed yet is not an attempt.
    expect((await check({ code: 'st30-spy', visitorId })).body.reason).toBe('phone_required');

    expect(await CouponAttempt.countDocuments()).toBe(3);
    const first = await CouponAttempt.findOne({ reason: 'wrong_phone' }).lean();
    expect(first).toMatchObject({ code: 'st30-spy', phoneNormalized: '01099999999', ownerPhone: owner.customer.phoneNormalized });
    // Same person, same code, same day: one notification. The malformed phone is a new key by visitor, so no second one.
    expect(await Notification.countDocuments({ user: admin._id, type: 'coupon_attempt' })).toBe(1);

    const api = await loginAs(admin);
    const list = await api.get('/api/admin/coupons/attempts');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items[0].visitorContact).toMatchObject({ name: 'منتحل', phone: '01077777777' });
  });
});

describe('365 days start the day the code is sent', () => {
  it('moves the expiry to sentAt + 365 days on the first send only', async () => {
    const admin = await loginAs(await createUser('admin'));
    await addToPool(['st30-send']);
    const order = await createOrder({ phone: nextPhone() });
    const given = (await admin.post(`/api/admin/orders/${order._id}/coupon`)).body.coupon;
    await CouponAssignment.updateOne({ _id: given._id }, { $set: { assignedAt: new Date(Date.now() - 10 * DAY) } });

    const sent = (await admin.post(`/api/admin/coupons/${given._id}/sent`)).body.coupon;
    expect(Math.round((new Date(sent.expiresAt) - new Date(sent.sentAt)) / DAY)).toBe(365);
    const again = (await admin.post(`/api/admin/coupons/${given._id}/sent`)).body.coupon;
    expect(again.sentAt).toBe(sent.sentAt);
    expect(again.expiresAt).toBe(sent.expiresAt);
  });
});

const eoCoupon = (code, extra = {}) => ({
  id: `eo-${code}`,
  code,
  value_type: 'percentage',
  value: 15,
  usage_limit: 1,
  usage_count: 0,
  is_active: true,
  starts_at: null,
  expires_at: null,
  ...extra,
});

describe('EasyOrders coupons: import, edit, sync', () => {
  it('imports full coupons, edits settings here, and the sync applies them', async () => {
    const admin = await loginAs(await createUser('admin'));
    const imp = await admin.post('/api/admin/coupons/import', { coupons: [eoCoupon('ST30-AA11'), eoCoupon('in-internal'), eoCoupon('tst-9k4m7x')] });
    expect(imp.body).toEqual({ created: 3, updated: 0 });
    const rows = (await admin.get('/api/admin/coupons')).body.items;
    expect(rows.find((r) => r.code === 'st30-aa11')).toMatchObject({ bound: true, settings: { value: 15, usageLimit: 1, isActive: true } });
    expect(rows.find((r) => r.code === 'in-internal').bound).toBe(false);

    const row = rows.find((r) => r.code === 'st30-aa11');
    const edit = await admin.patch(`/api/admin/coupons/${row._id}/settings`, { usageLimit: 0, value: 20 });
    expect(edit.status).toBe(200);
    expect(edit.body.coupon.pendingEo).toEqual({ usage_limit: 0, value: 20 });
    expect((await admin.patch(`/api/admin/coupons/${row._id}/settings`, { value: 150 })).status).toBe(400);

    // Sync needs the secret and the right origin.
    process.env.COUPON_SYNC_SECRET = 'sync-secret-for-tests';
    const { resetConfig } = await import('../src/config/env.js');
    resetConfig();
    const post = (secret) =>
      request(getTestApp())
        .post('/api/coupon-sync/exchange')
        .set('Origin', 'https://app.easy-orders.net')
        .set('X-Sync-Secret', secret)
        .send({ coupons: [eoCoupon('st30-aa11')] });
    expect((await post('wrong')).status).toBe(401);
    const ok = await post('sync-secret-for-tests');
    expect(ok.status).toBe(200);
    expect(ok.body.pending).toEqual([{ id: 'eo-st30-aa11', code: 'st30-aa11', patch: { usage_limit: 0, value: 20 } }]);

    // After EasyOrders has the change, the next exchange clears it.
    const done = await request(getTestApp())
      .post('/api/coupon-sync/exchange')
      .set('Origin', 'https://app.easy-orders.net')
      .set('X-Sync-Secret', 'sync-secret-for-tests')
      .send({ coupons: [eoCoupon('st30-aa11', { usage_limit: 0, value: 20 })] });
    expect(done.body.pending).toEqual([]);
    expect((await CouponAssignment.findOne({ code: 'st30-aa11' }).lean()).pendingEo).toBeNull();

    const wrongOrigin = await request(getTestApp())
      .options('/api/coupon-sync/exchange')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(wrongOrigin.headers['access-control-allow-origin']).toBeUndefined();
    delete process.env.COUPON_SYNC_SECRET;
    resetConfig();
    expect((await post('sync-secret-for-tests')).status).toBe(503);
  });
});

describe('the owner controls the dates and can undo', () => {
  it('edits start and end by hand, and undoes each change in reverse', async () => {
    const admin = await loginAs(await createUser('admin'));
    await addToPool(['st30-ctl']);
    const order = await createOrder({ phone: nextPhone() });
    const given = (await admin.post(`/api/admin/orders/${order._id}/coupon`)).body.coupon;

    // Send, then set the dates by hand.
    await admin.post(`/api/admin/coupons/${given._id}/sent`);
    const edited = await admin.patch(`/api/admin/coupons/${given._id}/dates`, { sentAt: '2026-12-01T12:00:00.000Z' });
    expect(edited.status).toBe(200);
    expect(edited.body.coupon.sentAt).toBe('2026-12-01T12:00:00.000Z');
    expect(Math.round((new Date(edited.body.coupon.expiresAt) - new Date('2026-12-01T12:00:00.000Z')) / DAY)).toBe(365);

    const both = await admin.patch(`/api/admin/coupons/${given._id}/dates`, { sentAt: '2026-12-01T12:00:00.000Z', expiresAt: '2027-03-01T12:00:00.000Z' });
    expect(both.body.coupon.expiresAt).toBe('2027-03-01T12:00:00.000Z');
    expect((await admin.patch(`/api/admin/coupons/${given._id}/dates`, { expiresAt: '2026-01-01T00:00:00.000Z' })).status).toBe(422);
    expect((await admin.patch(`/api/admin/coupons/${given._id}/dates`, {})).status).toBe(400);
    expect((await admin.patch(`/api/admin/coupons/${given._id}/dates`, { expiresAt: 'not a date' })).status).toBe(400);

    // The rejected edit changed nothing, and shows as the last change only once.
    let row = (await admin.get('/api/admin/coupons')).body.items.find((r) => r._id === given._id);
    expect(row.expiresAt).toBe('2027-03-01T12:00:00.000Z');
    expect(row.lastChange.action).toBe('dates');

    // Undo: back to the first edit, then before it, then the send, then the assignment.
    expect((await admin.post(`/api/admin/coupons/${given._id}/undo`)).body.coupon.expiresAt).not.toBe('2027-03-01T12:00:00.000Z');
    await admin.post(`/api/admin/coupons/${given._id}/undo`);
    const unsent = await admin.post(`/api/admin/coupons/${given._id}/undo`);
    expect(unsent.body.coupon.sentAt).toBeNull();
    const freed = await admin.post(`/api/admin/coupons/${given._id}/undo`);
    expect(freed.body.coupon.phoneNormalized).toBeNull();
    expect((await admin.post(`/api/admin/coupons/${given._id}/undo`)).status).toBe(422);
  });

  it('can release a code that was already sent, and undo brings it back', async () => {
    const admin = await loginAs(await createUser('admin'));
    await addToPool(['st30-rel']);
    const order = await createOrder({ phone: nextPhone() });
    const given = (await admin.post(`/api/admin/orders/${order._id}/coupon`)).body.coupon;
    await admin.post(`/api/admin/coupons/${given._id}/sent`);

    const released = await admin.post(`/api/admin/coupons/${given._id}/release`);
    expect(released.status).toBe(200);
    expect(released.body.coupon.phoneNormalized).toBeNull();
    const back = await admin.post(`/api/admin/coupons/${given._id}/undo`);
    expect(back.body.coupon.phoneNormalized).toBe(order.customer.phoneNormalized);
    expect(back.body.coupon.sentAt).toBeTruthy();

    // If the customer got another code meanwhile, the undo refuses instead of creating two.
    await admin.post(`/api/admin/coupons/${given._id}/release`);
    await addToPool(['st30-rel-b']);
    const other = await CouponAssignment.findOne({ code: 'st30-rel-b' }).lean();
    await admin.post(`/api/admin/coupons/${other._id}/assign`, { phone: order.customer.phoneNormalized, name: 'x' });
    expect((await admin.post(`/api/admin/coupons/${given._id}/undo`)).status).toBe(422);
  });
});
