import { describe, expect, it } from 'vitest';
import { MissedOrder, Order, StorefrontCart } from '../src/models/index.js';
import { adminUser, createAssignedOrder, createOrder, createUser, loginAs } from './helpers.js';

const moderator = (sections) => createUser('moderator', { permissions: { sections, dangerous: [], fields: [] } });

describe('navigation tab counts', () => {
  it('counts what waits on the «لم تكتمل» and print tabs', async () => {
    const admin = await adminUser();
    const courier = await createUser('courier');
    await createOrder({ short_id: 9101 }); // new, never printed → print queue
    const printed = await createAssignedOrder(courier, admin, { short_id: 9102 });
    await Order.updateOne({ _id: printed._id }, { $set: { 'labels.printedAt': new Date(), 'labels.total': 1 } });
    await MissedOrder.create([
      { key: 'k1', eoDate: new Date(), phoneNormalized: '01011111111', isTest: false },
      { key: 'k2', eoDate: new Date(), phoneNormalized: '01011111112', isTest: false, contactedAt: new Date() },
      { key: 'k3', eoDate: new Date(), phoneNormalized: '01011111113', isTest: false, dismissedAt: new Date() },
      { key: 'k4', eoDate: new Date(), phoneNormalized: '01011111114', isTest: true },
    ]);
    await StorefrontCart.create([
      { visitorId: 'v1', status: 'open', itemsCount: 1, lastActivityAt: new Date(), lastSeenAt: new Date() },
      { visitorId: 'v2', status: 'contacted', itemsCount: 1, lastActivityAt: new Date(), lastSeenAt: new Date() },
      { visitorId: 'v3', status: 'open', itemsCount: 0, lastActivityAt: new Date(), lastSeenAt: new Date() },
      { visitorId: 'v4', status: 'open', itemsCount: 2, lastActivityAt: new Date(Date.now() - 30 * 86400000), lastSeenAt: new Date() },
    ]);

    const api = await loginAs(admin);
    const res = await api.get('/api/admin/nav-counts');
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ missedOrders: 1, abandonedCarts: 1, reviews: 0, returns: 0 });

    // Same number as the print page shows on its tabs.
    const queue = await api.get('/api/admin/labels');
    expect(res.body.counts.labels).toBe(queue.body.counts.pending + queue.body.counts.reprint);
    expect(res.body.counts.labels).toBeGreaterThanOrEqual(1);
  });

  it('gives a moderator only the counts of the pages they may open', async () => {
    const api = await loginAs(await moderator({ warehouse: 'view' }));
    const res = await api.get('/api/admin/nav-counts');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.counts).sort()).toEqual(['labels', 'returns']);

    const none = await loginAs(await moderator({ orders: 'view' }));
    expect((await none.get('/api/admin/nav-counts')).status).toBe(403);
  });

  it('is closed to couriers', async () => {
    const api = await loginAs(await createUser('courier'));
    expect((await api.get('/api/admin/nav-counts')).status).toBe(403);
  });
});
