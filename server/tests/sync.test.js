import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { DeliveryReview, Order, SyncOperation } from '../src/models/index.js';
import { enqueueStatusSync, processDueOperations, processOperation } from '../src/services/syncService.js';
import { createAssignedOrder, createOrder, createUser, enableEasyOrdersApi, getTestApp, loginAs, mockEasyOrders } from './helpers.js';

async function approvedOrder() {
  const admin = await createUser('admin');
  const courier = await createUser('courier');
  const order = await createAssignedOrder(courier, admin, {}, 'out_for_delivery');
  const courierApi = await loginAs(courier);
  const adminApi = await loginAs(admin);
  const sub = await courierApi.post(`/api/courier/orders/${order._id}/delivery-report`, { collectedAmount: 1050 });
  const approve = await adminApi.post(`/api/admin/delivery-reviews/${sub.body.review._id}/approve`);
  return { admin, adminApi, order, reviewId: sub.body.review._id, approve };
}

async function forceDue(opId) {
  await SyncOperation.updateOne({ _id: opId }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
}

describe('Solita → EasyOrders synchronization', () => {
  it('treats a server error as ambiguous and reconciles before retrying', async () => {
    enableEasyOrdersApi();
    let phase = 'fail';
    const calls = mockEasyOrders((call) => {
      if (phase === 'fail') return { status: 503, body: { message: 'down' } };
      if (call.method === 'GET') return { status: 200, body: { id: 'x', status: 'delivered' } };
      return { status: 200, body: {} };
    });
    const { approve, adminApi, reviewId, order } = await approvedOrder();
    expect(approve.status).toBe(200);
    expect(approve.body.order.deliveryStatus).toBe('delivered'); // approval preserved
    expect(approve.body.syncOperation.state).toBe('needs_reconciliation');
    expect((await Order.findById(order._id)).sourceStatus).toBe('confirmed');

    const failures = await adminApi.get('/api/admin/sync/failures');
    expect(failures.body.items).toHaveLength(1);

    phase = 'ok';
    const retry = await adminApi.post(`/api/admin/sync/${approve.body.syncOperation._id}/retry`);
    expect(retry.status).toBe(200);
    expect(retry.body.operation.state).toBe('succeeded');
    expect(retry.body.operation.reconciledVia).toBe('api_check');
    // The reconciliation read showed the change was applied: no second PATCH.
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect((await DeliveryReview.findById(reviewId)).syncStatus).toBe('synced');
    expect((await Order.findById(order._id)).sourceStatus).toBe('delivered');
  });

  it('handles HTTP 429 by rescheduling without consuming the retry budget', async () => {
    enableEasyOrdersApi();
    mockEasyOrders(() => ({ status: 429, body: {}, headers: { 'retry-after': '30' } }));
    const { approve } = await approvedOrder();
    const op = await SyncOperation.findById(approve.body.syncOperation._id);
    expect(op.state).toBe('retry_scheduled');
    expect(op.attempts).toBe(0);
    expect(op.rateLimitedCount).toBe(1);
    expect(op.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 25_000);
    // Not due yet: background processing leaves it alone.
    const result = await processDueOperations();
    expect(result.processed).toBe(0);
  });

  it('does not retry permanent 4xx errors automatically', async () => {
    enableEasyOrdersApi();
    const calls = mockEasyOrders(() => ({ status: 422, body: { message: 'invalid status transition' } }));
    const { approve } = await approvedOrder();
    const op = await SyncOperation.findById(approve.body.syncOperation._id);
    expect(op.state).toBe('failed');
    expect(op.permanentError).toBe(true);
    await processDueOperations();
    expect(calls).toHaveLength(1);
  });

  it('gives up after the maximum attempts on repeated connection errors', async () => {
    enableEasyOrdersApi();
    const { setFetchImplementation } = await import('../src/integrations/easyorders/client.js');
    let n = 0;
    setFetchImplementation(async () => {
      n += 1;
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    });
    const order = await createOrder();
    const op = await enqueueStatusSync({ order, targetStatus: 'processing', trigger: 'test', idempotencyKey: 'k-1' });
    for (let i = 0; i < 6; i += 1) {
      await forceDue(op._id);
      await processOperation(op._id);
    }
    const final = await SyncOperation.findById(op._id);
    expect(final.state).toBe('failed');
    expect(final.attempts).toBe(5);
    expect(n).toBe(5);
  });

  it('treats a timeout as ambiguous and reconciles; retries the PATCH if not applied', async () => {
    enableEasyOrdersApi();
    const { setFetchImplementation } = await import('../src/integrations/easyorders/client.js');
    const methods = [];
    let first = true;
    setFetchImplementation(async (_url, init) => {
      methods.push(init.method);
      if (first) {
        first = false;
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (init.method === 'GET') return new Response(JSON.stringify({ id: 'a', status: 'confirmed' }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    const order = await createOrder();
    const op = await enqueueStatusSync({ order, targetStatus: 'processing', trigger: 'test', idempotencyKey: 'k-2' });
    const afterFirst = await processOperation(op._id);
    expect(afterFirst.state).toBe('needs_reconciliation');
    await forceDue(op._id);
    const afterSecond = await processOperation(op._id);
    expect(afterSecond.state).toBe('succeeded');
    expect(methods).toEqual(['PATCH', 'GET', 'PATCH']);
  });

  it('stays under the documented rate limit with a persistent request budget', async () => {
    enableEasyOrdersApi();
    const calls = mockEasyOrders(() => ({ status: 200, body: {} }));
    const ops = [];
    for (let i = 0; i < 40; i += 1) {
      const order = await createOrder();
      ops.push(await enqueueStatusSync({ order, targetStatus: 'processing', trigger: 'test', idempotencyKey: `budget-${i}` }));
    }
    for (const op of ops) await processOperation(op._id);
    expect(calls.length).toBeLessThanOrEqual(35);
    expect(await SyncOperation.countDocuments({ state: 'retry_scheduled' })).toBeGreaterThan(0);
  });

  it('refuses to sync statuses that are not documented by EasyOrders (no invented "failed")', async () => {
    const order = await createOrder();
    await expect(
      enqueueStatusSync({ order, targetStatus: 'failed', trigger: 'test', idempotencyKey: 'bad' }),
    ).rejects.toThrow(/undocumented/);
  });

  it('records each intent once (idempotency key)', async () => {
    const order = await createOrder();
    const a = await enqueueStatusSync({ order, targetStatus: 'processing', trigger: 't', idempotencyKey: 'same' });
    const b = await enqueueStatusSync({ order, targetStatus: 'processing', trigger: 't', idempotencyKey: 'same' });
    expect(String(a._id)).toBe(String(b._id));
    expect(await SyncOperation.countDocuments({})).toBe(1);
  });

  it('processes due work from the cron endpoint only with the cron secret', async () => {
    const app = getTestApp();
    expect((await request(app).get('/api/cron/process')).status).toBe(401);
    const ok = await request(app).get('/api/cron/process').set('Authorization', 'Bearer test-cron-secret');
    expect(ok.status).toBe(200);
    expect(ok.body.operations).toBeDefined();
  });

  it('retries succeed after the API key is configured', async () => {
    const { approve, adminApi } = await approvedOrder();
    expect(approve.body.syncOperation.state).toBe('failed');
    enableEasyOrdersApi();
    mockEasyOrders(() => ({ status: 200, body: {} }));
    const retry = await adminApi.post(`/api/admin/sync/${approve.body.syncOperation._id}/retry`);
    expect(retry.body.operation.state).toBe('succeeded');
    expect((await adminApi.post(`/api/admin/sync/${approve.body.syncOperation._id}/retry`)).status).toBe(409);
  });
});
