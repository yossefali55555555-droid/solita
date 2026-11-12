import crypto from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { SiteSettings, StorefrontCart, StorefrontDailyStat, Visitor } from '../src/models/index.js';
import { cairoDayStart, expireStaleCarts } from '../src/services/storefrontService.js';
import { DEFAULT_SITE_SETTINGS } from '../src/validators/siteSettings.js';
import { client, createOrder, createUser, getTestApp, loginAs, postWebhook, orderPayload } from './helpers.js';

const STOREFRONT = 'https://solita.myeasyorders.com';
const vid = () => crypto.randomUUID();
let ipCounter = 0;
const nextIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

/** POST /api/public/events from the storefront (own IP per call unless given). */
function sendEvents(body, { origin = STOREFRONT, ip = nextIp(), contentType = 'application/json' } = {}) {
  const req = request(getTestApp()).post('/api/public/events').set('X-Forwarded-For', ip);
  if (origin) req.set('Origin', origin);
  req.set('Content-Type', contentType);
  return req.send(typeof body === 'string' ? body : JSON.stringify(body));
}

const shoe = (over = {}) => ({ slug: 'samba-wb', sku: 'samba-WB', name: 'Samba أبيض × أسود', size: '42', qty: 1, price: 1650, ...over });

describe('public storefront API: CORS and origin', () => {
  it('answers the preflight only for the storefront origin', async () => {
    const ok = await request(getTestApp())
      .options('/api/public/events')
      .set('Origin', STOREFRONT)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(STOREFRONT);
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();

    const bad = await request(getTestApp())
      .options('/api/public/events')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();

    // The dashboard origin is not a storefront origin.
    const dash = await request(getTestApp()).get('/api/public/site-config').set('Origin', 'http://localhost:5173');
    expect(dash.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects events without an allowed Origin header', async () => {
    const body = { visitorId: vid(), events: [{ type: 'page_view', path: '/' }] };
    expect((await sendEvents(body, { origin: null })).status).toBe(403);
    const res = await sendEvents(body, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BAD_ORIGIN');
    expect(await Visitor.countDocuments()).toBe(0);
  });

  it('does not need a session or CSRF token and leaves dashboard CSRF intact', async () => {
    const res = await sendEvents({ visitorId: vid(), events: [{ type: 'page_view', path: '/' }] });
    expect(res.status).toBe(202);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    // Dashboard routes still require CSRF.
    const dash = await request(getTestApp()).post('/api/auth/logout').set('Origin', STOREFRONT);
    expect(dash.status).toBe(403);
  });
});

describe('public storefront API: validation', () => {
  it('rejects a bad envelope', async () => {
    expect((await sendEvents({ visitorId: 'short', events: [{ type: 'page_view', path: '/' }] })).status).toBe(400);
    expect((await sendEvents({ visitorId: vid(), events: [] })).status).toBe(400);
    expect((await sendEvents({ visitorId: vid(), events: [{ type: 'page_view', path: '/' }], extra: 1 })).status).toBe(400);
    const tooMany = Array.from({ length: 51 }, () => ({ type: 'page_view', path: '/' }));
    expect((await sendEvents({ visitorId: vid(), events: tooMany })).status).toBe(400);
    expect((await sendEvents('{not json')).status).toBe(400);
  });

  it('rejects bodies larger than 32 KB', async () => {
    const big = { visitorId: vid(), events: [{ type: 'page_view', path: '/', title: 'x'.repeat(40_000) }] };
    const res = await sendEvents(big);
    expect(res.status).toBe(413);
  });

  it('skips invalid events, drops unknown fields and accepts text/plain (sendBeacon)', async () => {
    const visitorId = vid();
    const res = await sendEvents(
      {
        visitorId,
        newVisit: true,
        events: [
          { type: 'page_view', path: '/products/samba', title: 'Samba', ip: '1.2.3.4', userAgent: 'x' },
          { type: 'unknown_type' },
          { type: 'cart_add', item: shoe({ qty: 500 }) },
          { type: 'checkout_contact', phone: '12345' },
          { type: 'order_placed' },
        ],
      },
      { contentType: 'text/plain;charset=UTF-8' },
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, accepted: 1, rejected: 4 });
    const v = await Visitor.findOne({ visitorId }).lean();
    expect(v.visits).toBe(1);
    expect(v.pages).toBe(1);
    expect(v.lastPages[0]).toMatchObject({ path: '/products/samba', title: 'Samba' });
    expect(v.lastPages[0].ip).toBeUndefined();
    expect(await StorefrontCart.countDocuments()).toBe(0);
  });

  it('keeps only the last 20 pages of a visitor', async () => {
    const visitorId = vid();
    for (let batch = 0; batch < 3; batch += 1) {
      const events = Array.from({ length: 10 }, (_, i) => ({ type: 'page_view', path: `/p/${batch * 10 + i}` }));
      expect((await sendEvents({ visitorId, events })).status).toBe(202);
    }
    const v = await Visitor.findOne({ visitorId }).lean();
    expect(v.pages).toBe(30);
    expect(v.lastPages).toHaveLength(20);
    expect(v.lastPages.at(-1).path).toBe('/p/29');
  });
});

describe('public storefront API: rate limit', () => {
  it('limits events per IP', async () => {
    const ip = '10.99.99.99';
    const body = { visitorId: vid(), events: [{ type: 'page_view', path: '/' }] };
    let last;
    for (let i = 0; i < 121; i += 1) last = await sendEvents(body, { ip });
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe('RATE_LIMITED');
    // Another IP is not affected.
    expect((await sendEvents(body)).status).toBe(202);
  });
});

describe('storefront carts', () => {
  it('builds the cart from add / remove / snapshot and stores the checkout phone', async () => {
    const visitorId = vid();
    await sendEvents({
      visitorId,
      events: [
        { type: 'product_view', product: { slug: 'samba-wb', name: 'Samba' } },
        { type: 'cart_add', item: shoe() },
        { type: 'cart_add', item: shoe() },
        { type: 'cart_add', item: shoe({ slug: 'salaxi-w', sku: 'SALX-W', size: 41, price: 1499.5 }) },
        { type: 'cart_remove', item: { slug: 'samba-wb', size: '42', qty: 1 } },
      ],
    });
    let cart = await StorefrontCart.findOne({ visitorId }).lean();
    expect(cart.status).toBe('open');
    expect(cart.items).toHaveLength(2);
    expect(cart.itemsCount).toBe(2);
    expect(cart.value).toBe(165000 + 149950); // piasters
    expect(cart.items[1].size).toBe('41');

    await sendEvents({
      visitorId,
      events: [
        { type: 'cart_snapshot', items: [shoe({ qty: 2 })] },
        { type: 'checkout_contact', name: 'أحمد', phone: '+20 100 123 4567' },
      ],
    });
    cart = await StorefrontCart.findOne({ visitorId }).lean();
    expect(cart.items).toHaveLength(1);
    expect(cart.value).toBe(330000);
    expect(cart.customer).toMatchObject({ name: 'أحمد', phoneNormalized: '01001234567' });
    expect(await StorefrontCart.countDocuments({ visitorId })).toBe(1);

    const stats = await StorefrontDailyStat.find({ day: cairoDayStart() }).lean();
    const samba = stats.find((s) => s.slug === 'samba-wb');
    expect(samba).toMatchObject({ views: 1, adds: 2 });
  });

  it('converts the cart on order_placed and starts a new cart afterwards', async () => {
    const visitorId = vid();
    await sendEvents({ visitorId, events: [{ type: 'cart_add', item: shoe() }] });
    await sendEvents({
      visitorId,
      events: [
        { type: 'order_placed', orderId: 'eo-placed-1', shortId: '1234' },
        { type: 'cart_add', item: shoe({ slug: 'ajekke' }) },
      ],
    });
    const carts = await StorefrontCart.find({ visitorId }).sort({ createdAt: 1 }).lean();
    expect(carts).toHaveLength(2);
    expect(carts[0]).toMatchObject({ status: 'converted', active: false, convertedVia: 'order_placed', convertedOrderId: 'eo-placed-1', convertedShortId: 1234 });
    expect(carts[1]).toMatchObject({ status: 'open', active: true });

    // The EasyOrders order arrives later: the converted cart gets linked to it.
    const order = await createOrder({ id: 'eo-placed-1', short_id: 1234 });
    const linked = await StorefrontCart.findById(carts[0]._id).lean();
    expect(String(linked.convertedOrder)).toBe(String(order._id));
  });

  it('converts an active cart when an EasyOrders order with the same phone arrives by webhook', async () => {
    const visitorId = vid();
    await sendEvents({
      visitorId,
      events: [{ type: 'cart_add', item: shoe() }, { type: 'checkout_contact', phone: '01112223333' }],
    });
    const other = vid();
    await sendEvents({
      visitorId: other,
      events: [{ type: 'cart_add', item: shoe() }, { type: 'checkout_contact', phone: '01009998888' }],
    });

    const res = await postWebhook('orders', orderPayload({ id: 'eo-phone-1', phone: '+20 111 222 3333' }));
    expect(res.status).toBeLessThan(300);

    const cart = await StorefrontCart.findOne({ visitorId }).lean();
    expect(cart).toMatchObject({ status: 'converted', active: false, convertedVia: 'phone_match', convertedOrderId: 'eo-phone-1' });
    expect(cart.convertedOrder).toBeTruthy();
    expect((await StorefrontCart.findOne({ visitorId: other }).lean()).status).toBe('open');
  });

  it('does not phone-match on updates of an existing order, nor carts older than 14 days', async () => {
    await createOrder({ id: 'eo-old', phone: '01223334444' });
    const visitorId = vid();
    await sendEvents({
      visitorId,
      events: [{ type: 'cart_add', item: shoe() }, { type: 'checkout_contact', phone: '01223334444' }],
    });
    await createOrder({ id: 'eo-old', phone: '01223334444', updated_at: '2026-10-02T10:00:00.000Z' });
    expect((await StorefrontCart.findOne({ visitorId }).lean()).status).toBe('open');

    await StorefrontCart.updateOne({ visitorId }, { $set: { lastActivityAt: new Date(Date.now() - 15 * 864e5) } });
    await createOrder({ id: 'eo-new', phone: '01223334444' });
    expect((await StorefrontCart.findOne({ visitorId }).lean()).status).toBe('open');
  });

  it('expires carts with no activity for 30 days', async () => {
    const visitorId = vid();
    await sendEvents({ visitorId, events: [{ type: 'cart_add', item: shoe() }] });
    await StorefrontCart.updateOne({ visitorId }, { $set: { lastActivityAt: new Date(Date.now() - 31 * 864e5) } });
    expect(await expireStaleCarts()).toEqual({ expired: 1 });
    expect((await StorefrontCart.findOne({ visitorId }).lean()).status).toBe('expired');
  });

  it('sets TTL indexes for visitors and carts', async () => {
    const vIdx = await Visitor.collection.indexes();
    expect(vIdx.find((i) => i.key.lastSeen)?.expireAfterSeconds).toBe(90 * 86400);
    const cIdx = await StorefrontCart.collection.indexes();
    expect(cIdx.find((i) => i.key.lastActivityAt === 1)?.expireAfterSeconds).toBe(90 * 86400);
  });
});

describe('admin: abandoned carts and behaviour summary', () => {
  async function seedCarts() {
    const withPhone = vid();
    const noPhone = vid();
    await sendEvents({
      visitorId: withPhone,
      events: [
        { type: 'product_view', product: { slug: 'samba-wb', name: 'Samba' } },
        { type: 'cart_add', item: shoe() },
        { type: 'checkout_contact', name: 'منى', phone: '01001112222' },
      ],
    });
    await sendEvents({ visitorId: noPhone, newVisit: true, events: [{ type: 'cart_add', item: shoe({ slug: 'morebai' }) }] });
    const old = vid();
    await sendEvents({ visitorId: old, events: [{ type: 'cart_add', item: shoe({ slug: 'old' }) }] });
    await StorefrontCart.updateOne({ visitorId: old }, { $set: { lastActivityAt: new Date(Date.now() - 5 * 864e5) } });
    return { withPhone, noPhone, old };
  }

  it('requires an admin', async () => {
    expect((await request(getTestApp()).get('/api/admin/storefront/carts')).status).toBe(401);
    const courier = await loginAs(await createUser('courier'));
    expect((await courier.get('/api/admin/storefront/carts')).status).toBe(403);
    expect((await courier.get('/api/admin/site-settings')).status).toBe(403);
  });

  it('lists carts with filters and marks them contacted / dismissed', async () => {
    const { withPhone, noPhone } = await seedCarts();
    const admin = await loginAs(await createUser('admin'));

    const all = await admin.get('/api/admin/storefront/carts');
    expect(all.status).toBe(200);
    expect(all.body.pagination.total).toBe(3);

    const today = await admin.get('/api/admin/storefront/carts?range=today');
    expect(today.body.items.map((c) => c.visitorId).sort()).toEqual([withPhone, noPhone].sort());

    const phone = await admin.get('/api/admin/storefront/carts?hasPhone=true');
    expect(phone.body.items).toHaveLength(1);
    expect(phone.body.items[0].customer.phoneNormalized).toBe('01001112222');

    const cartId = phone.body.items[0]._id;
    const contacted = await admin.post(`/api/admin/storefront/carts/${cartId}/contacted`);
    expect(contacted.status).toBe(200);
    expect(contacted.body.cart).toMatchObject({ status: 'contacted', contactCount: 1 });

    const notContacted = await admin.get('/api/admin/storefront/carts?notContacted=true');
    expect(notContacted.body.items.map((c) => c._id)).not.toContain(cartId);

    const dismissed = await admin.post(`/api/admin/storefront/carts/${cartId}/dismiss`);
    expect(dismissed.body.cart).toMatchObject({ status: 'expired', active: false });
    expect((await admin.post(`/api/admin/storefront/carts/${cartId}/contacted`)).status).toBe(422);
    expect((await admin.post('/api/admin/storefront/carts/0123456789abcdef01234567/dismiss')).status).toBe(404);

    const expired = await admin.get('/api/admin/storefront/carts?status=expired');
    expect(expired.body.items.map((c) => c._id)).toEqual([cartId]);
    expect((await admin.get('/api/admin/storefront/carts?range=yesterday')).status).toBe(400);
  });

  it('summarizes visitor behaviour', async () => {
    await seedCarts();
    const admin = await loginAs(await createUser('admin'));
    const res = await admin.get('/api/admin/storefront/summary');
    expect(res.status).toBe(200);
    expect(res.body.visitorsToday).toBe(3);
    expect(res.body.visitors7d).toBe(3);
    expect(res.body.carts7d.open).toBe(3);
    expect(res.body.topViewed[0]).toMatchObject({ slug: 'samba-wb', views: 1 });
    expect(res.body.addedNotBought.map((p) => p.slug)).toEqual(expect.arrayContaining(['samba-wb', 'morebai', 'old']));
  });
});

describe('site settings', () => {
  it('serves the defaults publicly with a 60 s cache and without admin-only settings', async () => {
    const res = await request(getTestApp()).get('/api/public/site-config').set('Origin', STOREFRONT);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60, s-maxage=60');
    expect(res.headers['access-control-allow-origin']).toBe(STOREFRONT);
    expect(res.body.revision).toBe(0);
    expect(res.body.settings.shelf.lines).toHaveLength(6);
    expect(res.body.settings.shelf.lines[0].sku).toBe('alex333-BBGoldtext');
    expect(res.body.settings.features.warranty.title.ar).toBe('ضمان 45 يومًا');
    expect(res.body.settings.admin).toBeUndefined();
  });

  it('lets an admin edit the settings and the storefront sees them', async () => {
    const admin = await loginAs(await createUser('admin'));
    const current = await admin.get('/api/admin/site-settings');
    expect(current.status).toBe(200);
    expect(current.body.defaults).toEqual(DEFAULT_SITE_SETTINGS);

    const next = structuredClone(current.body.settings);
    next.shelf.lines[2] = { sku: 'samba-WGrey', fallbacks: ['samba-WB'] };
    next.cards.speed = 'fast';
    next.announcement = { enabled: true, text: { ar: 'خصم على الشرابات', en: 'Socks offer' }, link: '/collections/socks' };
    next.toggles.sounds = false;
    const saved = await admin.patch('/api/admin/site-settings', next);
    expect(saved.status).toBe(200);
    expect(saved.body.revision).toBe(1);
    expect(saved.body.updatedBy.name).toBeTruthy();

    const pub = await request(getTestApp()).get('/api/public/site-config');
    expect(pub.body.revision).toBe(1);
    expect(pub.body.settings.shelf.lines[2]).toEqual({ sku: 'samba-WGrey', fallbacks: ['samba-WB'] });
    expect(pub.body.settings.cards.speed).toBe('fast');
    expect(pub.body.settings.toggles.sounds).toBe(false);
    expect(pub.body.settings.announcement.enabled).toBe(true);
  });

  it('validates settings strictly', async () => {
    const admin = await loginAs(await createUser('admin'));
    const base = structuredClone(DEFAULT_SITE_SETTINGS);
    const bad = [
      { ...base, extra: true },
      { ...base, shelf: { lines: base.shelf.lines.slice(0, 5) } },
      { ...base, cards: { speed: 'turbo' } },
      { ...base, announcement: { ...base.announcement, link: 'javascript:alert(1)' } },
      { ...base, shelf: { lines: base.shelf.lines.map((l, i) => (i ? l : { sku: 'bad sku!', fallbacks: [] })) } },
    ];
    for (const body of bad) {
      const res = await admin.patch('/api/admin/site-settings', body);
      expect(res.status).toBe(400);
    }
    // Needs CSRF like every dashboard write.
    const anon = await client();
    anon.setToken('nope');
    expect((await anon.patch('/api/admin/site-settings', base)).status).toBe(403);
  });

  it('falls back to defaults section by section when stored data is broken', async () => {
    await SiteSettings.create({ key: 'site', revision: 3, settings: { cards: { speed: 'warp' }, gift: { title: { ar: 'هدية', en: 'Gift' } } } });
    const res = await request(getTestApp()).get('/api/public/site-config');
    expect(res.body.settings.cards.speed).toBe('normal');
    expect(res.body.settings.gift.title.ar).toBe('هدية');
    expect(res.body.settings.gift.text.ar).toBe(DEFAULT_SITE_SETTINGS.gift.text.ar);
  });
});

describe('cairoDayStart', () => {
  it('returns Cairo midnight', () => {
    // 2026-11-13 01:30 Cairo (UTC+2 in winter) = 2026-11-12T23:30Z
    expect(cairoDayStart(new Date('2026-11-12T23:30:00Z')).toISOString()).toBe('2026-11-12T22:00:00.000Z');
    expect(cairoDayStart(new Date('2026-11-12T23:30:00Z'), 1).toISOString()).toBe('2026-11-11T22:00:00.000Z');
    // Summer time (UTC+3)
    expect(cairoDayStart(new Date('2026-07-01T12:00:00Z')).toISOString()).toBe('2026-06-30T21:00:00.000Z');
  });
});
