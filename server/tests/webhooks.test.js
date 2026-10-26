import { describe, expect, it } from 'vitest';
import { DeliveryReview, Order, SyncOperation, WebhookEvent } from '../src/models/index.js';
import { processPendingWebhooks } from '../src/services/webhookService.js';
import { resetConfig } from '../src/config/env.js';
import {
  createAssignedOrder,
  createUser,
  enableEasyOrdersApi,
  loginAs,
  mockEasyOrders,
  orderPayload,
  postWebhook,
} from './helpers.js';

const statusPayload = (orderId, old_status, new_status) => ({
  event_type: 'order-status-update',
  order_id: orderId,
  old_status,
  new_status,
  payment_ref_id: null,
});

describe('EasyOrders webhooks', () => {
  it('authenticates with the documented `secret` header', async () => {
    const payload = orderPayload();
    expect((await postWebhook('orders', payload, null)).status).toBe(401);
    expect((await postWebhook('orders', payload, 'wrong')).status).toBe(401);
    expect(await Order.countDocuments({})).toBe(0);
    expect((await postWebhook('orders', payload)).status).toBe(200);
    expect(await Order.countDocuments({})).toBe(1);
  });

  it('rejects all webhooks when no secret is configured', async () => {
    delete process.env.EASYORDERS_WEBHOOK_SECRET;
    resetConfig();
    try {
      expect((await postWebhook('orders', orderPayload(), '')).status).toBe(503);
    } finally {
      process.env.EASYORDERS_WEBHOOK_SECRET = 'test-webhook-secret';
      resetConfig();
    }
  });

  it('deduplicates identical deliveries', async () => {
    const payload = orderPayload({ id: 'wh-dup' });
    const first = await postWebhook('orders', payload);
    const second = await postWebhook('orders', payload);
    expect(first.body.outcome).toBe('created');
    expect(second.body.duplicate).toBe(true);
    expect(await WebhookEvent.countDocuments({ externalOrderId: 'wh-dup' })).toBe(1);
    expect(await Order.countDocuments({ easyOrdersId: 'wh-dup' })).toBe(1);
  });

  it('ignores out-of-order (older) order updates', async () => {
    await postWebhook('orders', orderPayload({ id: 'ooo', updated_at: '2026-10-05T10:00:00Z', address: 'جديد' }));
    const stale = await postWebhook('orders', orderPayload({ id: 'ooo', updated_at: '2026-10-01T10:00:00Z', address: 'قديم' }));
    expect(stale.body.outcome).toBe('stale');
    expect((await Order.findOne({ easyOrdersId: 'ooo' })).customer.address).toBe('جديد');
  });

  it('applies status updates and keeps raw values (unknown statuses do not crash)', async () => {
    await postWebhook('orders', orderPayload({ id: 'st-1', status: 'pending' }));
    const res = await postWebhook('status', statusPayload('st-1', 'pending', 'paid'));
    expect(res.status).toBe(200);
    let order = await Order.findOne({ easyOrdersId: 'st-1' });
    expect(order.sourceStatus).toBe('paid');
    expect(order.paymentStatus).toBe('paid');
    expect(order.cod.expectedAmount).toBe(0);
    await postWebhook('status', statusPayload('st-1', 'paid', 'brand_new_status'));
    order = await Order.findOne({ easyOrdersId: 'st-1' });
    expect(order.sourceStatus).toBe('brand_new_status');
  });

  it('preserves internal assignment, review and cash data on source updates', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const order = await createAssignedOrder(courier, admin, { id: 'keep-1' }, 'out_for_delivery');
    const courierApi = await loginAs(courier);
    await courierApi.post(`/api/courier/orders/${order._id}/delivery-report`, { collectedAmount: 1050 });

    await postWebhook('orders', orderPayload({ id: 'keep-1', updated_at: '2026-10-09T00:00:00Z', address: 'عنوان معدل', status: 'processing' }));
    const stored = await Order.findById(order._id);
    expect(stored.customer.address).toBe('عنوان معدل');
    expect(stored.sourceStatus).toBe('processing');
    expect(String(stored.assignedTo)).toBe(String(courier._id));
    expect(stored.deliveryStatus).toBe('pending_delivery_review');
    expect(stored.cod.declaredAmount).toBe(105000);
    expect(await DeliveryReview.countDocuments({ order: order._id, status: 'pending' })).toBe(1);
  });

  it('does not wipe data when a partial payload arrives', async () => {
    await postWebhook('orders', orderPayload({ id: 'partial-1' }));
    const res = await postWebhook('orders', { id: 'partial-1', status: 'processing', updated_at: '2026-10-03T00:00:00Z' });
    expect(res.status).toBe(200);
    const order = await Order.findOne({ easyOrdersId: 'partial-1' });
    expect(order.items).toHaveLength(1);
    expect(order.customer.name).toBe('عميل اختبار');
    expect(order.sourceStatus).toBe('processing');
  });

  it('defers status events for unknown orders and resolves them later via the API', async () => {
    const res = await postWebhook('status', statusPayload('later-1', 'pending', 'confirmed'));
    expect(res.status).toBe(202);
    const event = await WebhookEvent.findOne({ externalOrderId: 'later-1' });
    expect(event.status).toBe('pending_retry');

    enableEasyOrdersApi();
    mockEasyOrders((call) => {
      expect(call.method).toBe('GET');
      return { status: 200, body: orderPayload({ id: 'later-1', status: 'confirmed' }) };
    });
    await WebhookEvent.updateOne({ _id: event._id }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const result = await processPendingWebhooks();
    expect(result.succeeded).toBe(1);
    expect((await Order.findOne({ easyOrdersId: 'later-1' })).sourceStatus).toBe('confirmed');
    const done = await WebhookEvent.findById(event._id).select('+payload');
    expect(done.status).toBe('processed');
    expect(done.payload).toBeUndefined(); // raw payload removed after success
  });

  it('refetches the authoritative order for out-of-sequence status events', async () => {
    await postWebhook('orders', orderPayload({ id: 'seq-1', status: 'pending' }));
    enableEasyOrdersApi();
    const calls = mockEasyOrders(() => ({
      status: 200,
      body: orderPayload({ id: 'seq-1', status: 'processing', updated_at: '2026-10-07T00:00:00Z' }),
    }));
    const res = await postWebhook('status', statusPayload('seq-1', 'confirmed', 'processing'));
    expect(res.body.outcome).toMatch(/^out_of_sequence/);
    expect(calls).toHaveLength(1);
    expect((await Order.findOne({ easyOrdersId: 'seq-1' })).sourceStatus).toBe('processing');
  });

  it('does not loop on its own updates (echo webhook creates no new sync work)', async () => {
    enableEasyOrdersApi();
    mockEasyOrders(() => ({ status: 200, body: {} }));
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const order = await createAssignedOrder(courier, admin, { id: 'echo-1' }, 'out_for_delivery');
    const courierApi = await loginAs(courier);
    const adminApi = await loginAs(admin);
    const sub = await courierApi.post(`/api/courier/orders/${order._id}/delivery-report`, { collectedAmount: 1050 });
    await adminApi.post(`/api/admin/delivery-reviews/${sub.body.review._id}/approve`);
    expect(await SyncOperation.countDocuments({})).toBe(1);

    const echo = await postWebhook('status', statusPayload('echo-1', 'confirmed', 'delivered'));
    expect(echo.body.outcome).toBe('no_change');
    expect(await SyncOperation.countDocuments({})).toBe(1);
    const stored = await Order.findById(order._id);
    expect(stored.sourceConflict?.active ?? false).toBe(false);
  });

  it('cancels the internal workflow when EasyOrders cancels, keeping the assignment', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const order = await createAssignedOrder(courier, admin, { id: 'cxl-1' });
    await postWebhook('status', statusPayload('cxl-1', 'confirmed', 'canceled'));
    const stored = await Order.findById(order._id);
    expect(stored.deliveryStatus).toBe('cancelled');
    expect(String(stored.assignedTo)).toBe(String(courier._id));
    expect(stored.cancellation.source).toBe('easyorders');
  });

  it('flags (but does not apply) a delivered status set directly in EasyOrders', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const order = await createAssignedOrder(courier, admin, { id: 'dlv-1' }, 'out_for_delivery');
    await postWebhook('status', statusPayload('dlv-1', 'confirmed', 'delivered'));
    const stored = await Order.findById(order._id);
    expect(stored.deliveryStatus).toBe('out_for_delivery');
    expect(stored.sourceStatus).toBe('delivered');
    expect(stored.sourceConflict.active).toBe(true);
  });

  it('accepts both payload shapes on either endpoint and ignores unrecognised payloads', async () => {
    expect((await postWebhook('status', orderPayload({ id: 'shape-1' }))).body.outcome).toBe('created');
    const unknown = await postWebhook('orders', { hello: 'world' });
    expect(unknown.status).toBe(200);
    expect(unknown.body.ignored).toBe(true);
  });
});
