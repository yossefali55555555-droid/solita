import { describe, expect, it } from 'vitest';
import { IntegrationState, Order } from '../src/models/index.js';
import { pollEasyOrders } from '../src/services/pollService.js';
import { createOrder, createUser, enableEasyOrdersApi, loginAs, mockEasyOrders, orderPayload, postWebhook } from './helpers.js';

/** Fake EasyOrders store: orders keyed by short_id, also readable by id. */
function fakeStore(orders) {
  const byShort = new Map(orders.map((o) => [o.short_id, o]));
  const byId = new Map(orders.map((o) => [o.id, o]));
  const calls = mockEasyOrders((call) => {
    const short = call.url.match(/\/orders\/short\/(\d+)$/);
    if (short) {
      const o = byShort.get(Number(short[1]));
      return o ? { status: 200, body: o } : { status: 404, body: { message: 'not found' } };
    }
    const byIdMatch = call.url.match(/\/orders\/([^/]+)$/);
    const o = byIdMatch && byId.get(decodeURIComponent(byIdMatch[1]));
    return o ? { status: 200, body: o } : { status: 404, body: {} };
  });
  return { calls, add: (o) => { byShort.set(o.short_id, o); byId.set(o.id, o); } };
}

describe('EasyOrders pull sync (polling)', () => {
  it('asks for a starting order number when nothing is known yet', async () => {
    enableEasyOrdersApi();
    const { calls } = fakeStore([]);
    const result = await pollEasyOrders();
    expect(result.status).toBe('needs_start');
    expect(calls.filter((c) => c.url.includes('/short/'))).toHaveLength(0);
  });

  it('imports one order by number, then polling picks up the following numbers', async () => {
    enableEasyOrdersApi();
    const store = fakeStore([
      orderPayload({ id: 'uuid-43', short_id: 43 }),
      orderPayload({ id: 'uuid-44', short_id: 44 }),
      orderPayload({ id: 'uuid-45', short_id: 45 }),
    ]);
    const admin = await createUser('admin');
    const api = await loginAs(admin);

    const imported = await api.post('/api/admin/easyorders/import', { shortId: 43 });
    expect(imported.status).toBe(201);
    expect(imported.body.outcome).toBe('created');
    expect(imported.body.order.easyOrdersShortId).toBe(43);

    const res = await api.post('/api/admin/easyorders/poll');
    expect(res.status).toBe(200);
    expect(res.body.result.status).toBe('ok');
    expect(res.body.result.created).toBe(2);
    expect(res.body.status.lastShortId).toBe(45);
    // Stops after `missTolerance` consecutive unknown numbers.
    expect(res.body.result.checkedNumbers).toEqual([44, 45, 46, 47, 48]);
    expect(await Order.countDocuments()).toBe(3);

    // A new order appears later and the next poll finds it.
    store.add(orderPayload({ id: 'uuid-46', short_id: 46 }));
    const again = await pollEasyOrders({ refreshLimit: 0 });
    expect(again.created).toBe(1);
    expect(again.lastShortId).toBe(46);
  });

  it('does not duplicate an order that already arrived by webhook', async () => {
    enableEasyOrdersApi();
    const payload = orderPayload({ id: 'uuid-100', short_id: 100 });
    fakeStore([payload, orderPayload({ id: 'uuid-101', short_id: 101 })]);
    const hook = await postWebhook('orders', payload);
    expect(hook.status).toBe(200);
    expect((await Order.findOne({ easyOrdersId: 'uuid-100' })).easyOrdersShortId).toBe(100);

    const result = await pollEasyOrders({ refreshLimit: 0 });
    expect(result.created).toBe(1);
    expect(await Order.countDocuments({ easyOrdersId: 'uuid-100' })).toBe(1);
    expect(await Order.countDocuments()).toBe(2);
  });

  it('refreshes open orders so status changes made in EasyOrders show up', async () => {
    enableEasyOrdersApi();
    const order = await createOrder({ id: 'uuid-7', short_id: 7, status: 'pending' });
    fakeStore([orderPayload({ id: 'uuid-7', short_id: 7, status: 'canceled', updated_at: '2026-10-02T10:00:00.000Z' })]);
    const result = await pollEasyOrders();
    expect(result.refreshed).toBe(1);
    const fresh = await Order.findById(order._id);
    expect(fresh.sourceStatus).toBe('canceled');
    expect(fresh.deliveryStatus).toBe('cancelled');
  });

  it('stops on rate limiting and keeps the cursor at the last imported order', async () => {
    enableEasyOrdersApi();
    await createOrder({ id: 'uuid-10', short_id: 10 });
    mockEasyOrders((call) =>
      call.url.endsWith('/short/11')
        ? { status: 200, body: orderPayload({ id: 'uuid-11', short_id: 11 }) }
        : { status: 429, body: {}, headers: { 'retry-after': '20' } },
    );
    const result = await pollEasyOrders();
    expect(result.status).toBe('rate_limited');
    expect(result.created).toBe(1);
    expect((await IntegrationState.findOne({ key: 'easyorders_poll' })).lastShortId).toBe(11);
    expect((await IntegrationState.findOne({ key: 'easyorders_poll' })).lockedUntil).toBeNull();
  });

  it('does not run twice at the same time', async () => {
    enableEasyOrdersApi();
    fakeStore([]);
    await IntegrationState.create({ key: 'easyorders_poll', lockedUntil: new Date(Date.now() + 30_000) });
    expect((await pollEasyOrders()).status).toBe('already_running');
  });

  it('reports a missing order number clearly and validates input', async () => {
    enableEasyOrdersApi();
    fakeStore([]);
    const api = await loginAs(await createUser('admin'));
    const missing = await api.post('/api/admin/easyorders/import', { shortId: 999 });
    expect(missing.status).toBe(404);
    const invalid = await api.post('/api/admin/easyorders/import', { shortId: 'abc' });
    expect(invalid.status).toBe(400);
    const courierApi = await loginAs(await createUser('courier'));
    expect((await courierApi.post('/api/admin/easyorders/poll')).status).toBe(403);
  });

  it('is skipped without an API key', async () => {
    delete process.env.EASYORDERS_API_KEY;
    const { resetConfig } = await import('../src/config/env.js');
    resetConfig();
    expect((await pollEasyOrders()).status).toBe('not_configured');
  });
});
