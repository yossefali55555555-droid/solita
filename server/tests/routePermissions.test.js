import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { PERMISSION_META, ROUTER_SCOPE, adminOnly, staffRouter } from '../src/middleware/permissions.js';
import { DANGEROUS, FIELD_KEYS, SECTION_KEYS } from '../src/constants/permissions.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { createUser, getTestApp, loginAs, client } from './helpers.js';

/**
 * Walks every route registered in the real Express app. Any route that is
 * not in an exempt area must start with permission metadata, otherwise this
 * test fails (default deny is also enforced at runtime by staffRouter).
 */

// Areas that keep their own access rules (unchanged by the moderators work).
const EXEMPT_SCOPES = new Set(['auth', 'webhooks', 'courier', 'public', 'couponSync']);
// Single routes outside any router, with their own protection.
const EXEMPT_ROUTES = new Set(['app GET /api/health', 'api GET /cron/process']);

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

  it('maps all 85 existing admin routes, each admin-only in phase 1', () => {
    expect(staffRoutes).toHaveLength(85);
    expect(staffRoutes.every((r) => r.meta?.adminOnly === true && !r.meta.unmapped)).toBe(true);
    // Permission middleware is the only metadata-bearing handler and comes first.
    for (const r of staffRoutes) expect(r.handlers.filter((h) => h[PERMISSION_META])).toHaveLength(1);
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

describe('phase 1: no behaviour change, moderators refused everywhere', () => {
  const allGrants = {
    sections: Object.fromEntries(SECTION_KEYS.map((k) => [k, 'edit'])),
    dangerous: Object.keys(DANGEROUS),
    fields: FIELD_KEYS.map((key) => ({ key, until: null })),
  };

  it('a moderator holding every permission gets 403 on all 85 admin routes, whatever the request claims', async () => {
    const moderator = await createUser('moderator', { permissions: allGrants });
    const api = await loginAs(moderator);
    for (const r of staffRoutes) {
      const req = send(api, r, { role: 'admin', isAdmin: true, permissions: allGrants }).set('x-role', 'admin');
      const res = await req;
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(res.body.error?.code).toBe('FORBIDDEN');
    }
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
