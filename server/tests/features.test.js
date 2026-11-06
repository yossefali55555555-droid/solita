import { describe, expect, it } from 'vitest';
import { CashRemittance, Expense, Order, OrderEvent, SyncOperation } from '../src/models/index.js';
import { createAssignedOrder, createOrder, createUser, enableEasyOrdersApi, loginAs, mockEasyOrders } from './helpers.js';

async function failedOrder(reason = 'payment_refused', note) {
  const admin = await createUser('admin');
  const courier = await createUser('courier');
  const order = await createAssignedOrder(courier, admin, {}, 'out_for_delivery');
  const courierApi = await loginAs(courier);
  const res = await courierApi.patch(`/api/courier/orders/${order._id}/status`, { status: 'failed', reason, note });
  expect(res.status).toBe(200);
  return { admin, courier, order, adminApi: await loginAs(admin), courierApi };
}

describe('returns review (failed / refused deliveries)', () => {
  it('lists failed deliveries for review and accepts the new "payment refused" reason', async () => {
    const { order, adminApi } = await failedOrder('payment_refused');
    const res = await adminApi.get('/api/admin/returns?status=pending');
    expect(res.status).toBe(200);
    const item = res.body.items.find((o) => o._id === String(order._id));
    expect(item).toBeTruthy();
    expect(item.lastAttempt.reason).toBe('payment_refused');
  });

  it('confirms the return and pushes returning_from_delivery to EasyOrders through the sync queue', async () => {
    enableEasyOrdersApi();
    const calls = mockEasyOrders(() => ({ status: 200, body: {} }));
    const { order, adminApi } = await failedOrder('customer_refused');
    const res = await adminApi.post(`/api/admin/orders/${order._id}/return`, { reason: 'العميل رفض المقاس' });
    expect(res.status).toBe(200);
    expect(res.body.order.deliveryStatus).toBe('returned');
    expect(res.body.syncOperation.state).toBe('succeeded');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toContain(`/orders/${order.easyOrdersId}/status`);
    expect(calls[0].body).toEqual({ status: 'returning_from_delivery' });

    const stored = await Order.findById(order._id).lean();
    expect(stored.sourceStatus).toBe('returning_from_delivery');
    expect(stored.returnInfo.reason).toBe('العميل رفض المقاس');
    expect(await OrderEvent.countDocuments({ order: order._id, type: 'return_confirmed' })).toBe(1);

    const again = await adminApi.post(`/api/admin/orders/${order._id}/return`, {});
    expect(again.status).toBe(422);
    expect(await SyncOperation.countDocuments({ order: order._id, trigger: 'return_confirmed' })).toBe(1);

    const list = await adminApi.get('/api/admin/returns?status=returned');
    expect(list.body.items.map((o) => o._id)).toContain(String(order._id));
  });

  it('can push canceled instead, or leave EasyOrders unchanged', async () => {
    enableEasyOrdersApi();
    const calls = mockEasyOrders(() => ({ status: 200, body: {} }));
    const a = await failedOrder('no_answer');
    const res = await a.adminApi.post(`/api/admin/orders/${a.order._id}/return`, { easyOrdersStatus: 'canceled' });
    expect(res.status).toBe(200);
    expect(calls.at(-1).body).toEqual({ status: 'canceled' });

    const b = await failedOrder('address_not_found');
    const before = calls.length;
    const none = await b.adminApi.post(`/api/admin/orders/${b.order._id}/return`, { easyOrdersStatus: 'none' });
    expect(none.status).toBe(200);
    expect(none.body.syncOperation).toBeNull();
    expect(calls.length).toBe(before);

    const invalid = await b.adminApi.post(`/api/admin/orders/${b.order._id}/return`, { easyOrdersStatus: 'delivered' });
    expect(invalid.status).toBe(400);
  });

  it('keeps the return when EasyOrders fails and retries later', async () => {
    enableEasyOrdersApi();
    mockEasyOrders(() => ({ status: 503, body: {} }));
    const { order, adminApi } = await failedOrder('customer_refused');
    const res = await adminApi.post(`/api/admin/orders/${order._id}/return`, {});
    expect(res.status).toBe(200);
    expect(res.body.order.deliveryStatus).toBe('returned');
    expect(['needs_reconciliation', 'retry_scheduled']).toContain(res.body.syncOperation.state);
  });

  it('refuses to return an order that was not reported as failed, and couriers cannot call it', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const order = await createAssignedOrder(courier, admin, {}, 'out_for_delivery');
    const adminApi = await loginAs(admin);
    expect((await adminApi.post(`/api/admin/orders/${order._id}/return`, {})).status).toBe(422);
    const courierApi = await loginAs(courier);
    expect((await courierApi.post(`/api/admin/orders/${order._id}/return`, {})).status).toBe(403);
  });

  it('a returned order can be reopened', async () => {
    const { order, adminApi } = await failedOrder('no_answer');
    await adminApi.post(`/api/admin/orders/${order._id}/return`, { easyOrdersStatus: 'none' });
    const res = await adminApi.patch(`/api/admin/orders/${order._id}/status`, { status: 'new', reason: 'العميل طلب مرة أخرى' });
    expect(res.status).toBe(200);
    const stored = await Order.findById(order._id).lean();
    expect(stored.deliveryStatus).toBe('new');
    expect(stored.returnInfo?.at).toBeUndefined();
  });
});

describe('customers', () => {
  it('groups orders by phone with totals and statuses', async () => {
    const admin = await createUser('admin');
    const phone = `+20 100 ${String(Date.now()).slice(-7)}`;
    const o1 = await createOrder({ phone, full_name: 'منى', total_cost: 500 });
    const o2 = await createOrder({ phone, full_name: 'منى أحمد', total_cost: 700 });
    await Order.updateOne({ _id: o1._id }, { $set: { deliveryStatus: 'delivered', deliveredAt: new Date() } });
    await Order.updateOne({ _id: o2._id }, { $set: { deliveryStatus: 'returned' } });
    const api = await loginAs(admin);

    const res = await api.get(`/api/admin/customers?q=${encodeURIComponent(phone.slice(-7))}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const c = res.body.items[0];
    expect(c.ordersCount).toBe(2);
    expect(c.delivered).toBe(1);
    expect(c.returned).toBe(1);
    expect(c.totalDelivered).toBe(50000);
    expect(c.totalOrdered).toBe(120000);

    const detail = await api.get(`/api/admin/customers/${encodeURIComponent(c.key)}`);
    expect(detail.status).toBe(200);
    expect(detail.body.orders).toHaveLength(2);
    expect(detail.body.customer.ordersCount).toBe(2);

    expect((await api.get('/api/admin/customers/0000000')).status).toBe(404);
  });
});

describe('expenses and net profit', () => {
  it('creates, lists, deletes expenses and computes net profit = sales - expenses', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);

    const delivered = await createOrder({ total_cost: 1050 });
    await Order.updateOne(
      { _id: delivered._id },
      { $set: { deliveryStatus: 'delivered', deliveredAt: new Date('2030-03-10T10:00:00Z') } },
    );

    const bad = await api.post('/api/admin/finance/expenses', { date: '2030-03-05', amount: '0', category: 'ads' });
    expect(bad.status).toBe(400);
    const needsDescription = await api.post('/api/admin/finance/expenses', { date: '2030-03-05', amount: '10', category: 'other' });
    expect(needsDescription.status).toBe(400);

    const e1 = await api.post('/api/admin/finance/expenses', { date: '2030-03-05', amount: '200.50', category: 'ads', description: 'فيسبوك' });
    expect(e1.status).toBe(201);
    expect(e1.body.expense.amount).toBe(20050);
    const e2 = await api.post('/api/admin/finance/expenses', { date: '2030-03-20', amount: 100, category: 'shipping' });
    expect(e2.status).toBe(201);
    // Outside the range
    await api.post('/api/admin/finance/expenses', { date: '2030-04-02', amount: 999, category: 'rent' });

    const range = { from: '2030-03-01T00:00:00.000Z', to: '2030-03-31T23:59:59.999Z' };
    const qs = new URLSearchParams(range).toString();

    const list = await api.get(`/api/admin/finance/expenses?${qs}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.totalAmount).toBe(30050);

    let summary = await api.get(`/api/admin/finance/summary?${qs}`);
    expect(summary.status).toBe(200);
    expect(summary.body.sales.amount).toBe(105000);
    expect(summary.body.sales.deliveredOrders).toBe(1);
    expect(summary.body.expenses.total).toBe(30050);
    expect(summary.body.netProfit).toBe(105000 - 30050);
    expect(summary.body.expenses.byCategory.find((c) => c.category === 'ads').amount).toBe(20050);

    const upd = await api.patch(`/api/admin/finance/expenses/${e2.body.expense._id}`, { amount: '150' });
    expect(upd.status).toBe(200);
    expect(upd.body.expense.amount).toBe(15000);

    const del = await api.post(`/api/admin/finance/expenses/${e1.body.expense._id}/delete`, { reason: 'مكرر' });
    expect(del.status).toBe(200);
    expect(await Expense.countDocuments({ deletedAt: { $ne: null } })).toBe(1);

    summary = await api.get(`/api/admin/finance/summary?${qs}`);
    expect(summary.body.expenses.total).toBe(15000);
    expect(summary.body.netProfit).toBe(90000);
    expect(summary.body.cash.received).toBe(0);
    expect(await CashRemittance.countDocuments({})).toBe(0);
  });

  it('is admin only', async () => {
    const courier = await createUser('courier');
    const api = await loginAs(courier);
    expect((await api.get('/api/admin/finance/summary')).status).toBe(403);
    expect((await api.post('/api/admin/finance/expenses', { date: '2030-03-05', amount: 1, category: 'ads' })).status).toBe(403);
  });
});
