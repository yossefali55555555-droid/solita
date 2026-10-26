import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { User } from '../src/models/index.js';
import { createAssignedOrder, createOrder, createUser, getTestApp, loginAs } from './helpers.js';

describe('authorization', () => {
  it('requires authentication for admin and courier APIs', async () => {
    const app = getTestApp();
    expect((await request(app).get('/api/admin/orders')).status).toBe(401);
    expect((await request(app).get('/api/courier/orders')).status).toBe(401);
  });

  it('blocks couriers from every admin endpoint', async () => {
    const courier = await createUser('courier');
    const order = await createOrder();
    const api = await loginAs(courier);
    const attempts = [
      api.get('/api/admin/orders'),
      api.get('/api/admin/overview'),
      api.get('/api/admin/couriers'),
      api.patch(`/api/admin/orders/${order._id}/assignment`, { courierId: String(courier._id) }),
      api.get('/api/admin/delivery-reviews'),
      api.get('/api/admin/cash/overview'),
      api.post('/api/admin/sync/process-due'),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
  });

  it('prevents a courier from seeing or acting on another courier’s order', async () => {
    const admin = await createUser('admin');
    const mine = await createUser('courier');
    const other = await createUser('courier');
    const otherOrder = await createAssignedOrder(other, admin);
    const api = await loginAs(mine);

    expect((await api.get(`/api/courier/orders/${otherOrder._id}`)).status).toBe(404);
    expect((await api.patch(`/api/courier/orders/${otherOrder._id}/status`, { status: 'out_for_delivery' })).status).toBe(404);
    expect((await api.post(`/api/courier/orders/${otherOrder._id}/delivery-report`, {})).status).toBe(404);
    const list = await api.get('/api/courier/orders?scope=all');
    expect(list.body.items).toHaveLength(0);
  });

  it('blocks admins from courier endpoints (separate interfaces)', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    expect((await api.get('/api/courier/orders')).status).toBe(403);
  });

  it('rejects mass-assignment of role or status fields', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    const res = await api.post('/api/admin/couriers', {
      name: 'مندوب',
      phone: '01122334455',
      password: 'Password1234',
      role: 'admin',
    });
    expect(res.status).toBe(400);
    expect(await User.countDocuments({ phone: '01122334455' })).toBe(0);

    const created = await api.post('/api/admin/couriers', { name: 'مندوب', phone: '01122334455', password: 'Password1234' });
    expect(created.status).toBe(201);
    expect(created.body.courier.role).toBe('courier');
    const patch = await api.patch(`/api/admin/couriers/${created.body.courier.id}`, { role: 'admin' });
    expect(patch.status).toBe(400);
    expect((await User.findById(created.body.courier.id)).role).toBe('courier');
  });

  it('does not allow admin courier routes to modify an administrator account', async () => {
    const admin = await createUser('admin');
    const otherAdmin = await createUser('admin');
    const api = await loginAs(admin);
    expect((await api.patch(`/api/admin/couriers/${otherAdmin._id}/active`, { isActive: false })).status).toBe(404);
  });

  it('enforces unique normalized phone numbers and optional unique email', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    expect((await api.post('/api/admin/couriers', { name: 'أ', phone: '01011112222', password: 'Password1234' })).status).toBe(400);
    expect((await api.post('/api/admin/couriers', { name: 'أحمد', phone: '01011112222', password: 'Password1234' })).status).toBe(201);
    const dup = await api.post('/api/admin/couriers', { name: 'محمد', phone: '+201011112222', password: 'Password1234' });
    expect(dup.status).toBe(409);
    // Two couriers without email are fine (partial unique index).
    expect((await api.post('/api/admin/couriers', { name: 'محمود', phone: '01033334444', password: 'Password1234' })).status).toBe(201);
  });
});
