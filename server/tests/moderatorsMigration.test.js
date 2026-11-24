import { describe, expect, it } from 'vitest';
import { OrderEvent, Session, User } from '../src/models/index.js';
import { initDatabase } from '../src/db/initDatabase.js';
import { ensureSingleAdminIndex, migrateLegacyAccounts, ONE_ADMIN_INDEX } from '../src/db/migrations/moderatorsPhase1.js';
import { createUser } from './helpers.js';

// Separate file: this test drops the one-admin index to simulate an old database.
async function dropIndex() {
  if ((await User.collection.indexes()).some((i) => i.name === ONE_ADMIN_INDEX)) {
    await User.collection.dropIndex(ONE_ADMIN_INDEX);
  }
}
const raw = (doc) => User.collection.insertOne({ isActive: true, passwordHash: 'x', createdAt: new Date(), ...doc });

describe('moderators phase 1 migration', () => {
  it('does not build the index while several admins exist, then converts the extra admins and builds it', async () => {
    await dropIndex();
    const owner = await createUser('admin', { name: 'المالك', phone: '01101010101' });
    await raw({ name: 'أدمن تجريبي', phone: '01000000001', role: 'admin', isDemo: true });
    await raw({ name: 'حساب قديم', phone: '01000000009', role: 'manager' });
    const courier = await createUser('courier');
    const demo = await User.findOne({ phone: '01000000001' });
    await Session.create({ tokenHash: 'legacy-demo-session', user: demo._id, expiresAt: new Date(Date.now() + 3600_000) });
    expect(await Session.countDocuments({ user: demo._id })).toBe(1);

    // Checked index step refuses; initDatabase reports it instead of failing.
    expect(await ensureSingleAdminIndex()).toMatchObject({ status: 'skipped', admins: 2 });
    const report = await initDatabase();
    expect(report.find((r) => r.collection === 'users').singleAdmin.status).toBe('skipped');
    expect(report.find((r) => r.collection === 'users').indexes).not.toContain(ONE_ADMIN_INDEX);

    // Several admins and no choice → refuse.
    await expect(migrateLegacyAccounts({ apply: true })).rejects.toThrow(/--keep-admin/);
    await expect(migrateLegacyAccounts({ keepAdminPhone: '01222222222' })).rejects.toThrow();

    // Dry run changes nothing.
    const plan = await migrateLegacyAccounts({ keepAdminPhone: '+20 110 101 0101' });
    expect(plan.applied).toBe(false);
    expect(plan.keepAdmin.id).toBe(String(owner._id));
    expect(plan.convert.map((u) => u.fromRole).sort()).toEqual(['admin', 'manager']);
    expect(await User.countDocuments({ role: 'admin' })).toBe(2);

    const applied = await migrateLegacyAccounts({ keepAdminPhone: '01101010101', apply: true });
    expect(applied.applied).toBe(true);
    const converted = await User.find({ phone: { $in: ['01000000001', '01000000009'] } }).lean();
    for (const u of converted) {
      expect(u).toMatchObject({ role: 'moderator', status: 'disabled', isActive: false });
      expect(u.permissions).toEqual({ sections: {}, dangerous: [], fields: [] });
    }
    expect(await Session.countDocuments({ user: demo._id })).toBe(0);
    expect(await OrderEvent.countDocuments({ type: 'account_migrated_to_moderator' })).toBe(2);
    expect((await User.findById(owner._id)).role).toBe('admin');
    expect((await User.findById(courier._id)).role).toBe('courier');

    expect(await ensureSingleAdminIndex()).toMatchObject({ status: 'created' });
    // Idempotent.
    expect(await ensureSingleAdminIndex()).toMatchObject({ status: 'exists' });
    expect((await migrateLegacyAccounts({ apply: true })).convert).toEqual([]);
  });

  it('with a single admin the plan is empty and the index is built directly', async () => {
    await dropIndex();
    await createUser('admin');
    expect((await migrateLegacyAccounts({ apply: true })).convert).toEqual([]);
    expect(await ensureSingleAdminIndex()).toMatchObject({ status: 'created' });
  });
});
