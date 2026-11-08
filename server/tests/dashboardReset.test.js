import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { CashRemittance, Expense, Order, OrderEvent } from '../src/models/index.js';
import { normalizeEasyOrdersOrder } from '../src/integrations/easyorders/normalize.js';
import { upsertOrderFromSource } from '../src/services/sourceOrderService.js';
import { createAssignedOrder, createOrder, createUser, loginAs, orderPayload } from './helpers.js';

describe('clear orders from the dashboard', () => {
  it('hides orders from the list and overview without deleting them', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    const a = await createOrder();
    await createOrder();

    expect((await api.post('/api/admin/orders/clear', { confirm: 'no' })).status).toBe(400);

    const res = await api.post('/api/admin/orders/clear', { confirm: 'مسح' });
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(2);

    expect(await Order.countDocuments()).toBe(2);
    expect((await api.get('/api/admin/orders')).body.items).toHaveLength(0);
    expect((await api.get('/api/admin/orders?cleared=only')).body.items).toHaveLength(2);
    expect((await api.get('/api/admin/orders?cleared=include')).body.items).toHaveLength(2);
    expect((await api.get('/api/admin/orders/cleared/count')).body.count).toBe(2);
    expect((await api.get('/api/admin/overview')).body.stats.orders.total).toBe(0);
    expect((await api.get(`/api/admin/orders/${a._id}`)).status).toBe(200);
    expect(await OrderEvent.countDocuments({ type: 'orders_cleared_from_dashboard' })).toBe(1);
  });

  it('keeps cleared orders hidden when EasyOrders updates them, and lists new ones', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    const payload = orderPayload();
    await upsertOrderFromSource(normalizeEasyOrdersOrder(payload), { via: 'test' });
    await api.post('/api/admin/orders/clear', { confirm: 'مسح' });

    await upsertOrderFromSource(
      normalizeEasyOrdersOrder({ ...payload, status: 'processing', updated_at: '2026-10-02T10:00:00.000Z' }),
      { via: 'poll' },
    );
    const fresh = await createOrder();

    const list = (await api.get('/api/admin/orders')).body.items;
    expect(list.map((o) => o._id)).toEqual([String(fresh._id)]);
    const hidden = await Order.findOne({ easyOrdersId: payload.id }).lean();
    expect(hidden.dashboardHiddenAt).toBeTruthy();
    expect(hidden.sourceStatus).toBe('processing');
  });

  it('restores cleared orders and is admin-only', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const api = await loginAs(admin);
    const courierApi = await loginAs(courier);
    await createOrder();
    expect((await courierApi.post('/api/admin/orders/clear', { confirm: 'مسح' })).status).toBe(403);

    await api.post('/api/admin/orders/clear', { confirm: 'مسح' });
    const res = await api.post('/api/admin/orders/restore-cleared');
    expect(res.body.restored).toBe(1);
    expect((await api.get('/api/admin/orders')).body.items).toHaveLength(1);
  });
});

describe('cash reset', () => {
  it('zeros the cash page without deleting anything, and can be undone', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const api = await loginAs(admin);
    const courierApi = await loginAs(courier);
    const order = await createAssignedOrder(courier, admin, {}, 'delivered');
    await Order.updateOne({ _id: order._id }, { $set: { deliveredAt: new Date(Date.now() - 60_000) } });
    await api.post('/api/admin/cash/remittances', {
      courierId: String(courier._id),
      orderIds: [String(order._id)],
      handedOverAmount: 1050,
    });

    const before = (await api.get('/api/admin/cash/overview')).body;
    expect(before.expectedDelivered).toBe(105000);
    expect(before.handedOver).toBe(105000);

    expect((await courierApi.post('/api/admin/cash/reset', { confirm: 'تصفير' })).status).toBe(403);
    expect((await api.post('/api/admin/cash/reset', { confirm: 'x' })).status).toBe(400);
    expect((await api.post('/api/admin/cash/reset', { confirm: 'تصفير' })).status).toBe(200);

    const after = (await api.get('/api/admin/cash/overview')).body;
    expect(after).toMatchObject({ expectedDelivered: 0, handedOver: 0, verified: 0, outstanding: 0, discrepancy: 0 });
    expect(after.resetAt).toBeTruthy();
    expect((await api.get('/api/admin/cash/remittances')).body.items).toHaveLength(0);
    expect((await api.get('/api/admin/cash/remittances?beforeReset=true')).body.items).toHaveLength(1);
    expect(await CashRemittance.countDocuments()).toBe(1);
    expect(await OrderEvent.countDocuments({ type: 'cash_reset' })).toBe(1);

    // New deliveries after the reset are counted.
    const next = await createAssignedOrder(courier, admin, {}, 'delivered');
    await Order.updateOne({ _id: next._id }, { $set: { deliveredAt: new Date() } });
    expect((await api.get('/api/admin/cash/overview')).body.expectedDelivered).toBe(105000);

    await api.post('/api/admin/cash/reset/undo');
    const undone = (await api.get('/api/admin/cash/overview')).body;
    expect(undone.expectedDelivered).toBe(210000);
    expect(undone.resetAt).toBeNull();
  });
});

describe('profits & expenses reset', () => {
  it('zeros sales, expenses and net profit without deleting anything, and can be undone', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const api = await loginAs(admin);
    const courierApi = await loginAs(courier);
    const earlier = new Date(Date.now() - 60_000);
    const order = await createAssignedOrder(courier, admin, {}, 'delivered');
    await Order.updateOne({ _id: order._id }, { $set: { deliveredAt: earlier } });
    const today = new Date().toISOString().slice(0, 10);
    const created = await api.post('/api/admin/finance/expenses', { date: today, amount: '200', category: 'ads' });
    expect(created.status).toBe(201);
    await // createdAt is immutable in Mongoose, so backdate it on the raw collection.
    await Expense.collection.updateOne({ _id: new mongoose.Types.ObjectId(created.body.expense._id) }, { $set: { createdAt: earlier } });

    const before = (await api.get('/api/admin/finance/summary')).body;
    expect(before.sales.amount).toBe(105000);
    expect(before.expenses.total).toBe(20000);
    expect(before.netProfit).toBe(85000);

    expect((await courierApi.post('/api/admin/finance/reset', { confirm: 'تصفير' })).status).toBe(403);
    expect((await api.post('/api/admin/finance/reset', { confirm: 'x' })).status).toBe(400);
    expect((await api.post('/api/admin/finance/reset', { confirm: 'تصفير' })).status).toBe(200);

    const after = (await api.get('/api/admin/finance/summary')).body;
    expect(after.sales.amount).toBe(0);
    expect(after.expenses.total).toBe(0);
    expect(after.netProfit).toBe(0);
    expect(after.resetAt).toBeTruthy();
    expect((await api.get('/api/admin/finance/expenses')).body.items).toHaveLength(0);
    expect((await api.get('/api/admin/finance/expenses?beforeReset=true')).body.items).toHaveLength(1);
    expect(await Expense.countDocuments()).toBe(1);
    expect(await OrderEvent.countDocuments({ type: 'finance_reset' })).toBe(1);

    // A date range that starts before the reset still counts from the reset.
    const ranged = (await api.get(`/api/admin/finance/summary?from=${earlier.toISOString().slice(0, 10)}`)).body;
    expect(ranged.sales.amount).toBe(0);

    // New deliveries and invoices after the reset are counted.
    const next = await createAssignedOrder(courier, admin, {}, 'delivered');
    await Order.updateOne({ _id: next._id }, { $set: { deliveredAt: new Date(Date.now() + 1000) } });
    await api.post('/api/admin/finance/expenses', { date: today, amount: '50', category: 'ads' });
    const later = (await api.get('/api/admin/finance/summary')).body;
    expect(later.sales.amount).toBe(105000);
    expect(later.expenses.total).toBe(5000);
    expect(later.netProfit).toBe(100000);

    await api.post('/api/admin/finance/reset/undo');
    const undone = (await api.get('/api/admin/finance/summary')).body;
    expect(undone.sales.amount).toBe(210000);
    expect(undone.expenses.total).toBe(25000);
    expect(undone.resetAt).toBeNull();
  });
});
