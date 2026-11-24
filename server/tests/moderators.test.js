import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { Session, User } from '../src/models/index.js';
import { setAccountStatus } from '../src/services/authService.js';
import { requirePermission } from '../src/middleware/permissions.js';
import { effectivePermissions } from '../src/services/permissionService.js';
import { permissionsInput, staffRoleInput } from '../src/validators/permissions.js';
import { ONE_ADMIN_INDEX } from '../src/db/migrations/moderatorsPhase1.js';
import { client, createUser, loginAs, PASSWORD } from './helpers.js';

const HOUR = 60 * 60 * 1000;

describe('moderator accounts: sessions and status', () => {
  it('moderator sessions last 12 hours (couriers keep 7 days)', async () => {
    const moderator = await createUser('moderator');
    const courier = await createUser('courier');
    const before = Date.now();
    await loginAs(moderator);
    await loginAs(courier);
    const modSession = await Session.findOne({ user: moderator._id }).lean();
    const courierSession = await Session.findOne({ user: courier._id }).lean();
    const modTtl = modSession.expiresAt.getTime() - before;
    expect(modTtl).toBeGreaterThan(12 * HOUR - 60_000);
    expect(modTtl).toBeLessThanOrEqual(12 * HOUR + 60_000);
    expect(courierSession.expiresAt.getTime() - before).toBeGreaterThan(6 * 24 * HOUR);
  });

  it('allows several devices at once', async () => {
    const moderator = await createUser('moderator');
    const a = await loginAs(moderator);
    const b = await loginAs(moderator);
    expect((await a.get('/api/auth/me')).status).toBe(200);
    expect((await b.get('/api/auth/me')).status).toBe(200);
    expect(await Session.countDocuments({ user: moderator._id })).toBe(2);
  });

  it('disabling a moderator deletes every session immediately', async () => {
    const admin = await createUser('admin');
    const moderator = await createUser('moderator');
    const phone = await loginAs(moderator);
    const laptop = await loginAs(moderator);
    expect(await Session.countDocuments({ user: moderator._id })).toBe(2);

    await setAccountStatus(admin, moderator._id, 'disabled');
    expect(await Session.countDocuments({ user: moderator._id })).toBe(0);
    expect((await phone.get('/api/auth/me')).status).toBe(401);
    expect((await laptop.get('/api/auth/me')).status).toBe(401);

    const again = await (await client()).post('/api/auth/login', { identifier: moderator.phone, password: PASSWORD });
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('ACCOUNT_INACTIVE');

    await setAccountStatus(admin, moderator._id, 'active');
    expect((await loginAs(moderator).then((api) => api.get('/api/auth/me'))).status).toBe(200);
  });

  it('a session survives in the DB but is refused once the account is not active', async () => {
    const moderator = await createUser('moderator');
    const api = await loginAs(moderator);
    // Even a direct write (no service call) is enforced on the next request.
    await User.updateOne({ _id: moderator._id }, { $set: { status: 'disabled' } });
    expect((await api.get('/api/auth/me')).status).toBe(401);
  });

  it('invited accounts cannot sign in with a password', async () => {
    const moderator = await createUser('moderator', { status: 'invited' });
    const res = await (await client()).post('/api/auth/login', { identifier: moderator.phone, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INVITED');
  });

  it('the administrator can never be disabled through the service', async () => {
    const admin = await createUser('admin');
    await expect(setAccountStatus(admin, admin._id, 'disabled')).rejects.toMatchObject({ code: 'ADMIN_PROTECTED' });
    const courier = await createUser('courier');
    await expect(setAccountStatus(admin, courier._id, 'disabled')).rejects.toMatchObject({ status: 404 });
    await expect(setAccountStatus(admin, courier._id, 'gone')).rejects.toMatchObject({ status: 400 });
  });
});

describe('/auth/me returns effective permissions', () => {
  it('moderator: sections, dangerous only with edit on its section, expired temporary grants dropped', async () => {
    const moderator = await createUser('moderator', {
      permissions: {
        sections: { orders: 'edit', customers: 'view' },
        dangerous: ['changeOrderStatus', 'resetCash'], // resetCash has no cash.edit → not effective
        fields: [
          { key: 'customerPhone', until: new Date(Date.now() + HOUR) },
          { key: 'export', until: new Date(Date.now() - 1000) }, // expired
        ],
      },
    });
    const api = await loginAs(moderator);
    const { body } = await api.get('/api/auth/me');
    expect(body.user.role).toBe('moderator');
    expect(body.user.permissions.isAdmin).toBe(false);
    expect(body.user.permissions.sections).toEqual({ orders: 'edit', customers: 'view' });
    expect(body.user.permissions.dangerous).toEqual(['changeOrderStatus']);
    expect(body.user.permissions.fields.map((f) => f.key)).toEqual(['customerPhone']);
    expect(body.user.permissions.fields[0].until).toEqual(expect.any(String));
  });

  it('admin: everything; courier: null; login response carries the same data', async () => {
    const admin = await createUser('admin');
    const courier = await createUser('courier');
    const adminMe = (await (await loginAs(admin)).get('/api/auth/me')).body.user.permissions;
    expect(adminMe.isAdmin).toBe(true);
    expect(Object.values(adminMe.sections).every((l) => l === 'edit')).toBe(true);
    expect((await (await loginAs(courier)).get('/api/auth/me')).body.user.permissions).toBeNull();
    const login = await (await client()).post('/api/auth/login', { identifier: admin.phone, password: PASSWORD });
    expect(login.body.user.permissions.isAdmin).toBe(true);
  });

  it('a temporary grant stops counting the moment it expires (no cron)', () => {
    const now = new Date();
    const user = {
      role: 'moderator',
      permissions: { sections: {}, dangerous: [], fields: [{ key: 'customerPhone', until: new Date(now.getTime() + 1000) }] },
    };
    expect(effectivePermissions(user, now).fields).toHaveLength(1);
    expect(effectivePermissions(user, new Date(now.getTime() + 1001)).fields).toHaveLength(0);
  });
});

describe('one administrator only', () => {
  it('the partial unique index exists', async () => {
    const indexes = await User.collection.indexes();
    const idx = indexes.find((i) => i.name === ONE_ADMIN_INDEX);
    expect(idx).toMatchObject({ unique: true, key: { role: 1 }, partialFilterExpression: { role: 'admin' } });
  });

  it('refuses a second admin at the model level (create, save, updateOne, findOneAndUpdate, upsert, updateMany)', async () => {
    await createUser('admin');
    await expect(createUser('admin')).rejects.toMatchObject({ code: 'SECOND_ADMIN_FORBIDDEN' });

    const moderator = await createUser('moderator');
    moderator.role = 'admin';
    await expect(moderator.save()).rejects.toMatchObject({ code: 'SECOND_ADMIN_FORBIDDEN' });

    await expect(User.updateOne({ _id: moderator._id }, { $set: { role: 'admin' } })).rejects.toMatchObject({ code: 'SECOND_ADMIN_FORBIDDEN' });
    await expect(User.updateOne({ _id: moderator._id }, { role: 'admin' })).rejects.toMatchObject({ code: 'SECOND_ADMIN_FORBIDDEN' });
    await expect(User.findOneAndUpdate({ _id: moderator._id }, { $set: { role: 'admin' } })).rejects.toMatchObject({ code: 'SECOND_ADMIN_FORBIDDEN' });
    await expect(
      User.findOneAndUpdate(
        { phone: '01099990000' },
        { $setOnInsert: { name: 'x', phone: '01099990000', passwordHash: 'x', role: 'admin' } },
        { upsert: true },
      ),
    ).rejects.toMatchObject({ code: 'SECOND_ADMIN_FORBIDDEN' });
    await expect(User.updateMany({}, { $set: { role: 'admin' } })).rejects.toMatchObject({ code: 'SECOND_ADMIN_FORBIDDEN' });

    expect(await User.countDocuments({ role: 'admin' })).toBe(1);
    expect((await User.findById(moderator._id)).role).toBe('moderator');
  });

  it('the database refuses a second admin even when the model is bypassed', async () => {
    await createUser('admin');
    await expect(
      User.collection.insertOne({ name: 'raw', phone: '01088887777', passwordHash: 'x', role: 'admin', isActive: true }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('the account validators never accept the admin role or unknown permission keys', () => {
    expect(staffRoleInput.safeParse('admin').success).toBe(false);
    expect(staffRoleInput.safeParse('courier').success).toBe(false);
    expect(staffRoleInput.safeParse('moderator').success).toBe(true);

    expect(permissionsInput.safeParse({ sections: { orders: 'edit' } }).success).toBe(true);
    expect(permissionsInput.safeParse({ sections: { accounts: 'edit' } }).success).toBe(false);
    expect(permissionsInput.safeParse({ sections: { orders: 'owner' } }).success).toBe(false);
    expect(permissionsInput.safeParse({ dangerous: ['dropDatabase'] }).success).toBe(false);
    expect(permissionsInput.safeParse({ fields: [{ key: 'partners' }] }).success).toBe(false);
    expect(permissionsInput.safeParse({ fields: [{ key: 'customerPhone' }, { key: 'customerPhone' }] }).success).toBe(false);
    expect(permissionsInput.safeParse({ role: 'admin' }).success).toBe(false);
    expect(permissionsInput.parse({ sections: { orders: 'none', cash: 'view' } }).sections).toEqual({ cash: 'view' });
  });

  it('the model rejects unknown permission keys', async () => {
    await expect(createUser('moderator', { permissions: { sections: { accounts: 'edit' } } })).rejects.toThrow();
    await expect(createUser('moderator', { permissions: { dangerous: ['dropDatabase'] } })).rejects.toThrow();
    await expect(createUser('moderator', { permissions: { fields: [{ key: 'partners' }] } })).rejects.toThrow();
    await expect(createUser('moderator', { status: 'superuser' })).rejects.toThrow();
  });
});

describe('requirePermission (used from phase 2)', () => {
  const run = (mw, user) =>
    new Promise((resolve) => {
      mw({ user }, {}, (err) => resolve(err || null));
    });
  const mod = (permissions) => ({ _id: new mongoose.Types.ObjectId(), role: 'moderator', permissions });

  it('section levels: edit includes view, missing = none', async () => {
    const viewer = mod({ sections: { orders: 'view' }, dangerous: [], fields: [] });
    expect(await run(requirePermission('orders', 'view'), viewer)).toBeNull();
    expect((await run(requirePermission('orders', 'edit'), viewer)).status).toBe(403);
    expect((await run(requirePermission('cash', 'view'), viewer)).status).toBe(403);
    const editor = mod({ sections: { orders: 'edit' }, dangerous: [], fields: [] });
    expect(await run(requirePermission('orders', 'view'), editor)).toBeNull();
  });

  it('any-of sections and extra required sections', async () => {
    const couriersOnly = mod({ sections: { couriers: 'view' }, dangerous: [], fields: [] });
    expect(await run(requirePermission(['orders', 'couriers'], 'view'), couriersOnly)).toBeNull();
    const couponsEditor = mod({ sections: { coupons: 'edit' }, dangerous: [], fields: [{ key: 'customerPhone', until: null }] });
    const mw = requirePermission('coupons', 'edit', { fields: ['customerPhone'], also: { orders: 'view' } });
    expect((await run(mw, couponsEditor)).status).toBe(403);
    couponsEditor.permissions.sections.orders = 'view';
    expect(await run(mw, couponsEditor)).toBeNull();
  });

  it('dangerous actions need the grant and edit on their section', async () => {
    const mw = requirePermission('orders', 'edit', { dangerous: 'changeOrderStatus' });
    expect((await run(mw, mod({ sections: { orders: 'edit' }, dangerous: [], fields: [] }))).status).toBe(403);
    expect((await run(mw, mod({ sections: { orders: 'view' }, dangerous: ['changeOrderStatus'], fields: [] }))).status).toBe(403);
    expect(await run(mw, mod({ sections: { orders: 'edit' }, dangerous: ['changeOrderStatus'], fields: [] }))).toBeNull();
  });

  it('field grants honour temporary expiry', async () => {
    const mw = requirePermission('warehouse', 'view', { fields: ['customerPhone'] });
    const expired = mod({ sections: { warehouse: 'view' }, dangerous: [], fields: [{ key: 'customerPhone', until: new Date(Date.now() - 1) }] });
    const valid = mod({ sections: { warehouse: 'view' }, dangerous: [], fields: [{ key: 'customerPhone', until: new Date(Date.now() + HOUR) }] });
    expect((await run(mw, expired)).status).toBe(403);
    expect(await run(mw, valid)).toBeNull();
  });

  it('admin always passes; courier, unknown roles and anonymous are refused; no permissions = nothing', async () => {
    const mw = requirePermission('orders', 'view');
    expect(await run(mw, { role: 'admin' })).toBeNull();
    expect((await run(mw, { role: 'courier', permissions: { sections: { orders: 'edit' } } })).status).toBe(403);
    expect((await run(mw, { role: 'owner' })).status).toBe(403);
    expect((await run(mw, null)).status).toBe(401);
    expect((await run(mw, { role: 'moderator' })).status).toBe(403);
  });
});
