import { describe, expect, it } from 'vitest';
import { Order, OrderEvent } from '../src/models/index.js';
import { normalizeEasyOrdersOrder } from '../src/integrations/easyorders/normalize.js';
import { upsertOrderFromSource } from '../src/services/sourceOrderService.js';
import { buildParcelPlan, parseParcelCode } from '../src/services/labelService.js';
import { createAssignedOrder, createOrder, createUser, loginAs, orderPayload } from './helpers.js';

async function setup({ status = 'assigned', overrides = { short_id: Math.floor(Math.random() * 1e9) } } = {}) {
  const admin = await createUser('admin');
  const courier = await createUser('courier');
  const order = await createAssignedOrder(courier, admin, overrides, status);
  return { admin, courier, order, adminApi: await loginAs(admin), courierApi: await loginAs(courier) };
}

async function printAndPickUp(ctx) {
  const res = await ctx.adminApi.post('/api/admin/labels/print', { orderIds: [String(ctx.order._id)] });
  expect(res.status).toBe(200);
  const codes = res.body.labels[0].parcels.map((p) => p.code);
  for (const code of codes) {
    const scan = await ctx.courierApi.post('/api/courier/scan', { code });
    expect(scan.body.kind).toBe('ok');
  }
  return codes;
}

describe('parcel codes', () => {
  it('parses SOL codes and rejects anything else', () => {
    expect(parseParcelCode('SOL:24-2/3')).toEqual({ number: '24', n: 2, total: 3 });
    expect(parseParcelCode(' sol:٢٤-١/١ ')).toEqual({ number: '24', n: 1, total: 1 });
    expect(parseParcelCode('SOL:eo-abc-1-1/2')).toEqual({ number: 'eo-abc-1', n: 1, total: 2 });
    expect(parseParcelCode('SOL:24-4/3')).toBeNull();
    expect(parseParcelCode('SOL:24-0/3')).toBeNull();
    expect(parseParcelCode('https://example.com')).toBeNull();
    expect(parseParcelCode(undefined)).toBeNull();
  });

  it('builds one parcel per pair with the size', () => {
    const plan = buildParcelPlan({
      items: [
        { name: 'حذاء ألكس - أسود', quantity: 2, options: [{ name: 'size', value: '42' }] },
        { name: 'صندل', quantity: 1 },
      ],
    });
    expect(plan).toEqual(['حذاء ألكس - أسود — مقاس 42', 'حذاء ألكس - أسود — مقاس 42', 'صندل']);
  });
});

describe('printing labels', () => {
  it('prints one label per parcel with the amount to collect', async () => {
    const ctx = await setup();
    const queue = await ctx.adminApi.get('/api/admin/labels?tab=pending');
    expect(queue.status).toBe(200);
    expect(queue.body.items.some((o) => String(o._id) === String(ctx.order._id))).toBe(true);

    const res = await ctx.adminApi.post('/api/admin/labels/print', { orderIds: [String(ctx.order._id)] });
    expect(res.status).toBe(200);
    const [label] = res.body.labels;
    expect(label.total).toBe(2);
    expect(label.parcels.map((p) => p.code)).toEqual([
      `SOL:${ctx.order.easyOrdersShortId}-1/2`,
      `SOL:${ctx.order.easyOrdersShortId}-2/2`,
    ]);
    expect(label.amount).toBe(105000);
    expect(label.prepaid).toBe(false);

    const stored = await Order.findById(ctx.order._id);
    expect(stored.labels.printCount).toBe(1);
    expect(stored.parcels).toHaveLength(2);
    expect(await OrderEvent.countDocuments({ order: ctx.order._id, type: 'labels_printed' })).toBe(1);

    const again = await ctx.adminApi.post('/api/admin/labels/print', { orderIds: [String(ctx.order._id)] });
    expect(again.status).toBe(200);
    expect((await Order.findById(ctx.order._id)).labels.printCount).toBe(2);
    expect(await OrderEvent.countDocuments({ order: ctx.order._id, type: 'labels_reprinted' })).toBe(1);
  });

  it('prints nothing when one order of the batch cannot be printed', async () => {
    const ctx = await setup();
    const cancelled = await createOrder({ status: 'canceled' });
    const res = await ctx.adminApi.post('/api/admin/labels/print', {
      orderIds: [String(ctx.order._id), String(cancelled._id)],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRINT_REJECTED');
    expect((await Order.findById(ctx.order._id)).labels.printedAt).toBeNull();
  });

  it('couriers cannot print labels', async () => {
    const ctx = await setup();
    const res = await ctx.courierApi.post('/api/admin/labels/print', { orderIds: [String(ctx.order._id)] });
    expect(res.status).toBe(403);
  });
});

describe('courier pickup scan', () => {
  it('requires every parcel before the delivery can start', async () => {
    const ctx = await setup();
    const notPrinted = await ctx.courierApi.patch(`/api/courier/orders/${ctx.order._id}/status`, { status: 'out_for_delivery' });
    expect(notPrinted.status).toBe(422);
    expect(notPrinted.body.error.code).toBe('LABELS_NOT_PRINTED');

    const res = await ctx.adminApi.post('/api/admin/labels/print', { orderIds: [String(ctx.order._id)] });
    const [first, second] = res.body.labels[0].parcels.map((p) => p.code);
    const scan1 = await ctx.courierApi.post('/api/courier/scan', { code: first });
    expect(scan1.body.kind).toBe('ok');
    expect(scan1.body.allPickedUp).toBe(false);

    const dup = await ctx.courierApi.post('/api/courier/scan', { code: first });
    expect(dup.body.kind).toBe('mine');

    const early = await ctx.courierApi.patch(`/api/courier/orders/${ctx.order._id}/status`, { status: 'out_for_delivery' });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('PARCELS_NOT_PICKED_UP');

    const scan2 = await ctx.courierApi.post('/api/courier/scan', { code: second });
    expect(scan2.body.allPickedUp).toBe(true);
    const start = await ctx.courierApi.patch(`/api/courier/orders/${ctx.order._id}/status`, { status: 'out_for_delivery' });
    expect(start.status).toBe(200);
  });

  it('blocks parcels of other couriers, cancelled orders and old labels', async () => {
    const ctx = await setup();
    const res = await ctx.adminApi.post('/api/admin/labels/print', { orderIds: [String(ctx.order._id)] });
    const code = res.body.labels[0].parcels[0].code;

    const other = await createUser('courier');
    const otherApi = await loginAs(other);
    const foreign = await otherApi.post('/api/courier/scan', { code });
    expect(foreign.body).toEqual({ kind: 'block', message: 'هذا الطلب مع مندوب آخر' });

    const old = await ctx.courierApi.post('/api/courier/scan', { code: code.replace('/2', '/3') });
    expect(old.body.kind).toBe('block');

    const unknown = await ctx.courierApi.post('/api/courier/scan', { code: 'SOL:999999999999-1/1' });
    expect(unknown.body.message).toBe('طرد غير مسجّل في النظام');

    await Order.updateOne({ _id: ctx.order._id }, { $set: { deliveryStatus: 'cancelled' } });
    const cancelled = await ctx.courierApi.post('/api/courier/scan', { code });
    expect(cancelled.body.message).toBe('هذا الطلب ملغى — لا تستلمه');
  });

  it('flags the label for reprint when EasyOrders changes the items', async () => {
    const shortId = Math.floor(Math.random() * 1e9);
    const id = `eo-reprint-${shortId}`;
    const ctx = await setup({ overrides: { id, short_id: shortId } });
    const res = await ctx.adminApi.post('/api/admin/labels/print', { orderIds: [String(ctx.order._id)] });
    const code = res.body.labels[0].parcels[0].code;

    const changed = orderPayload({ id, short_id: shortId, updated_at: '2026-10-02T10:00:00.000Z' });
    changed.cart_items[0].quantity = 3;
    await upsertOrderFromSource(normalizeEasyOrdersOrder(changed), { via: 'test' });
    const stored = await Order.findById(ctx.order._id);
    expect(stored.labels.needsReprint).toBe(true);

    const scan = await ctx.courierApi.post('/api/courier/scan', { code });
    expect(scan.body.message).toBe('تغيّر هذا الطلب ويحتاج بوليصة جديدة — ارجع للمشرف');

    const queue = await ctx.adminApi.get('/api/admin/labels?tab=reprint');
    expect(queue.body.items.some((o) => String(o._id) === String(ctx.order._id))).toBe(true);
    const reprint = await ctx.adminApi.post('/api/admin/labels/print', { orderIds: [String(ctx.order._id)] });
    expect(reprint.body.labels[0].total).toBe(3);
    expect((await Order.findById(ctx.order._id)).labels.needsReprint).toBe(false);
  });
});

describe('courier takes an unassigned order by scanning', () => {
  it('assigns a printed new order to the first courier who scans it', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const other = await createUser('courier');
    const order = await createOrder({ short_id: Math.floor(Math.random() * 1e9) });
    const adminApi = await loginAs(admin);
    const courierApi = await loginAs(courier);
    const otherApi = await loginAs(other);

    const res = await adminApi.post('/api/admin/labels/print', { orderIds: [String(order._id)] });
    const [c1, c2] = res.body.labels[0].parcels.map((p) => p.code);

    const first = await courierApi.post('/api/courier/scan', { code: c1 });
    expect(first.body.kind).toBe('ok');
    expect(first.body.claimed).toBe(true);
    expect(first.body.message).toContain('تم إسناد الطلب إليك');
    const stored = await Order.findById(order._id);
    expect(String(stored.assignedTo)).toBe(String(courier._id));
    expect(stored.deliveryStatus).toBe('assigned');
    expect(await OrderEvent.countDocuments({ order: order._id, type: 'assigned' })).toBe(1);

    const taken = await otherApi.post('/api/courier/scan', { code: c2 });
    expect(taken.body.message).toBe('هذا الطلب مع مندوب آخر');

    const second = await courierApi.post('/api/courier/scan', { code: c2 });
    expect(second.body.allPickedUp).toBe(true);
    const start = await courierApi.patch(`/api/courier/orders/${order._id}/status`, { status: 'out_for_delivery' });
    expect(start.status).toBe(200);
  });

  it('does not let a courier take an unprinted or cancelled order', async () => {
    const courier = await createUser('courier');
    const courierApi = await loginAs(courier);
    const order = await createOrder({ short_id: Math.floor(Math.random() * 1e9) });
    const unprinted = await courierApi.post('/api/courier/scan', { code: `SOL:${order.easyOrdersShortId}-1/2` });
    expect(unprinted.body.kind).toBe('block');
    expect((await Order.findById(order._id)).assignedTo).toBeNull();
  });
});

describe('scan before delivery actions', () => {
  it('requires a picked-up parcel of the same order to deliver or fail', async () => {
    const ctx = await setup();
    const codes = await printAndPickUp(ctx);
    await ctx.courierApi.patch(`/api/courier/orders/${ctx.order._id}/status`, { status: 'out_for_delivery' });

    const noScan = await ctx.courierApi.post(`/api/courier/orders/${ctx.order._id}/delivery-report`, { collectedAmount: '1050' });
    expect(noScan.status).toBe(400);
    expect(noScan.body.error.code).toBe('PARCEL_SCAN_REQUIRED');

    const wrong = await ctx.courierApi.post(`/api/courier/orders/${ctx.order._id}/delivery-report`, {
      collectedAmount: '1050',
      parcelCode: 'SOL:1-1/1',
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('PARCEL_OTHER_ORDER');

    const failNoScan = await ctx.courierApi.patch(`/api/courier/orders/${ctx.order._id}/status`, { status: 'failed', reason: 'no_answer' });
    expect(failNoScan.status).toBe(400);

    const ok = await ctx.courierApi.post(`/api/courier/orders/${ctx.order._id}/delivery-report`, {
      collectedAmount: '1050',
      parcelCode: codes[1],
    });
    expect(ok.status).toBe(201);
  });

  it('keeps accepting orders that were out before labels existed', async () => {
    const ctx = await setup({ status: 'out_for_delivery' });
    const res = await ctx.courierApi.post(`/api/courier/orders/${ctx.order._id}/delivery-report`, { collectedAmount: '1050' });
    expect(res.status).toBe(201);
  });
});

describe('returns back to the warehouse', () => {
  it('scans returned parcels into the warehouse', async () => {
    const ctx = await setup();
    const codes = await printAndPickUp(ctx);
    await ctx.courierApi.patch(`/api/courier/orders/${ctx.order._id}/status`, { status: 'out_for_delivery' });

    const tooEarly = await ctx.adminApi.post('/api/admin/returns/scan', { code: codes[0] });
    expect(tooEarly.body.kind).toBe('block');

    const failed = await ctx.courierApi.patch(`/api/courier/orders/${ctx.order._id}/status`, {
      status: 'failed',
      reason: 'customer_refused',
      parcelCode: codes[0],
    });
    expect(failed.status).toBe(200);

    const first = await ctx.adminApi.post('/api/admin/returns/scan', { code: codes[0] });
    expect(first.body.kind).toBe('ok');
    expect(first.body.message).toContain('باقي 1');
    const second = await ctx.adminApi.post('/api/admin/returns/scan', { code: codes[1] });
    expect(second.body.message).toContain('كل طرود الطلب في المخزن');
    const dup = await ctx.adminApi.post('/api/admin/returns/scan', { code: codes[1] });
    expect(dup.body.kind).toBe('mine');

    const stored = await Order.findById(ctx.order._id);
    expect(stored.parcels.every((p) => p.warehouseAt)).toBe(true);
    expect(await OrderEvent.countDocuments({ order: ctx.order._id, type: 'parcel_returned_to_warehouse' })).toBe(2);

    // Reassigning a returned order means the new courier must scan the parcels again.
    const other = await createUser('courier');
    const assign = await ctx.adminApi.patch(`/api/admin/orders/${ctx.order._id}/assignment`, { courierId: String(other._id) });
    expect(assign.status).toBe(200);
    const after = await Order.findById(ctx.order._id);
    expect(after.parcels.every((p) => !p.pickedUpAt && !p.warehouseAt)).toBe(true);
  });
});
