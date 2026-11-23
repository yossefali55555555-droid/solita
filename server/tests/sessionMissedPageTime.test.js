import crypto from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MissedOrder, Order, PageStat } from '../src/models/index.js';
import { normalizeEasyOrdersOrder } from '../src/integrations/easyorders/normalize.js';
import { upsertOrderFromSource } from '../src/services/sourceOrderService.js';
import { classifyCustomer } from '../src/services/customerRiskService.js';
import { medianFromBuckets, normalizePagePath } from '../src/services/pageStatService.js';
import { cairoLocalToDate, parseMissedOrders, parseMissedDate, splitCustomer } from '../src/services/missedOrderService.js';
import { createOrder, createUser, enableEasyOrdersApi, getTestApp, loginAs, mockEasyOrders, orderPayload } from './helpers.js';

const STOREFRONT = 'https://solita.myeasyorders.com';
let ip = 0;
const send = (body) =>
  request(getTestApp())
    .post('/api/public/events')
    .set('X-Forwarded-For', `10.9.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`)
    .set('Origin', STOREFRONT)
    .send(body);

describe('visit session on orders', () => {
  it('stores metadata.tracking, country and campaign from the payload', async () => {
    const order = await createOrder({
      ip_country: 'eg',
      metadata: {
        tracking: {
          first_visit_at: '2026-10-01T09:58:00.000Z',
          first_order_at: '2026-10-01T10:00:00.000Z',
          orders_count: 0,
          pages_visited: ['/', '/products/samba', '/checkout'],
          referrer: 'instagram.com',
          sessions_count: 2,
          visit_duration_seconds: 78,
        },
        utm_source: 'instagram',
        utm_campaign: 'launch-1',
      },
    });
    const s = order.session;
    expect(s.visitDurationSeconds).toBe(78);
    expect(s.sessionsCount).toBe(2);
    expect(s.pagesVisited).toEqual(['/', '/products/samba', '/checkout']);
    expect(s.referrer).toBe('instagram.com');
    expect(s.ipCountry).toBe('eg');
    expect(s.utmSource).toBe('instagram');
    expect(s.utmCampaign).toBe('launch-1');
  });

  it('does not wipe the stored session when a later payload has none', async () => {
    const payload = orderPayload({ metadata: { tracking: { visit_duration_seconds: 40, sessions_count: 1 } } });
    await upsertOrderFromSource(normalizeEasyOrdersOrder(payload), { via: 'test' });
    const bare = { ...payload };
    delete bare.metadata;
    await upsertOrderFromSource(normalizeEasyOrdersOrder({ ...bare, updated_at: '2026-10-02T10:00:00.000Z' }), { via: 'test' });
    const stored = await Order.findOne({ easyOrdersId: payload.id });
    expect(stored.session.visitDurationSeconds).toBe(40);
  });
});

describe('customer delivery record', () => {
  it('classifies customers by delivered and refused orders', () => {
    expect(classifyCustomer({}).level).toBe('new');
    expect(classifyCustomer({ open: 1 }).level).toBe('unknown');
    expect(classifyCustomer({ delivered: 3 }).level).toBe('good');
    expect(classifyCustomer({ delivered: 4, refused: 1 }).level).toBe('moderate');
    expect(classifyCustomer({ delivered: 1, refused: 2 }).level).toBe('high');
    expect(classifyCustomer({ refused: 3 }).level).toBe('high');
    expect(classifyCustomer({ delivered: 3, refused: 1 }).rate).toBe(75);
  });

  it('attaches the record to listed orders without counting the order itself or test orders', async () => {
    const admin = await createUser('admin');
    const phone = '+20 100 555 0001';
    const prev1 = await createOrder({ phone });
    const prev2 = await createOrder({ phone });
    const prevTest = await createOrder({ phone });
    const current = await createOrder({ phone });
    await Order.updateOne({ _id: prev1._id }, { $set: { deliveryStatus: 'delivered' } });
    await Order.updateOne({ _id: prev2._id }, { $set: { deliveryStatus: 'returned' } });
    await Order.updateOne({ _id: prevTest._id }, { $set: { deliveryStatus: 'returned', isTest: true } });
    const api = await loginAs(admin);
    const res = await api.get(`/api/admin/orders/${current._id}`);
    const h = res.body.order.customerHistory;
    expect(h).toMatchObject({ delivered: 1, refused: 1, previous: 2, rate: 50 });
    expect(h.level).toBe('moderate');
  });
});

describe('order notes', () => {
  it('saves a public note and pushes it to EasyOrders with the order and store ids', async () => {
    enableEasyOrdersApi();
    const calls = mockEasyOrders(() => ({ status: 200, body: { ok: true } }));
    const admin = await createUser('admin');
    const order = await createOrder();
    const api = await loginAs(admin);
    const res = await api.post(`/api/admin/orders/${order._id}/notes`, { text: 'طلبك خرج للشحن', type: 'public' });
    expect(res.status).toBe(200);
    expect(res.body.sync).toBe('synced');
    expect(res.body.order.notes).toHaveLength(1);
    expect(calls[0].url).toContain('/api/v1/external-apps/order-notes');
    expect(calls[0].body).toEqual({ order_id: order.easyOrdersId, store_id: 'store-1', note: 'طلبك خرج للشحن', type: 'public' });
  });

  it('keeps the note when EasyOrders refuses it and lets the admin retry', async () => {
    enableEasyOrdersApi();
    let fail = true;
    mockEasyOrders(() => (fail ? { status: 403, body: { message: 'forbidden' } } : { status: 200, body: {} }));
    const admin = await createUser('admin');
    const order = await createOrder();
    const api = await loginAs(admin);
    const res = await api.post(`/api/admin/orders/${order._id}/notes`, { text: 'ملاحظة داخلية', type: 'private' });
    expect(res.body.sync).toBe('failed');
    const noteId = res.body.order.notes[0]._id;
    fail = false;
    const retry = await api.post(`/api/admin/orders/${order._id}/notes/${noteId}/retry`);
    expect(retry.body.sync).toBe('synced');
  });

  it('rejects empty notes and unknown types', async () => {
    const admin = await createUser('admin');
    const order = await createOrder();
    const api = await loginAs(admin);
    expect((await api.post(`/api/admin/orders/${order._id}/notes`, { text: '', type: 'public' })).status).toBe(400);
    expect((await api.post(`/api/admin/orders/${order._id}/notes`, { text: 'x', type: 'other' })).status).toBe(400);
  });
});

describe('missed orders import', () => {
  const header = 'العميل,السبب,الحالة,تاريخ الطلب';
  const csv = [
    header,
    'yossef ali +201097711577,ادخال بيانات خاطئة,مكتمل,08/11/2026 11:31',
    '"Solita 01101085087",otp_verify_failed,تحت المراجعة,28/10/2026 12:48',
    ',,,',
  ].join('\n');

  it('parses names with phones, Egyptian dates and skips junk rows', () => {
    const { rows, skipped, problem } = parseMissedOrders(csv);
    expect(problem).toBeNull();
    expect(rows).toHaveLength(2);
    expect(skipped).toBe(0); // fully blank lines are ignored, not counted
    expect(rows[0]).toMatchObject({ name: 'yossef ali', phoneNormalized: '01097711577', reason: 'ادخال بيانات خاطئة' });
    expect(rows[1].phoneNormalized).toBe('01101085087');
    expect(rows[0].eoDate.toISOString()).toBe('2026-11-08T09:31:00.000Z'); // Cairo is UTC+2 in November
  });

  it('understands tab separated text and Arabic digits', () => {
    const text = 'العميل\tالسبب\tالحالة\tتاريخ الطلب\nأحمد 01012345678\tx\tمكتمل\t٠٨/١١/٢٠٢٦ ١١:٣١';
    const { rows } = parseMissedOrders(text);
    expect(rows[0].phoneNormalized).toBe('01012345678');
    expect(rows[0].eoDate.toISOString()).toBe('2026-11-08T09:31:00.000Z');
  });

  it('explains a file without the expected columns', () => {
    expect(parseMissedOrders('a,b\n1,2').problem).toMatch(/العميل/);
  });

  it('helper functions behave', () => {
    expect(splitCustomer('Solita 01101085087')).toEqual({ name: 'Solita', phone: '01101085087' });
    expect(parseMissedDate('2026-07-15').toISOString()).toBe('2026-07-14T21:00:00.000Z'); // Cairo summer time
    expect(cairoLocalToDate(2026, 7, 15, 12, 0).toISOString()).toBe('2026-07-15T09:00:00.000Z');
  });

  it('imports once, never duplicates, and keeps what the team did', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    const first = await api.post('/api/admin/missed-orders/import', { text: csv });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ created: 2, existing: 0 });

    const list = await api.get('/api/admin/missed-orders');
    const item = list.body.items.find((i) => i.phoneNormalized === '01097711577');
    await api.patch(`/api/admin/missed-orders/${item._id}`, { contacted: true, note: 'كلمته' });

    const more = `${csv}\nمنى +201234567890,ادخال بيانات خاطئة,مكتمل,23/11/2026 09:00`;
    const second = await api.post('/api/admin/missed-orders/import', { text: more });
    expect(second.body).toMatchObject({ created: 1, existing: 2 });
    expect(await MissedOrder.countDocuments({})).toBe(3);
    const kept = await MissedOrder.findById(item._id);
    expect(kept.contactedAt).not.toBeNull();
    expect(kept.note).toBe('كلمته');

    const open = await api.get('/api/admin/missed-orders?status=open');
    expect(open.body.items).toHaveLength(2);
    expect(open.body.counts).toMatchObject({ open: 2, contacted: 1 });
  });

  it('shows when the same phone ordered afterwards', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    await createOrder({ phone: '01097711577', created_at: '2026-11-09T10:00:00.000Z' });
    await api.post('/api/admin/missed-orders/import', { text: csv });
    const list = await api.get('/api/admin/missed-orders?status=all');
    const item = list.body.items.find((i) => i.phoneNormalized === '01097711577');
    expect(item.orderedLater).toMatchObject({ count: 1 });
  });
});

describe('page time analytics', () => {
  it('normalizes paths: no query, ids collapsed, odd paths refused', () => {
    expect(normalizePagePath('/products/samba?x=1#a')).toBe('/products/samba');
    expect(normalizePagePath('/track/7d9b3c10-1111-2222-3333-444444444444')).toBe('/track');
    expect(normalizePagePath('/thanks/')).toBe('/thanks');
    expect(normalizePagePath('/')).toBe('/');
    expect(normalizePagePath('//evil.com')).toBeNull();
    expect(normalizePagePath('/a/b/c/d/e')).toBeNull();
    expect(normalizePagePath('/<script>')).toBeNull();
  });

  it('estimates a median from buckets', () => {
    expect(medianFromBuckets([0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(medianFromBuckets([10, 0, 0, 0, 0, 0, 0])).toBeLessThan(3);
    expect(medianFromBuckets([0, 0, 10, 0, 0, 0, 0])).toBeGreaterThanOrEqual(10);
  });

  it('records views and visit time, and the admin page lists every page seen', async () => {
    const vid = crypto.randomUUID();
    const base = { device: 'mobile', os: 'android', src: 'instagram' };
    const res = await send({
      visitorId: vid,
      events: [
        { type: 'page_view', path: '/products/new-shoe', title: 'حذاء جديد', ...base },
        { type: 'page_time', path: '/products/new-shoe', seconds: 12, part: true, device: 'mobile', src: 'instagram' },
        { type: 'page_time', path: '/products/new-shoe', seconds: 18, total: 30, cont: true, scroll: 70, device: 'mobile', src: 'instagram' },
        { type: 'page_view', path: '/checkout', ...base },
        { type: 'page_time', path: '/checkout', seconds: 5, total: 5, cont: false, scroll: 10, device: 'mobile', src: 'instagram' },
      ],
    });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(5);

    const stat = await PageStat.findOne({ path: '/products/new-shoe' });
    expect(stat).toMatchObject({ views: 1, timed: 1, visitSeconds: 30, scrollSum: 70, exits: 0 });
    expect(stat.os.android).toBe(1);

    const admin = await createUser('admin');
    const api = await loginAs(admin);
    const out = await api.get('/api/admin/storefront/pages?range=today');
    const paths = out.body.pages.map((p) => p.path);
    expect(paths).toEqual(expect.arrayContaining(['/products/new-shoe', '/checkout']));
    const shoe = out.body.pages.find((p) => p.path === '/products/new-shoe');
    expect(shoe).toMatchObject({ type: 'product', avgSeconds: 30, avgScroll: 70, lowSample: true });
    const checkout = out.body.pages.find((p) => p.path === '/checkout');
    expect(checkout.exitRate).toBe(100);
    expect(out.body.devices.mobile).toBe(2);

    const onlyDesktop = await api.get('/api/admin/storefront/pages?range=today&device=desktop');
    expect(onlyDesktop.body.pages).toHaveLength(0);
  });

  it('skips bad paths and still accepts the rest of the batch', async () => {
    const res = await send({
      visitorId: crypto.randomUUID(),
      events: [
        { type: 'page_view', path: '//evil' },
        { type: 'page_view', path: '/pages/size-guide' },
      ],
    });
    expect(res.status).toBe(202);
    expect(await PageStat.countDocuments({ path: '/pages/size-guide' })).toBe(1);
    expect(await PageStat.countDocuments({ path: '//evil' })).toBe(0);
  });
});

describe('missed orders: priority and bulk', () => {
  const csv = [
    'العميل,السبب,الحالة,تاريخ الطلب',
    'منى 01234567890,ادخال بيانات خاطئة,مكتمل,20/11/2026 10:00',
    'ahmed 01111111111,otp_verify_failed,مكتمل,20/11/2026 11:00',
    'no phone here,ادخال بيانات خاطئة,مكتمل,20/11/2026 12:00',
    'Tester 01099999999,ادخال بيانات خاطئة,مكتمل,20/11/2026 13:00',
  ].join('\n');

  it('ranks rows: hot, ordered later, unreachable and likely test', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    await createOrder({ phone: '01111111111', created_at: '2026-11-21T10:00:00.000Z' }); // ahmed ordered afterwards
    await api.post('/api/admin/missed-orders/import', { text: csv });
    const res = await api.get('/api/admin/missed-orders?status=all');
    const by = Object.fromEntries(res.body.items.map((i) => [i.name, i.priority]));
    expect(by['منى']).toBe('hot');
    expect(by.ahmed).toBe('done');
    expect(by['no phone here']).toBe('unreachable');
    expect(by.Tester).toBe('likely_test');
    expect(res.body.priorityCounts).toMatchObject({ hot: 1, done: 1, unreachable: 1, likely_test: 1 });

    const hot = await api.get('/api/admin/missed-orders?status=all&priority=hot');
    expect(hot.body.items).toHaveLength(1);
  });

  it('moves selected rows to test and hides them by default', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    await api.post('/api/admin/missed-orders/import', { text: csv });
    const list = await api.get('/api/admin/missed-orders?status=all&priority=likely_test');
    const ids = list.body.items.map((i) => i._id);
    const res = await api.post('/api/admin/missed-orders/bulk', { ids, isTest: true });
    expect(res.body.updated).toBe(1);
    const after = await api.get('/api/admin/missed-orders?status=all');
    expect(after.body.items).toHaveLength(3);
    const onlyTest = await api.get('/api/admin/missed-orders?status=all&test=only');
    expect(onlyTest.body.items).toHaveLength(1);
  });

  it('treats a phone of a test order as a test phone', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    const o = await createOrder({ phone: '01234567890', created_at: '2026-11-19T10:00:00.000Z' });
    await Order.updateOne({ _id: o._id }, { $set: { isTest: true } });
    await api.post('/api/admin/missed-orders/import', { text: csv });
    const res = await api.get('/api/admin/missed-orders?status=all');
    expect(res.body.items.find((i) => i.name === 'منى').priority).toBe('likely_test');
  });
});
