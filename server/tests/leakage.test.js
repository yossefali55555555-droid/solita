import { describe, expect, it } from 'vitest';
import {
  CouponAssignment,
  CouponAttempt,
  DeliveryReview,
  MissedOrder,
  Order,
  OrderEvent,
  StorefrontCart,
} from '../src/models/index.js';
import { addToPool, ensureCouponForOrder } from '../src/services/couponService.js';
import { assignFounderForOrder } from '../src/services/founderService.js';
import { DANGEROUS, SECTION_KEYS } from '../src/constants/permissions.js';
import { decodeCustomerKey, encodeCustomerKey, isPhoneValue, looksLikePhone } from '../src/services/visibilityService.js';
import { createAssignedOrder, createOrder, createUser, loginAs } from './helpers.js';

/**
 * Leak test (SPEC part c): a customer, a cart, a missed order, a founder, a
 * coupon and a delivery review all carry one distinctive customer number. A
 * moderator without the phone grant calls every GET route (and the POST/PATCH
 * routes that return records): the number, in any format, must not be in any
 * response. A second run with the grant proves the test is not vacuous.
 */

const PHONE = '01011122233'; // normalized form stored in phoneNormalized
const RAW_PHONE = '+20 101 112 2233'; // as typed on the storefront (stored in `phone`)
const SECRET_NAME = 'عميل سري';
const noGrants = { dangerous: [], fields: [] };
const allSections = Object.fromEntries(SECTION_KEYS.map((k) => [k, 'edit']));

const FORMATS = [PHONE, `20${PHONE.slice(1)}`, `+20${PHONE.slice(1)}`, PHONE.slice(1), RAW_PHONE, '0101 112 2233', '010-1112-2233'];

/** True when the text shows the number in any of its formats (also digits only). */
function leaks(text) {
  if (FORMATS.some((f) => text.includes(f))) return true;
  return text.replace(/\D/g, '').includes(PHONE.slice(1));
}

async function seed() {
  const admin = await createUser('admin');
  const courier = await createUser('courier', { name: 'مندوب اختبار' });

  // The customer's order (new, printable) with coupon + founder.
  const order = await createOrder({ phone: RAW_PHONE, full_name: SECRET_NAME });
  expect(order.customer.phoneNormalized).toBe(PHONE);
  await addToPool(['leak-1', 'leak-2']);
  const coupon = await ensureCouponForOrder(order);
  await Order.updateOne({ _id: order._id }, { $set: { deliveryStatus: 'delivered', deliveredAt: new Date() } });
  const founder = await assignFounderForOrder(await Order.findById(order._id));

  // A failed delivery (returns page) and an order with a pending review (reviews page).
  const failed = await createAssignedOrder(courier, admin, { phone: RAW_PHONE, full_name: SECRET_NAME }, 'failed');
  const reviewed = await createAssignedOrder(courier, admin, { phone: RAW_PHONE, full_name: SECRET_NAME }, 'pending_delivery_review');
  const review = await DeliveryReview.create({
    order: reviewed._id,
    courier: courier._id,
    status: 'pending',
    submittedAt: new Date(),
    collectedAmount: 105000,
  });
  const plain = await createOrder({ phone: RAW_PHONE, full_name: SECRET_NAME });

  const cart = await StorefrontCart.create({
    visitorId: 'leak-visitor-0000000000000001',
    items: [{ slug: 's', name: 'S', size: '42', qty: 1, price: 100000 }],
    value: 100000,
    itemsCount: 1,
    customer: { name: SECRET_NAME, phone: RAW_PHONE, phoneNormalized: PHONE },
    status: 'open',
    active: true,
    lastSeenAt: new Date(),
    lastActivityAt: new Date(),
  });
  const missed = await MissedOrder.create({
    key: 'leak-missed-1',
    name: SECRET_NAME,
    phone: RAW_PHONE,
    phoneNormalized: PHONE,
    reason: 'otp_verify_failed',
    eoDate: new Date(),
  });
  await CouponAttempt.create({
    code: 'leak-1',
    reason: 'wrong_phone',
    stage: 'apply',
    visitorId: cart.visitorId,
    phoneTyped: RAW_PHONE,
    phoneNormalized: PHONE,
    ownerPhone: PHONE,
  });
  return { admin, courier, order, plain, failed, reviewed, review, cart, missed, founder, coupon };
}

/** Real ids for the routes that take one. */
function resolve(path, ids, customerKey) {
  return path
    .replace('/couriers/:id', `/couriers/${ids.courier._id}`)
    .replace('/orders/:id', `/orders/${ids.plain._id}`)
    .replace('/delivery-reviews/:id', `/delivery-reviews/${ids.review._id}`)
    .replace('/customers/:key', `/customers/${encodeURIComponent(customerKey)}`)
    .replace(/:\w+/g, '64b7f0c2a1b2c3d4e5f60718');
}

const GET_PATHS = [
  '/overview',
  '/couriers',
  '/couriers-brief',
  '/couriers/:id',
  '/couriers/:id/events',
  '/orders',
  '/orders/cleared/count',
  '/orders/:id',
  '/orders/:id/events',
  '/delivery-reviews',
  '/delivery-reviews/:id',
  '/sync/failures',
  '/easyorders/poll',
  '/cash/overview',
  '/cash/eligible-orders',
  '/cash/remittances',
  '/cash/remittances/:id',
  '/cash/remittances/:id/events',
  '/labels',
  '/returns',
  '/customers',
  '/customers/:key',
  '/finance/summary',
  '/finance/expenses',
  '/storefront/carts',
  '/storefront/summary',
  '/storefront/pages',
  '/missed-orders',
  '/coupons',
  '/coupons/attempts',
  '/founders',
  '/site-settings',
];

const withQuery = (path) => (path === '/orders' ? `${path}?test=include&cleared=include` : path);

describe('no customer number reaches a moderator without the phone grant', () => {
  it('on any GET route, and on the writes that return records', async () => {
    const ids = await seed();
    const moderator = await createUser('moderator', { permissions: { sections: allSections, ...noGrants, dangerous: Object.keys(DANGEROUS) } });
    const api = await loginAs(moderator);

    const customers = await api.get('/api/admin/customers');
    expect(customers.status).toBe(200);
    const customerKey = customers.body.items[0].key;

    // courier phone is allowed to show (couriers section): hide it from this check
    // by comparing only the customer number, which the courier does not share.
    for (const path of GET_PATHS) {
      const res = await api.get(`/api/admin${withQuery(resolve(path, ids, customerKey))}`);
      expect(res.status, `GET ${path}`).toBeLessThan(500);
      expect(leaks(res.text), `GET ${path} leaked the number`).toBe(false);
    }

    const writes = [
      ['post', `/storefront/carts/${ids.cart._id}/contacted`, {}],
      ['patch', `/missed-orders/${ids.missed._id}`, { note: 'ملاحظة' }],
      ['patch', `/founders/${ids.founder._id}`, { notes: 'ملاحظة' }],
      ['post', `/orders/${ids.plain._id}/test`, { isTest: true }],
      ['patch', `/orders/${ids.plain._id}/assignment`, { courierId: String(ids.courier._id) }],
      ['post', `/coupons/${ids.coupon._id}/release`, {}],
    ];
    for (const [method, path, body] of writes) {
      const res = await api[method](`/api/admin${path}`, body);
      expect(res.status, `${method.toUpperCase()} ${path} -> ${res.status} ${res.text.slice(0, 160)}`).toBeLessThan(400);
      expect(leaks(res.text), `${method.toUpperCase()} ${path} leaked the number`).toBe(false);
    }
  });

  it('the same calls do show the number to a moderator who holds the grant (the check is not vacuous)', async () => {
    const ids = await seed();
    const moderator = await createUser('moderator', {
      permissions: { sections: allSections, dangerous: [], fields: [{ key: 'customerPhone', until: null }] },
    });
    const api = await loginAs(moderator);
    for (const path of ['/orders', `/orders/${ids.plain._id}`, '/customers', '/storefront/carts', '/missed-orders', '/founders', '/coupons', '/returns']) {
      const res = await api.get(`/api/admin${path}`);
      expect(res.status, path).toBe(200);
      expect(leaks(res.text), `${path} should show the number to its holder`).toBe(true);
    }
  });

  it('a courier number is hidden from a moderator without the couriers section', async () => {
    const ids = await seed();
    const sections = { ...allSections };
    delete sections.couriers;
    const moderator = await createUser('moderator', { permissions: { sections, ...noGrants } });
    const api = await loginAs(moderator);
    for (const path of ['/orders', `/orders/${ids.plain._id}`, '/couriers-brief', '/delivery-reviews', `/delivery-reviews/${ids.review._id}`, '/returns']) {
      const res = await api.get(`/api/admin${path}`);
      expect(res.status, path).toBe(200);
      expect(res.text.includes(ids.courier.phone), `${path} leaked the courier number`).toBe(false);
    }
    // ...and a moderator who may see couriers does see it.
    const withCouriers = await createUser('moderator', { permissions: { sections: { couriers: 'view', orders: 'view' }, ...noGrants } });
    const api2 = await loginAs(withCouriers);
    expect((await api2.get('/api/admin/couriers')).text.includes(ids.courier.phone)).toBe(true);
  });

  it('the admin sees everything', async () => {
    const ids = await seed();
    const api = await loginAs(ids.admin);
    expect(leaks((await api.get('/api/admin/orders')).text)).toBe(true);
    expect(leaks((await api.get('/api/admin/customers')).text)).toBe(true);
  });
});

describe('side channels', () => {
  it('searching by number is refused, and a partial number matches nothing', async () => {
    await seed();
    const moderator = await createUser('moderator', { permissions: { sections: { orders: 'view', customers: 'view', missedOrders: 'view' }, ...noGrants } });
    const api = await loginAs(moderator);
    for (const base of ['/orders', '/customers', '/missed-orders']) {
      for (const q of [PHONE, `+20${PHONE.slice(1)}`, '010 1112 2233', PHONE.slice(1)]) {
        const res = await api.get(`/api/admin${base}?q=${encodeURIComponent(q)}`);
        expect(res.status, `${base} q=${q}`).toBe(400);
        expect(res.body.error.code).toBe('PHONE_SEARCH_FORBIDDEN');
        expect(leaks(res.text)).toBe(false);
      }
      // a short fragment does not look like a number but must not match the phone either
      const short = await api.get(`/api/admin${base}?q=1112`);
      expect(short.status).toBe(200);
      expect(short.body.items).toHaveLength(0);
    }
    // by name still works
    expect((await api.get(`/api/admin/orders?q=${encodeURIComponent(SECRET_NAME)}`)).body.items.length).toBeGreaterThan(0);

    const holder = await createUser('moderator', { permissions: { sections: { orders: 'view' }, dangerous: [], fields: [{ key: 'customerPhone', until: null }] } });
    const holderApi = await loginAs(holder);
    expect((await holderApi.get(`/api/admin/orders?q=${PHONE}`)).body.items.length).toBeGreaterThan(0);
  });

  it('the customer link is an opaque key: the number is not in it, and a raw or forged key finds nothing', async () => {
    await seed();
    const moderator = await createUser('moderator', { permissions: { sections: { customers: 'view' }, ...noGrants } });
    const api = await loginAs(moderator);
    const list = await api.get('/api/admin/customers');
    const key = list.body.items[0].key;
    expect(key).toMatch(/^c_[\w-]+$/);
    expect(leaks(key)).toBe(false);
    const detail = await api.get(`/api/admin/customers/${encodeURIComponent(key)}`);
    expect(detail.status).toBe(200);
    expect(detail.body.customer.name).toBe(SECRET_NAME);
    expect(leaks(detail.text)).toBe(false);

    for (const bad of [PHONE, `name:${SECRET_NAME}`, `${key}x`, `c_${'A'.repeat(60)}`, 'c_']) {
      const res = await api.get(`/api/admin/customers/${encodeURIComponent(bad)}`);
      expect(res.status, bad).toBe(404);
    }

    // A holder of the grant may still open an old bookmark with the raw key.
    const holder = await createUser('moderator', { permissions: { sections: { customers: 'view' }, dangerous: [], fields: [{ key: 'customerPhone', until: null }] } });
    const holderApi = await loginAs(holder);
    expect((await holderApi.get(`/api/admin/customers/${PHONE}`)).status).toBe(200);
    expect((await holderApi.get(`/api/admin/customers/${encodeURIComponent(key)}`)).status).toBe(200);
  });

  it('a coupon cannot be used to find out whether a number is a customer', async () => {
    const ids = await seed();
    const pool = await CouponAssignment.findOne({ phoneNormalized: null });
    const moderator = await createUser('moderator', { permissions: { sections: { coupons: 'edit' }, ...noGrants } });
    const api = await loginAs(moderator);
    const res = await api.post(`/api/admin/coupons/${pool._id}/assign`, { phone: PHONE, name: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).not.toContain('لديه كود');
    expect(ids.coupon.phoneNormalized).toBe(PHONE);
    const holder = await createUser('moderator', { permissions: { sections: { coupons: 'edit' }, dangerous: [], fields: [{ key: 'customerPhone', until: null }] } });
    const holderApi = await loginAs(holder);
    const res2 = await holderApi.post(`/api/admin/coupons/${pool._id}/assign`, { phone: PHONE, name: 'x' });
    expect(res2.body.error.message).toContain('لديه كود');
  });

  it('validation and not-found errors never echo a stored number', async () => {
    await seed();
    const moderator = await createUser('moderator', { permissions: { sections: allSections, ...noGrants } });
    const api = await loginAs(moderator);
    for (const path of ['/orders/zzz', '/customers/' + 'q'.repeat(800), '/orders?deliveryStatus=nope']) {
      const res = await api.get(`/api/admin${path}`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(leaks(res.text)).toBe(false);
    }
  });
});

describe('money figures', () => {
  it('customer totals and net profit need moneyFigures', async () => {
    await seed();
    const noMoney = await createUser('moderator', { permissions: { sections: { customers: 'view', finance: 'view' }, ...noGrants } });
    const api = await loginAs(noMoney);
    const list = await api.get('/api/admin/customers?sort=spent');
    expect(list.status).toBe(200);
    expect(list.body.items[0]).not.toHaveProperty('totalOrdered');
    expect(list.body.items[0]).not.toHaveProperty('totalDelivered');
    const finance = await api.get('/api/admin/finance/summary');
    expect(finance.body).not.toHaveProperty('netProfit');
    expect(finance.body).not.toHaveProperty('cash');
    expect(finance.body.sales).toBeTruthy();

    const money = await createUser('moderator', { permissions: { sections: { customers: 'view', finance: 'view' }, dangerous: [], fields: [{ key: 'moneyFigures', until: null }] } });
    const api2 = await loginAs(money);
    expect((await api2.get('/api/admin/customers')).body.items[0]).toHaveProperty('totalDelivered');
    expect((await api2.get('/api/admin/finance/summary')).body).toHaveProperty('netProfit');
  });

  it('the overview only holds the blocks of the sections the moderator has', async () => {
    await seed();
    const moderator = await createUser('moderator', { permissions: { sections: { dashboard: 'view', orders: 'view' }, ...noGrants } });
    const api = await loginAs(moderator);
    const res = await api.get('/api/admin/overview');
    expect(res.status).toBe(200);
    expect(res.body.stats.orders).toBeTruthy();
    for (const block of ['cash', 'sync', 'pendingReviews']) expect(res.body.stats).not.toHaveProperty(block);
    expect(res.body).not.toHaveProperty('system');

    const cashToo = await createUser('moderator', { permissions: { sections: { dashboard: 'view', cash: 'view' }, ...noGrants } });
    const api2 = await loginAs(cashToo);
    const res2 = await api2.get('/api/admin/overview');
    expect(res2.body.stats.cash).toBeTruthy();
    expect(res2.body.stats).not.toHaveProperty('orders');
  });
});

describe('server-side export of missed orders', () => {
  const grants = (fields) => ({
    sections: { missedOrders: 'view' },
    dangerous: [],
    fields: fields.map((key) => ({ key, until: null })),
  });

  it('needs both the export and the phone grants', async () => {
    await seed();
    for (const fields of [[], ['export'], ['customerPhone']]) {
      const moderator = await createUser('moderator', { permissions: grants(fields) });
      const res = await (await loginAs(moderator)).get('/api/admin/missed-orders/export');
      expect(res.status, fields.join()).toBe(403);
      expect(res.text.includes('01011122233')).toBe(false);
    }
  });

  it('returns a CSV, records the row count, and neutralises formulas', async () => {
    await seed();
    await MissedOrder.create({
      key: 'leak-missed-2',
      name: '=HYPERLINK("x")',
      phone: '01022233344',
      phoneNormalized: '01022233344',
      reason: 'otp_verify_failed',
      eoDate: new Date(),
    });
    const moderator = await createUser('moderator', { permissions: grants(['export', 'customerPhone']) });
    const api = await loginAs(moderator);
    const res = await api.get('/api/admin/missed-orders/export?status=all');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain(PHONE);
    expect(res.text).toContain("'=HYPERLINK");
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 rows
    const event = await OrderEvent.findOne({ type: 'missed_orders_exported' }).lean();
    expect(event.next.rows).toBe(2);
    expect(String(event.actor.user)).toBe(String(moderator._id));
  });

  it('without the export grant a page holds at most 50 rows', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      key: `bulk-${i}`,
      name: `زبون ${i}`,
      phone: `01033${String(100000 + i)}`,
      phoneNormalized: `01033${String(100000 + i)}`,
      reason: 'otp_verify_failed',
      eoDate: new Date(Date.now() - i * 1000),
    }));
    await MissedOrder.insertMany(rows);
    const small = await createUser('moderator', { permissions: grants(['customerPhone']) });
    const res = await (await loginAs(small)).get('/api/admin/missed-orders?limit=100');
    expect(res.body.items).toHaveLength(50);
    expect(res.body.pagination.total).toBe(60);
    const big = await createUser('moderator', { permissions: grants(['customerPhone', 'export']) });
    expect((await (await loginAs(big)).get('/api/admin/missed-orders?limit=100')).body.items).toHaveLength(60);
  });
});

describe('site settings: WhatsApp texts are for the administrator', () => {
  it('a moderator may save the page but not change the ready-made texts', async () => {
    const admin = await createUser('admin');
    const moderator = await createUser('moderator', { permissions: { sections: { siteSettings: 'edit' }, ...noGrants } });
    const api = await loginAs(moderator);
    const current = await api.get('/api/admin/site-settings');
    expect(current.status).toBe(200);
    const settings = current.body.settings;

    const same = await api.patch('/api/admin/site-settings', settings);
    expect(same.status, same.text).toBe(200);

    const edited = { ...settings, admin: { ...settings.admin, cartWhatsappTemplate: 'نص جديد من المودريتور' } };
    const refused = await api.patch('/api/admin/site-settings', edited);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('WHATSAPP_TEMPLATES_ADMIN_ONLY');

    const adminApi = await loginAs(admin);
    expect((await adminApi.patch('/api/admin/site-settings', edited)).status).toBe(200);
  });
});

describe('visibility helpers', () => {
  it('encodes and decodes the customer key, and rejects tampering', () => {
    const key = encodeCustomerKey(PHONE);
    expect(key).toMatch(/^c_/);
    expect(key).not.toContain(PHONE);
    expect(encodeCustomerKey(PHONE)).toBe(key); // stable
    expect(decodeCustomerKey(key)).toBe(PHONE);
    expect(decodeCustomerKey(`${key.slice(0, -2)}AA`)).toBeNull();
    expect(decodeCustomerKey(PHONE)).toBeNull();
    expect(decodeCustomerKey(encodeCustomerKey('name:سارة'))).toBe('name:سارة');
  });

  it('recognises Egyptian numbers in every format and nothing else', () => {
    for (const v of ['01011122233', '201011122233', '+201011122233', '00201011122233', '+20 101 112 2233', '010-1112-2233']) {
      expect(isPhoneValue(v), v).toBe(true);
    }
    for (const v of ['1042', 'order 01011122233', '64b7f0c2a1b2c3d4e5f60718', '2026-11-25', '']) expect(isPhoneValue(v), v).toBe(false);
    expect(looksLikePhone('0101112')).toBe(true);
    expect(looksLikePhone('+20 101')).toBe(false);
    expect(looksLikePhone('1042')).toBe(false);
    expect(looksLikePhone('سارة')).toBe(false);
  });
});
