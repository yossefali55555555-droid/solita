import { describe, expect, it } from 'vitest';
import { Notification, Order, OrderEvent, SyncOperation } from '../src/models/index.js';
import { createAssignedOrder, createOrder, createUser, loginAs, orderPayload, postWebhook } from './helpers.js';

describe('orders and manual assignment', () => {
  it('prevents duplicate imports of the same EasyOrders order', async () => {
    const payload = orderPayload({ id: 'dup-1' });
    expect((await postWebhook('orders', payload)).status).toBe(200);
    const second = await postWebhook('orders', { ...payload, updated_at: '2026-10-02T10:00:00.000Z' });
    expect(second.status).toBe(200);
    expect(await Order.countDocuments({ easyOrdersId: 'dup-1' })).toBe(1);
    // The unique index is the final guard.
    await expect(Order.create({ easyOrdersId: 'dup-1' })).rejects.toMatchObject({ code: 11000 });
  });

  it('stores money as integer piasters and keeps raw source status', async () => {
    const order = await createOrder({ cost: '999.99', shipping_cost: 50.5, total_cost: 1040.49, status: 'some_new_status' });
    expect(order.subtotal).toBe(99999);
    expect(order.shippingFee).toBe(5050);
    expect(order.totalAmount).toBe(104049);
    expect(order.discount).toBe(1000);
    expect(order.sourceStatus).toBe('some_new_status');
    expect(order.deliveryStatus).toBe('new');
    expect(order.customer.phoneNormalized).toBe('01112223333');
  });

  it('assigns and reassigns manually without touching EasyOrders', async () => {
    const admin = await createUser('admin');
    const c1 = await createUser('courier');
    const c2 = await createUser('courier');
    const order = await createOrder();
    const api = await loginAs(admin);

    const a = await api.patch(`/api/admin/orders/${order._id}/assignment`, { courierId: String(c1._id) });
    expect(a.status).toBe(200);
    expect(a.body.order.deliveryStatus).toBe('assigned');
    expect(String(a.body.order.assignedTo._id)).toBe(String(c1._id));

    const r = await api.patch(`/api/admin/orders/${order._id}/assignment`, { courierId: String(c2._id), note: 'إعادة توزيع' });
    expect(r.status).toBe(200);
    expect(String(r.body.order.assignedTo._id)).toBe(String(c2._id));

    const types = (await OrderEvent.find({ order: order._id }).lean()).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['assigned', 'reassigned']));
    expect(await SyncOperation.countDocuments({})).toBe(0);
    expect(await Notification.countDocuments({ user: c1._id, type: 'order_unassigned' })).toBe(1);

    const filtered = await api.get(`/api/admin/orders?courier=${c2._id}`);
    expect(filtered.body.items).toHaveLength(1);

    const un = await api.patch(`/api/admin/orders/${order._id}/assignment`, { courierId: null });
    expect(un.body.order.deliveryStatus).toBe('new');
    expect(un.body.order.assignedTo).toBeNull();
  });

  it('refuses assignment to inactive couriers and for finished orders', async () => {
    const admin = await createUser('admin');
    const inactive = await createUser('courier', { isActive: false });
    const active = await createUser('courier');
    const order = await createOrder();
    const api = await loginAs(admin);
    const res = await api.patch(`/api/admin/orders/${order._id}/assignment`, { courierId: String(inactive._id) });
    expect(res.status).toBe(422);

    const delivered = await createAssignedOrder(active, admin, {}, 'delivered');
    const res2 = await api.patch(`/api/admin/orders/${delivered._id}/assignment`, { courierId: String(active._id) });
    expect(res2.status).toBe(422);
  });

  it('searches and filters orders with pagination', async () => {
    const admin = await createUser('admin');
    await createOrder({ id: 'search-1', full_name: 'سارة أحمد', phone: '01055556666' });
    await createOrder({ id: 'search-2', full_name: 'محمد علي', status: 'pending' });
    const api = await loginAs(admin);
    expect((await api.get('/api/admin/orders?q=سارة')).body.items).toHaveLength(1);
    expect((await api.get('/api/admin/orders?q=01055556666')).body.items).toHaveLength(1);
    expect((await api.get('/api/admin/orders?q=search-2')).body.items[0].easyOrdersId).toBe('search-2');
    expect((await api.get('/api/admin/orders?sourceStatus=pending')).body.items).toHaveLength(1);
    const page = await api.get('/api/admin/orders?limit=1&page=2');
    expect(page.body.pagination).toMatchObject({ page: 2, limit: 1, total: 2, pages: 2 });
    expect((await api.get('/api/admin/orders?limit=1000')).status).toBe(400);
  });

  it('enforces invalid state transitions on the server', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const order = await createAssignedOrder(courier, admin);
    const api = await loginAs(courier);
    // Cannot submit before starting the delivery.
    const early = await api.post(`/api/courier/orders/${order._id}/delivery-report`, { collectedAmount: 1050 });
    expect(early.status).toBe(422);
    // Admin cannot cancel a delivered order.
    const delivered = await createAssignedOrder(courier, admin, {}, 'delivered');
    const adminApi = await loginAs(admin);
    const cancel = await adminApi.patch(`/api/admin/orders/${delivered._id}/status`, { status: 'cancelled', reason: 'test reason' });
    expect(cancel.status).toBe(422);
  });

  it('cancels an order (with mandatory reason) without syncing unless requested', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const order = await createAssignedOrder(courier, admin);
    const api = await loginAs(admin);
    expect((await api.patch(`/api/admin/orders/${order._id}/status`, { status: 'cancelled' })).status).toBe(400);
    const res = await api.patch(`/api/admin/orders/${order._id}/status`, { status: 'cancelled', reason: 'طلب العميل' });
    expect(res.status).toBe(200);
    expect(res.body.order.deliveryStatus).toBe('cancelled');
    expect(await SyncOperation.countDocuments({})).toBe(0);
    expect(await Notification.countDocuments({ user: courier._id, type: 'order_cancelled' })).toBe(1);
  });

  it('keeps the audit trail append-only', async () => {
    const order = await createOrder();
    const event = await OrderEvent.findOne({ order: order._id });
    await expect(OrderEvent.updateOne({ _id: event._id }, { $set: { type: 'x' } })).rejects.toThrow(/append-only/);
    await expect(OrderEvent.deleteOne({ _id: event._id })).rejects.toThrow(/append-only/);
  });
});
