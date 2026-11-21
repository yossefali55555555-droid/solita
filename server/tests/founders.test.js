import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Founder, Order, SiteSettings } from '../src/models/index.js';
import { assignFounderForOrder } from '../src/services/founderService.js';
import { normalizeEasyOrdersOrder } from '../src/integrations/easyorders/normalize.js';
import { createOrder, createUser, getTestApp, loginAs, orderPayload } from './helpers.js';

let phoneCounter = 0;
const nextPhone = () => `0100${String(1000000 + ++phoneCounter)}`;

async function deliveredOrder(overrides = {}) {
  const order = await createOrder({ phone: nextPhone(), ...overrides });
  await Order.updateOne({ _id: order._id }, { $set: { deliveryStatus: 'delivered', deliveredAt: new Date() } });
  return Order.findById(order._id);
}

describe('coupon fields from EasyOrders', () => {
  it('reads coupon_code (lowercase) and coupon_discount into the order', async () => {
    const n = normalizeEasyOrdersOrder(orderPayload({ coupon_code: 'ST30-A7K2', coupon_discount: 6.49 }));
    expect(n.couponCode).toBe('st30-a7k2');
    expect(n.couponDiscount).toBe(649);
    const none = normalizeEasyOrdersOrder(orderPayload());
    expect(none.couponCode).toBeUndefined();

    const order = await createOrder({ coupon_code: 'F07-FRND', coupon_discount: 100 });
    expect(order.couponCode).toBe('f07-frnd');
    expect(order.couponDiscount).toBe(10000);
  });
});

describe('founder numbering', () => {
  it('numbers delivered customers in order, once per phone and once per order', async () => {
    const a = await deliveredOrder();
    const b = await deliveredOrder();
    const f1 = await assignFounderForOrder(a);
    const f2 = await assignFounderForOrder(b);
    expect([f1.number, f2.number]).toEqual([1, 2]);
    expect(f1.benefitUntil.getUTCFullYear()).toBe(f1.joinedAt.getUTCFullYear() + 1);

    expect(await assignFounderForOrder(a)).toBeNull(); // same order
    const again = await deliveredOrder({ phone: a.customer.phone }); // same customer, new order
    expect(await assignFounderForOrder(again)).toBeNull();
    expect(await Founder.countDocuments()).toBe(2);
  });

  it('ignores orders that are not delivered, and stops at the cap', async () => {
    const pending = await createOrder({ phone: nextPhone() });
    expect(await assignFounderForOrder(pending)).toBeNull();

    await SiteSettings.create({ key: 'site', revision: 1, settings: { founders: { enabled: true, cap: 2, showCounterAfter: 1 } } });
    expect(await assignFounderForOrder(await deliveredOrder())).not.toBeNull();
    expect(await assignFounderForOrder(await deliveredOrder())).not.toBeNull();
    expect(await assignFounderForOrder(await deliveredOrder())).toBeNull();
    expect(await Founder.countDocuments()).toBe(2);
  });

  it('does nothing when the program is switched off', async () => {
    await SiteSettings.create({ key: 'site', revision: 1, settings: { founders: { enabled: false, cap: 50, showCounterAfter: 10 } } });
    expect(await assignFounderForOrder(await deliveredOrder())).toBeNull();
  });
});

describe('founders admin API and public counter', () => {
  it('is admin only', async () => {
    expect((await request(getTestApp()).get('/api/admin/founders')).status).toBe(401);
    const courier = await loginAs(await createUser('courier'));
    expect((await courier.get('/api/admin/founders')).status).toBe(403);
  });

  it('lists founders with referrals, validates codes and keeps them unique', async () => {
    const admin = await loginAs(await createUser('admin'));
    const f1 = await assignFounderForOrder(await deliveredOrder());
    const f2 = await assignFounderForOrder(await deliveredOrder());

    const set = await admin.patch(`/api/admin/founders/${f1._id}`, { friendCode: 'F01-Friend', personalCode: 'f01-me', notes: 'x' });
    expect(set.status).toBe(200);
    expect(set.body.founder.friendCode).toBe('f01-friend');

    await createOrder({ phone: nextPhone(), coupon_code: 'f01-friend' });
    await createOrder({ phone: nextPhone(), coupon_code: 'F01-FRIEND' });
    await createOrder({ phone: nextPhone(), coupon_code: 'f01-friend', status: 'canceled' });

    const list = await admin.get('/api/admin/founders');
    expect(list.status).toBe(200);
    const row = list.body.items.find((x) => x._id === String(f1._id));
    expect(row.referrals).toBe(2);
    expect(row.drawEntries).toBe(3);
    expect(list.body.summary).toMatchObject({ cap: 50, taken: 2, remaining: 48 });

    const clash = await admin.patch(`/api/admin/founders/${f2._id}`, { personalCode: 'f01-friend' });
    expect(clash.status).toBe(422);
    const bad = await admin.patch(`/api/admin/founders/${f2._id}`, { friendCode: 'no spaces!' });
    expect(bad.status).toBe(400);
    const unknown = await admin.patch(`/api/admin/founders/${f2._id}`, { number: 9 });
    expect(unknown.status).toBe(400);
  });

  it('exposes only counts on the public site-config, and hides the counter until the threshold', async () => {
    const before = await request(getTestApp()).get('/api/public/site-config');
    expect(before.body.settings.founders).toEqual({ enabled: true, cap: 50, taken: 0, remaining: 50, showCounter: false });

    await SiteSettings.create({ key: 'site', revision: 1, settings: { founders: { enabled: true, cap: 50, showCounterAfter: 2 } } });
    await assignFounderForOrder(await deliveredOrder());
    await assignFounderForOrder(await deliveredOrder());
    const after = await request(getTestApp()).get('/api/public/site-config');
    expect(after.body.settings.founders).toEqual({ enabled: true, cap: 50, taken: 2, remaining: 48, showCounter: true });
    expect(JSON.stringify(after.body)).not.toMatch(/phone|01\d{9}/);
  });
});
