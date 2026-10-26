import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Session, User } from '../src/models/index.js';
import { PASSWORD, client, createUser, getTestApp, loginAs } from './helpers.js';

describe('authentication', () => {
  it('logs in with a secure HttpOnly session cookie and never returns the password hash', async () => {
    const admin = await createUser('admin');
    const api = await client();
    const res = await api.post('/api/auth/login', { identifier: admin.phone, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('solita_session='));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await api.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(String(admin._id));
    expect(me.body.user.passwordHash).toBeUndefined();
  });

  it('accepts phone numbers in international or Arabic-digit form', async () => {
    const courier = await createUser('courier', { phone: '01012345678' });
    const api = await client();
    const res = await api.post('/api/auth/login', { identifier: '+20 101 234 5678', password: PASSWORD });
    expect(res.status).toBe(200);
    const api2 = await client();
    const res2 = await api2.post('/api/auth/login', { identifier: '٠١٠١٢٣٤٥٦٧٨', password: PASSWORD });
    expect(res2.status).toBe(200);
    expect(res2.body.user.id).toBe(String(courier._id));
  });

  it('rejects wrong passwords and unknown users with the same message', async () => {
    const courier = await createUser('courier');
    const api = await client();
    const wrong = await api.post('/api/auth/login', { identifier: courier.phone, password: 'nope-nope-1' });
    const unknown = await api.post('/api/auth/login', { identifier: '01099999999', password: 'nope-nope-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('rejects inactive users at login', async () => {
    const courier = await createUser('courier', { isActive: false });
    const api = await client();
    const res = await api.post('/api/auth/login', { identifier: courier.phone, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });

  it('invalidates existing sessions when an admin deactivates a courier', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const courierApi = await loginAs(courier);
    expect((await courierApi.get('/api/courier/orders')).status).toBe(200);

    const adminApi = await loginAs(admin);
    const res = await adminApi.patch(`/api/admin/couriers/${courier._id}/active`, { isActive: false });
    expect(res.status).toBe(200);
    expect(await Session.countDocuments({ user: courier._id })).toBe(0);
    expect((await courierApi.get('/api/courier/orders')).status).toBe(401);
  });

  it('requires a valid CSRF token for state-changing requests', async () => {
    const admin = await createUser('admin');
    const agent = request.agent(getTestApp());
    const noToken = await agent.post('/api/auth/login').send({ identifier: admin.phone, password: PASSWORD });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_INVALID');

    await agent.get('/api/auth/csrf');
    const forged = await agent
      .post('/api/auth/login')
      .set('x-csrf-token', 'forged.token')
      .send({ identifier: admin.phone, password: PASSWORD });
    expect(forged.status).toBe(403);
  });

  it('rejects requests from a foreign Origin', async () => {
    const admin = await createUser('admin');
    const api = await client();
    const res = await api
      .post('/api/auth/login', { identifier: admin.phone, password: PASSWORD })
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('logs out and the session stops working', async () => {
    const admin = await createUser('admin');
    const api = await loginAs(admin);
    expect((await api.post('/api/auth/logout')).status).toBe(200);
    expect((await api.get('/api/auth/me')).status).toBe(401);
  });

  it('rate-limits repeated failed logins', async () => {
    const courier = await createUser('courier');
    const api = await client();
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await api.post('/api/auth/login', { identifier: courier.phone, password: `bad-password-${i}` })).status);
    }
    expect(statuses).toContain(429);
  });

  it('forces a password change after an admin reset before courier APIs can be used', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const adminApi = await loginAs(admin);
    const reset = await adminApi.post(`/api/admin/couriers/${courier._id}/password`, { newPassword: 'TempPass12345' });
    expect(reset.status).toBe(200);

    const courierApi = await loginAs(courier, 'TempPass12345');
    const blocked = await courierApi.get('/api/courier/orders');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await courierApi.post('/api/auth/change-password', {
      currentPassword: 'TempPass12345',
      newPassword: 'MyOwnPass12345',
    });
    expect(changed.status).toBe(200);
    expect((await courierApi.get('/api/courier/orders')).status).toBe(200);
    const stored = await User.findById(courier._id).select('+passwordHash');
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
  });
});
