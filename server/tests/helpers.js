import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetConfig } from '../src/config/env.js';
import { Order, User } from '../src/models/index.js';
import { hashPassword } from '../src/services/passwordService.js';
import { setFetchImplementation } from '../src/integrations/easyorders/client.js';
import { normalizeEasyOrdersOrder } from '../src/integrations/easyorders/normalize.js';
import { upsertOrderFromSource } from '../src/services/sourceOrderService.js';

export const PASSWORD = 'Password1234';
export const WEBHOOK_SECRET = 'test-webhook-secret';

let app;
export function getTestApp() {
  app ||= createApp();
  return app;
}

let phoneCounter = Math.floor(Math.random() * 9_000_000);
export async function createUser(role = 'courier', overrides = {}) {
  phoneCounter += 1;
  return User.create({
    name: overrides.name || `${role} ${phoneCounter}`,
    phone: overrides.phone || `010${String(phoneCounter).padStart(8, '0')}`,
    passwordHash: await hashPassword(overrides.password || PASSWORD),
    role,
    isActive: overrides.isActive ?? true,
    mustChangePassword: overrides.mustChangePassword ?? false,
    email: overrides.email,
  });
}

/** A supertest agent that keeps cookies and sends the CSRF header. */
export async function client() {
  const agent = request.agent(getTestApp());
  const res = await agent.get('/api/auth/csrf');
  let token = res.body.csrfToken;
  const withCsrf = (req) => req.set('x-csrf-token', token);
  const api = {
    agent,
    get: (url) => agent.get(url),
    post: (url, body) => withCsrf(agent.post(url)).send(body ?? {}),
    patch: (url, body) => withCsrf(agent.patch(url)).send(body ?? {}),
    setToken: (t) => {
      token = t;
    },
  };
  return api;
}

export async function loginAs(user, password = PASSWORD) {
  const api = await client();
  const res = await api.post('/api/auth/login', { identifier: user.phone, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  api.setToken(res.body.csrfToken);
  return api;
}

let orderCounter = 0;
export function orderPayload(overrides = {}) {
  orderCounter += 1;
  const id = overrides.id || `eo-${Date.now()}-${orderCounter}`;
  return {
    id,
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-01T10:00:00.000Z',
    store_id: 'store-1',
    cost: 1000,
    shipping_cost: 50,
    total_cost: 1050,
    status: 'confirmed',
    full_name: 'عميل اختبار',
    phone: '+20 111 222 3333',
    government: 'القاهرة',
    address: '10 شارع الاختبار',
    payment_method: 'cod',
    cart_items: [
      {
        id: 'ci-1',
        product_id: 'p-1',
        variant_id: 'v-1',
        price: 500,
        quantity: 2,
        product: { name: 'حذاء', price: 500, sku: 'SKU-1' },
        variant: { variation_props: [{ variation: 'size', variation_prop: '42' }] },
      },
    ],
    ...overrides,
  };
}

export async function createOrder(overrides = {}) {
  const { order } = await upsertOrderFromSource(normalizeEasyOrdersOrder(orderPayload(overrides)), { via: 'test' });
  return order;
}

export async function createAssignedOrder(courier, admin, overrides = {}, deliveryStatus = 'assigned') {
  const order = await createOrder(overrides);
  await Order.updateOne(
    { _id: order._id },
    { $set: { assignedTo: courier._id, assignedBy: admin._id, assignedAt: new Date(), deliveryStatus } },
  );
  return Order.findById(order._id);
}

export function enableEasyOrdersApi() {
  process.env.EASYORDERS_API_KEY = 'test-api-key';
  resetConfig();
}

/**
 * Install a fake EasyOrders HTTP layer. `handler(call)` returns
 * { status, body, headers } or throws to simulate network errors.
 * Returns the list of recorded calls.
 */
export function mockEasyOrders(handler) {
  const calls = [];
  setFetchImplementation(async (url, init = {}) => {
    const call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const result = await handler(call, calls.length);
    return new Response(result.body === undefined ? '' : JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json', ...(result.headers || {}) },
    });
  });
  return calls;
}

export function postWebhook(path, body, secret = WEBHOOK_SECRET) {
  const req = request(getTestApp()).post(`/api/webhooks/easyorders/${path}`);
  if (secret !== null) req.set('secret', secret);
  return req.send(body);
}
