import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PERMISSION_META, ROUTER_SCOPE, adminOnly, staffRouter } from '../src/middleware/permissions.js';
import { DANGEROUS, FIELD_KEYS, SECTION_KEYS } from '../src/constants/permissions.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { User } from '../src/models/index.js';
import { createUser, getTestApp, loginAs, client } from './helpers.js';

/**
 * Walks every route registered in the real Express app. Any route that is
 * not in an exempt area must start with permission metadata, otherwise this
 * test fails (default deny is also enforced at runtime by staffRouter).
 */

// Areas that keep their own access rules (unchanged by the moderators work).
const EXEMPT_SCOPES = new Set(['auth', 'webhooks', 'courier', 'public', 'couponSync']);
// Single routes outside any router, with their own protection.
const EXEMPT_ROUTES = new Set(['app GET /api/health', 'api GET /cron/process', 'api GET /cron/digest']);

function scopeOf(layer, parentScope) {
  const tagged = layer.handle[ROUTER_SCOPE];
  if (tagged) return tagged;
  if (parentScope === 'app') {
    if (layer.match('/api/public')) return 'public';
    if (layer.match('/api/coupon-sync')) return 'couponSync';
  }
  return `untagged-router-in-${parentScope}`;
}

function collectRoutes(app) {
  const routes = [];
  const walk = (stack, scope) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods).filter((m) => m !== '_all')) {
          const first = layer.route.stack[0]?.handle;
          routes.push({
            scope,
            method: method.toUpperCase(),
            path: layer.route.path,
            meta: first?.[PERMISSION_META] || null,
            handlers: layer.route.stack.map((l) => l.handle),
          });
        }
      } else if (Array.isArray(layer.handle?.stack)) {
        walk(layer.handle.stack, scopeOf(layer, scope));
      }
    }
  };
  walk(app.router.stack, 'app');
  return routes;
}

const routes = collectRoutes(getTestApp());
const staffRoutes = routes.filter((r) => r.scope === 'staff');
const fakeId = '64b7f0c2a1b2c3d4e5f60718';
const urlOf = (r) => `/api/admin${r.path.replace(/:\w+/g, fakeId)}`;

function send(api, r, body) {
  if (r.method === 'GET') return api.get(urlOf(r));
  if (r.method === 'POST') return api.post(urlOf(r), body);
  if (r.method === 'PATCH') return api.patch(urlOf(r), body);
  throw new Error(`unexpected method ${r.method}`);
}

describe('route permission metadata (default deny)', () => {
  it('finds the routes of every area', () => {
    const scopes = new Set(routes.map((r) => r.scope));
    for (const s of ['staff', 'auth', 'webhooks', 'courier', 'public', 'couponSync', 'api', 'app']) expect(scopes).toContain(s);
  });

  it('every non-exempt route starts with permission metadata', () => {
    const missing = routes
      .filter((r) => !EXEMPT_SCOPES.has(r.scope) && !EXEMPT_ROUTES.has(`${r.scope} ${r.method} ${r.path}`))
      .filter((r) => !r.meta || r.meta.unmapped)
      .map((r) => `${r.scope} ${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('maps all 92 admin routes: requirePermission everywhere, adminOnly only for init-db', () => {
    // main's 89 (85 original + export + size-guide x2 + nav-counts) + WhatsApp texts read and click log (2, phase 5) + Meta Ads export (1).
    expect(staffRoutes).toHaveLength(92);
    for (const r of staffRoutes) {
      expect(r.meta?.unmapped, `${r.method} ${r.path}`).toBeFalsy();
      expect(r.meta?.adminOnly === true, `${r.method} ${r.path}`).toBe(r.path === '/system/init-db');
      // Permission middleware is the only metadata-bearing handler and comes first.
      expect(r.handlers.filter((h) => h[PERMISSION_META])).toHaveLength(1);
    }
  });

  it('records a valid planned permission for every admin route except init-db', () => {
    for (const r of staffRoutes) {
      if (r.path === '/system/init-db') {
        expect(r.meta.plan).toBeNull();
        continue;
      }
      const { plan } = r.meta;
      expect(plan, `${r.method} ${r.path}`).toBeTruthy();
      for (const s of plan.sections) expect(SECTION_KEYS).toContain(s);
      if (plan.dangerous) expect(DANGEROUS[plan.dangerous]).toBeTruthy();
      for (const f of plan.fields) expect(FIELD_KEYS).toContain(f);
      if (plan.level === 'view') expect(plan.dangerous).toBeNull();
    }
  });

  it('a staff route registered without metadata is denied to everyone, admin included', async () => {
    const r = staffRouter();
    r.get('/unmapped', (_req, res) => res.json({ leaked: true }));
    r.get('/mapped', adminOnly('orders', 'view'), (_req, res) => res.json({ ok: true }));
    const app = express();
    app.use((req, _res, next) => {
      req.user = { role: 'admin' };
      next();
    });
    app.use(r);
    app.use(errorHandler);
    const unmapped = await request(app).get('/unmapped');
    expect(unmapped.status).toBe(403);
    expect(unmapped.body.leaked).toBeUndefined();
    expect((await request(app).get('/mapped')).status).toBe(200);
  });

  it('rejects unknown catalog keys when a route is declared', () => {
    expect(() => adminOnly('nope', 'view')).toThrow();
    expect(() => adminOnly('orders', 'delete')).toThrow();
    expect(() => adminOnly('orders', 'edit', { dangerous: 'dropDatabase' })).toThrow();
    expect(() => adminOnly('orders', 'view', { fields: ['partners'] })).toThrow();
  });
});

describe('phase 2: every route x (none / view / edit / edit + grants)', () => {
  const allGrants = {
    sections: Object.fromEntries(SECTION_KEYS.map((k) => [k, 'edit'])),
    dangerous: Object.keys(DANGEROUS),
    fields: FIELD_KEYS.map((key) => ({ key, until: null })),
  };

  const forbidden = (res) => res.status === 403 && res.body.error?.code === 'FORBIDDEN';

  /** Permissions that satisfy a route's sections at `level`, optionally with its grants. */
  function grantsFor(plan, level, withGrants) {
    const sections = {};
    // "any of these sections" routes (couriers-brief) need only the first one.
    const needed = plan.sections.length > 1 ? [plan.sections[0]] : plan.sections;
    for (const sec of needed) sections[sec] = level;
    for (const [sec, lvl] of Object.entries(plan.also)) sections[sec] = lvl;
    return {
      sections,
      dangerous: withGrants && plan.dangerous ? [plan.dangerous] : [],
      fields: withGrants ? plan.fields.map((key) => ({ key, until: null })) : [],
    };
  }

  const routesWithPlan = staffRoutes.filter((r) => r.path !== '/system/init-db');

  it('refuses a moderator without permissions on every route, and ignores what the request claims', async () => {
    const moderator = await createUser('moderator');
    const api = await loginAs(moderator);
    for (const r of staffRoutes) {
      const res = await send(api, r, { role: 'admin', isAdmin: true, permissions: allGrants }).set('x-role', 'admin');
      expect(forbidden(res), `${r.method} ${r.path} -> ${res.status}`).toBe(true);
    }
  });

  it('follows each route plan: view / edit without grants / edit with grants', async () => {
    const moderator = await createUser('moderator');
    const api = await loginAs(moderator);
    const set = (permissions) => User.updateOne({ _id: moderator._id }, { $set: { permissions } });
    for (const r of routesWithPlan) {
      const { plan } = r.meta;
      const label = `${r.method} ${r.path}`;
      const hasGrants = Boolean(plan.dangerous) || plan.fields.length > 0;

      // view only
      await set(grantsFor(plan, 'view', true));
      const viewRes = await send(api, r, {});
      expect(forbidden(viewRes), `${label} with view`).toBe(plan.level === 'edit');

      // edit, but no dangerous / mandatory field grant
      await set(grantsFor(plan, 'edit', false));
      const bareRes = await send(api, r, {});
      expect(forbidden(bareRes), `${label} with edit, no grants`).toBe(hasGrants);

      // edit + the grants the route lists
      await set(grantsFor(plan, 'edit', true));
      const fullRes = await send(api, r, {});
      expect(forbidden(fullRes), `${label} with edit + grants`).toBe(false);
    }
  });

  it('a section at the wrong place does not help (orders edit cannot reach cash, and the reverse)', async () => {
    const moderator = await createUser('moderator', { permissions: { sections: { orders: 'edit' }, dangerous: [], fields: [] } });
    const api = await loginAs(moderator);
    expect(forbidden(await api.get('/api/admin/cash/overview'))).toBe(true);
    expect(forbidden(await api.get('/api/admin/finance/summary'))).toBe(true);
    expect(forbidden(await api.get('/api/admin/customers'))).toBe(true);
    expect(forbidden(await api.get('/api/admin/orders'))).toBe(false);
  });

  it('a moderator with every permission is still refused on init-db (administrator only)', async () => {
    const moderator = await createUser('moderator', { permissions: allGrants });
    const api = await loginAs(moderator);
    expect(forbidden(await api.post('/api/admin/system/init-db', {}))).toBe(true);
  });

  it('bulk order actions need the same dangerous grant as their single-order twins', async () => {
    const moderator = await createUser('moderator', { permissions: { sections: { orders: 'edit' }, dangerous: [], fields: [] } });
    const api = await loginAs(moderator);
    const id = fakeId;
    const cases = [
      [{ action: 'mark_test', ids: [id] }, 'markTest'],
      [{ action: 'unmark_test', ids: [id] }, 'markTest'],
      [{ action: 'cancel', ids: [id], reason: 'اختبار', syncToEasyOrders: false }, 'changeOrderStatus'],
      [{ action: 'reopen', ids: [id], reason: 'اختبار' }, 'changeOrderStatus'],
      [{ action: 'hide', ids: [id] }, 'clearOrders'],
    ];
    for (const [body, grant] of cases) {
      expect(forbidden(await api.post('/api/admin/orders/bulk', body)), `${body.action} without ${grant}`).toBe(true);
      await User.updateOne({ _id: moderator._id }, { $set: { 'permissions.dangerous': [grant] } });
      expect(forbidden(await api.post('/api/admin/orders/bulk', body)), `${body.action} with ${grant}`).toBe(false);
      await User.updateOne({ _id: moderator._id }, { $set: { 'permissions.dangerous': [] } });
    }
    // Plain bulk actions (assign / unassign) need no grant.
    expect(forbidden(await api.post('/api/admin/orders/bulk', { action: 'unassign', ids: [id] }))).toBe(false);
  });

  it('an expired temporary phone grant stops working at once (no cron)', async () => {
    const moderator = await createUser('moderator', {
      permissions: { sections: { warehouse: 'view' }, dangerous: [], fields: [{ key: 'customerPhone', until: new Date(Date.now() + 60_000) }] },
    });
    const api = await loginAs(moderator);
    expect(forbidden(await api.get(`/api/admin/labels/view?ids=${fakeId}`))).toBe(false);
    await User.updateOne({ _id: moderator._id }, { $set: { 'permissions.fields.0.until': new Date(Date.now() - 1000) } });
    expect(forbidden(await api.get(`/api/admin/labels/view?ids=${fakeId}`))).toBe(true);
  });

  it('couriers get 403 and anonymous requests get 401 on all admin routes', async () => {
    const courier = await createUser('courier');
    const courierApi = await loginAs(courier);
    const anon = await client();
    for (const r of staffRoutes) {
      expect((await send(courierApi, r, {})).status, `${r.method} ${r.path}`).toBe(403);
      expect((await send(anon, r, {})).status, `${r.method} ${r.path}`).toBe(401);
    }
  });

  it('the admin is never refused by the permission layer (GET routes)', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    for (const r of staffRoutes.filter((x) => x.method === 'GET')) {
      const res = await send(api, r);
      expect(res.body.error?.code, `${r.method} ${r.path}`).not.toBe('FORBIDDEN');
    }
  });

  it('a moderator who must change the password is stopped before any permission check', async () => {
    const moderator = await createUser('moderator', { mustChangePassword: true, permissions: allGrants });
    const api = await loginAs(moderator);
    const res = await api.get('/api/admin/orders');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('moderators cannot use courier routes', async () => {
    const moderator = await createUser('moderator', { permissions: allGrants });
    const api = await loginAs(moderator);
    expect((await api.get('/api/courier/orders')).status).toBe(403);
  });
});
