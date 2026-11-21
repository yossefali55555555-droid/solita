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

  it('rejects a used code and an expired one', async () => {
    await addToPool(['st30-use', 'st30-old']);
    const a = await delivered();
    const b = await delivered();
    await ensureCouponForOrder(a);
    await ensureCouponForOrder(b);

    await createOrder({ phone: a.customer.phone, coupon_code: 'st30-use' });
    expect((await evaluateCoupon('st30-use', a.customer.phoneNormalized)).reason).toBe('already_used');

    await CouponAssignment.updateOne({ code: 'st30-old' }, { $set: { expiresAt: new Date(Date.now() - DAY) } });
    expect((await check({ code: 'st30-old', phone: b.customer.phoneNormalized })).body.ok).toBe(false);
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
