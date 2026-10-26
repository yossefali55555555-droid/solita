import { describe, expect, it } from 'vitest';
import { initDatabase } from '../src/db/initDatabase.js';
import { Order, User } from '../src/models/index.js';
import { createOrder, createUser } from './helpers.js';

describe('database initialization', () => {
  it('is idempotent and never removes existing data', async () => {
    await createUser('admin');
    await createOrder({ id: 'keep-me' });
    const first = await initDatabase();
    const second = await initDatabase();
    expect(second.every((c) => c.created === false)).toBe(true);
    expect(second.map((c) => c.indexes.length)).toEqual(first.map((c) => c.indexes.length));
    expect(await Order.countDocuments({ easyOrdersId: 'keep-me' })).toBe(1);
    expect(await User.countDocuments({})).toBe(1);
  });

  it('creates the required unique indexes', async () => {
    const report = await initDatabase();
    const byName = Object.fromEntries(report.map((r) => [r.collection, r.indexes]));
    expect(byName.orders).toContain('easyOrdersId_1');
    expect(byName.users).toEqual(expect.arrayContaining(['phone_1', 'email_1']));
    expect(byName.deliveryreviews).toContain('one_pending_review_per_order');
    expect(byName.syncoperations).toContain('idempotencyKey_1');
    expect(byName.webhookevents).toContain('provider_1_dedupeKey_1');
  });

  it('allows many users without email (partial unique index) but not duplicate emails', async () => {
    await createUser('courier');
    await createUser('courier');
    await createUser('courier', { email: 'a@example.com' });
    await expect(createUser('courier', { email: 'a@example.com' })).rejects.toMatchObject({ code: 11000 });
  });
});
