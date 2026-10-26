import { describe, expect, it } from 'vitest';
import { CashRemittance, Order, OrderEvent } from '../src/models/index.js';
import { createAssignedOrder, createUser, loginAs } from './helpers.js';

async function deliveredOrders(n = 2) {
  const admin = await createUser('admin');
  const courier = await createUser('courier');
  const orders = [];
  for (let i = 0; i < n; i += 1) orders.push(await createAssignedOrder(courier, admin, {}, 'delivered'));
  return { admin, courier, orders, adminApi: await loginAs(admin), courierApi: await loginAs(courier) };
}

describe('cash-on-delivery reconciliation', () => {
  it('does not treat delivery as cash handed over', async () => {
    const { adminApi, courierApi } = await deliveredOrders(2);
    const overview = await adminApi.get('/api/admin/cash/overview');
    expect(overview.body.expectedDelivered).toBe(210000);
    expect(overview.body.handedOver).toBe(0);
    expect(overview.body.outstanding).toBe(210000);
    const mine = await courierApi.get('/api/courier/cash');
    expect(mine.body.summary.unremittedExpected).toBe(210000);
    expect(mine.body.eligibleOrders).toHaveLength(2);
  });

  it('runs the courier declaration → receipt → verification flow', async () => {
    const { adminApi, courierApi, orders } = await deliveredOrders(2);
    const declare = await courierApi.post('/api/courier/cash/remittances', {
      orderIds: orders.map((o) => String(o._id)),
      declaredAmount: '2100.00',
    });
    expect(declare.status).toBe(201);
    expect(declare.body.remittance).toMatchObject({ status: 'declared', expectedAmount: 210000, declaredAmount: 210000 });
    const id = declare.body.remittance._id;

    const receive = await adminApi.post(`/api/admin/cash/remittances/${id}/receive`, { handedOverAmount: 2050 });
    expect(receive.body.remittance).toMatchObject({ status: 'received', handedOverAmount: 205000, difference: -5000 });

    const verify = await adminApi.post(`/api/admin/cash/remittances/${id}/verify`, { verifiedAmount: 2050 });
    expect(verify.body.remittance).toMatchObject({ status: 'discrepancy', verifiedAmount: 205000, difference: -5000 });

    const fix = await adminApi.post(`/api/admin/cash/remittances/${id}/verify`, { verifiedAmount: 2100, notes: 'تم استلام الباقي' });
    expect(fix.body.remittance.status).toBe('reconciled');
    expect(fix.body.remittance.difference).toBe(0);

    const events = await OrderEvent.find({ remittance: id }).lean();
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['remittance_created', 'remittance_received', 'remittance_verified']),
    );
    const overview = await adminApi.get('/api/admin/cash/overview');
    expect(overview.body.outstanding).toBe(0);
    expect(overview.body.verified).toBe(210000);
  });

  it('prevents the same order from being remitted twice', async () => {
    const { adminApi, courierApi, orders, courier } = await deliveredOrders(1);
    const ids = [String(orders[0]._id)];
    expect((await courierApi.post('/api/courier/cash/remittances', { orderIds: ids, declaredAmount: 1050 })).status).toBe(201);
    expect((await courierApi.post('/api/courier/cash/remittances', { orderIds: ids, declaredAmount: 1050 })).status).toBe(422);
    const adminDup = await adminApi.post('/api/admin/cash/remittances', {
      courierId: String(courier._id),
      orderIds: ids,
      handedOverAmount: 1050,
    });
    expect(adminDup.status).toBe(422);
    expect(await CashRemittance.countDocuments({})).toBe(1);
  });

  it('only accepts delivered COD orders of that courier', async () => {
    const { admin, adminApi, courier } = await deliveredOrders(0);
    const undelivered = await createAssignedOrder(courier, admin, {}, 'out_for_delivery');
    const res = await adminApi.post('/api/admin/cash/remittances', {
      courierId: String(courier._id),
      orderIds: [String(undelivered._id)],
      handedOverAmount: 1050,
    });
    expect(res.status).toBe(422);
  });

  it('releases orders when a remittance is cancelled', async () => {
    const { adminApi, courier, orders } = await deliveredOrders(1);
    const created = await adminApi.post('/api/admin/cash/remittances', {
      courierId: String(courier._id),
      orderIds: [String(orders[0]._id)],
      handedOverAmount: 1050,
    });
    expect(created.body.remittance.status).toBe('received');
    expect((await adminApi.post(`/api/admin/cash/remittances/${created.body.remittance._id}/cancel`, {})).status).toBe(400);
    const cancel = await adminApi.post(`/api/admin/cash/remittances/${created.body.remittance._id}/cancel`, { reason: 'خطأ في الإدخال' });
    expect(cancel.body.remittance.status).toBe('cancelled');
    expect((await Order.findById(orders[0]._id)).cod.remittance).toBeNull();
  });

  it('restricts couriers to their own financial records', async () => {
    const { courierApi, orders } = await deliveredOrders(1);
    const other = await createUser('courier');
    const otherApi = await loginAs(other);
    const declared = await courierApi.post('/api/courier/cash/remittances', {
      orderIds: [String(orders[0]._id)],
      declaredAmount: 1050,
    });
    const id = declared.body.remittance._id;
    expect((await otherApi.get(`/api/courier/cash/remittances/${id}`)).status).toBe(404);
    expect((await courierApi.post(`/api/admin/cash/remittances/${id}/verify`, { verifiedAmount: 1050 })).status).toBe(403);
    // Another courier cannot declare cash for orders that are not theirs.
    const steal = await otherApi.post('/api/courier/cash/remittances', { orderIds: [String(orders[0]._id)], declaredAmount: 1 });
    expect(steal.status).toBe(422);
  });

  it('validates money input (max two decimals, no negatives)', async () => {
    const { courierApi, orders } = await deliveredOrders(1);
    const ids = [String(orders[0]._id)];
    expect((await courierApi.post('/api/courier/cash/remittances', { orderIds: ids, declaredAmount: '10.555' })).status).toBe(400);
    expect((await courierApi.post('/api/courier/cash/remittances', { orderIds: ids, declaredAmount: -5 })).status).toBe(400);
  });
});
