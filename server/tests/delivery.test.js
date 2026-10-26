import { describe, expect, it } from 'vitest';
import { DeliveryReview, Notification, Order, OrderEvent, SyncOperation } from '../src/models/index.js';
import { approveReview } from '../src/services/deliveryService.js';
import {
  createAssignedOrder,
  createUser,
  enableEasyOrdersApi,
  loginAs,
  mockEasyOrders,
} from './helpers.js';

async function setup({ status = 'out_for_delivery' } = {}) {
  const admin = await createUser('admin');
  const courier = await createUser('courier');
  const order = await createAssignedOrder(courier, admin, {}, status);
  return { admin, courier, order, courierApi: await loginAs(courier), adminApi: await loginAs(admin) };
}

describe('courier delivery workflow', () => {
  it('starts a delivery and records the in_delivery sync intent', async () => {
    enableEasyOrdersApi();
    const calls = mockEasyOrders(() => ({ status: 200, body: {} }));
    const { order, courierApi } = await setup({ status: 'assigned' });
    const res = await courierApi.patch(`/api/courier/orders/${order._id}/status`, { status: 'out_for_delivery' });
    expect(res.status).toBe(200);
    expect(res.body.order.deliveryStatus).toBe('out_for_delivery');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].body).toEqual({ status: 'in_delivery' });
    expect(calls[0].headers['Api-Key']).toBe('test-api-key');
    expect((await Order.findById(order._id)).sourceStatus).toBe('in_delivery');
  });

  it('records failed delivery attempts with reasons and never cancels the external order', async () => {
    enableEasyOrdersApi();
    const calls = mockEasyOrders(() => ({ status: 200, body: {} }));
    const { order, courierApi } = await setup();
    const missingNote = await courierApi.patch(`/api/courier/orders/${order._id}/status`, { status: 'failed', reason: 'other' });
    expect(missingNote.status).toBe(400);
    const invalid = await courierApi.patch(`/api/courier/orders/${order._id}/status`, { status: 'failed', reason: 'made_up' });
    expect(invalid.status).toBe(400);
    const res = await courierApi.patch(`/api/courier/orders/${order._id}/status`, { status: 'failed', reason: 'no_answer' });
    expect(res.status).toBe(200);
    const stored = await Order.findById(order._id);
    expect(stored.deliveryStatus).toBe('failed');
    expect(stored.sourceStatus).toBe('confirmed');
    expect(stored.deliveryAttempts).toHaveLength(1);
    expect(stored.deliveryAttempts[0].reason).toBe('no_answer');
    expect(calls).toHaveLength(0);
  });

  it('submits delivery for review without updating EasyOrders', async () => {
    enableEasyOrdersApi();
    const calls = mockEasyOrders(() => ({ status: 200, body: {} }));
    const { order, courierApi } = await setup();
    const missingAmount = await courierApi.post(`/api/courier/orders/${order._id}/delivery-report`, {});
    expect(missingAmount.status).toBe(400);

    const res = await courierApi.post(`/api/courier/orders/${order._id}/delivery-report`, { collectedAmount: '1050', note: 'تم' });
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('تم إرسال الطلب للمراجعة');
    const stored = await Order.findById(order._id);
    expect(stored.deliveryStatus).toBe('pending_delivery_review');
    expect(stored.sourceStatus).toBe('confirmed');
    expect(stored.cod.declaredAmount).toBe(105000);
    expect(await DeliveryReview.countDocuments({ order: order._id, status: 'pending' })).toBe(1);
    expect(calls).toHaveLength(0);
    expect(await SyncOperation.countDocuments({})).toBe(0);

    const again = await courierApi.post(`/api/courier/orders/${order._id}/delivery-report`, { collectedAmount: '1050' });
    expect(again.status).toBe(422);
    expect(await DeliveryReview.countDocuments({ order: order._id })).toBe(1);
  });
});

describe('supervisor review', () => {
  async function submitted() {
    const ctx = await setup();
    const res = await ctx.courierApi.post(`/api/courier/orders/${ctx.order._id}/delivery-report`, { collectedAmount: 1050 });
    return { ...ctx, reviewId: res.body.review._id };
  }

  it('approves, marks delivered and syncs `delivered` only after EasyOrders confirms', async () => {
    enableEasyOrdersApi();
    const calls = mockEasyOrders(() => ({ status: 200, body: { status: 'delivered' } }));
    const { adminApi, reviewId, order } = await submitted();
    const list = await adminApi.get('/api/admin/delivery-reviews?status=pending');
    expect(list.body.items).toHaveLength(1);

    const res = await adminApi.post(`/api/admin/delivery-reviews/${reviewId}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.order.deliveryStatus).toBe('delivered');
    expect(res.body.review.status).toBe('approved');
    expect(res.body.review.syncStatus).toBe('synced');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.easy-orders.net/api/v1/external-apps/orders/${order.easyOrdersId}/status`);
    expect(calls[0].body).toEqual({ status: 'delivered' });
    const stored = await Order.findById(order._id);
    expect(stored.sourceStatus).toBe('delivered');
    expect(stored.sync.state).toBe('synced');
  });

  it('keeps the approval but shows a failed sync when EasyOrders is not configured', async () => {
    const { adminApi, reviewId, order } = await submitted();
    const res = await adminApi.post(`/api/admin/delivery-reviews/${reviewId}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.order.deliveryStatus).toBe('delivered');
    expect(res.body.review.syncStatus).toBe('failed');
    const stored = await Order.findById(order._id);
    expect(stored.sourceStatus).toBe('confirmed'); // never claimed as updated
    expect(stored.sync.state).toBe('failed');
  });

  it('prevents duplicate and concurrent approvals', async () => {
    enableEasyOrdersApi();
    const calls = mockEasyOrders(() => ({ status: 200, body: {} }));
    const { adminApi, reviewId } = await submitted();
    const admin2 = await createUser('admin');
    const adminApi2 = await loginAs(admin2);
    const [r1, r2] = await Promise.all([
      adminApi.post(`/api/admin/delivery-reviews/${reviewId}/approve`),
      adminApi2.post(`/api/admin/delivery-reviews/${reviewId}/approve`),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const again = await adminApi.post(`/api/admin/delivery-reviews/${reviewId}/approve`);
    expect(again.status).toBe(409);
    expect(await SyncOperation.countDocuments({})).toBe(1);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
  });

  it('does not allow couriers to approve their own (or any) delivery report', async () => {
    const { courierApi, reviewId } = await submitted();
    expect((await courierApi.post(`/api/admin/delivery-reviews/${reviewId}/approve`)).status).toBe(403);
    expect((await DeliveryReview.findById(reviewId)).status).toBe('pending');
  });

  it('blocks self-approval even at the service level', async () => {
    const admin = await createUser('admin');
    const order = await createAssignedOrder(admin, admin, {}, 'pending_delivery_review');
    const review = await DeliveryReview.create({ order: order._id, courier: admin._id });
    await Order.updateOne({ _id: order._id }, { $set: { currentReview: review._id } });
    await expect(approveReview(admin, review._id)).rejects.toMatchObject({ code: 'SELF_REVIEW_FORBIDDEN' });
  });

  it('requires a rejection reason, returns the order to the courier and keeps history', async () => {
    enableEasyOrdersApi();
    const calls = mockEasyOrders(() => ({ status: 200, body: {} }));
    const { adminApi, courierApi, reviewId, order, courier } = await submitted();

    expect((await adminApi.post(`/api/admin/delivery-reviews/${reviewId}/reject`, {})).status).toBe(400);
    expect((await adminApi.post(`/api/admin/delivery-reviews/${reviewId}/reject`, { reason: '  ' })).status).toBe(400);

    const res = await adminApi.post(`/api/admin/delivery-reviews/${reviewId}/reject`, { reason: 'العميل أكد عدم الاستلام' });
    expect(res.status).toBe(200);
    expect(res.body.order.deliveryStatus).toBe('out_for_delivery');
    expect(calls).toHaveLength(0);
    const note = await Notification.findOne({ user: courier._id, type: 'review_rejected' });
    expect(note.message).toContain('العميل أكد عدم الاستلام');

    const view = await courierApi.get(`/api/courier/orders/${order._id}`);
    expect(view.body.reviews[0]).toMatchObject({ status: 'rejected', rejectionReason: 'العميل أكد عدم الاستلام' });
    expect(view.body.allowedActions).toEqual(['submit_delivery', 'report_failed']);

    // Resubmission creates a new review and keeps the rejected one.
    const resubmit = await courierApi.post(`/api/courier/orders/${order._id}/delivery-report`, { collectedAmount: 1050 });
    expect(resubmit.status).toBe(201);
    const reviews = await DeliveryReview.find({ order: order._id }).sort({ submittedAt: 1 });
    expect(reviews.map((r) => r.status)).toEqual(['rejected', 'pending']);
    expect(reviews[1].submissionNumber).toBe(2);
    const events = (await OrderEvent.find({ order: order._id })).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(['delivery_submitted', 'review_rejected']));
  });

  it('cannot approve a review that was already rejected', async () => {
    const { adminApi, reviewId } = await submitted();
    await adminApi.post(`/api/admin/delivery-reviews/${reviewId}/reject`, { reason: 'سبب واضح' });
    expect((await adminApi.post(`/api/admin/delivery-reviews/${reviewId}/approve`)).status).toBe(409);
  });
});
