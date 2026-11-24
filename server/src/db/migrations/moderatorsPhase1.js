import { Session, User } from '../../models/index.js';
import { recordEvent, SYSTEM_ACTOR } from '../../services/auditService.js';
import { normalizePhone } from '../../utils/phone.js';

/**
 * Moderators phase 1 migration.
 *
 * 1. Legacy accounts: every account that is neither the kept admin nor a
 *    courier becomes a moderator with no permissions, status "disabled",
 *    and its sessions are deleted (owner decides later whether to delete it).
 * 2. The partial unique index `one_admin_only` ({role:1} where role="admin")
 *    is built only after checking that at most one admin exists. It is
 *    never declared on the schema, so autoIndex/createIndexes cannot build
 *    it over a database that still has several admins.
 *
 * Both steps are idempotent.
 */

export const ONE_ADMIN_INDEX = 'one_admin_only';

/** Build the one-admin index if (and only if) the data allows it. */
export async function ensureSingleAdminIndex() {
  const collection = User.collection;
  const existing = (await collection.indexes()).find((i) => i.name === ONE_ADMIN_INDEX);
  if (existing) return { status: 'exists', index: ONE_ADMIN_INDEX };
  const admins = await collection.countDocuments({ role: 'admin' });
  if (admins > 1) {
    return {
      status: 'skipped',
      reason: `found ${admins} admin accounts; run "npm run migrate:moderators -- --keep-admin=<phone> --apply" first`,
      admins,
    };
  }
  await collection.createIndex(
    { role: 1 },
    { name: ONE_ADMIN_INDEX, unique: true, partialFilterExpression: { role: 'admin' } },
  );
  return { status: 'created', index: ONE_ADMIN_INDEX };
}

/**
 * Plan (and optionally apply) the legacy-account migration.
 * keepAdminPhone is required when more than one admin exists.
 */
export async function migrateLegacyAccounts({ keepAdminPhone, apply = false } = {}) {
  const raw = User.collection;
  const admins = await raw.find({ role: 'admin' }, { projection: { name: 1, phone: 1 } }).toArray();
  let keep = null;
  if (keepAdminPhone) {
    const phone = normalizePhone(keepAdminPhone);
    keep = admins.find((a) => a.phone === phone) || null;
    if (!keep) throw new Error('--keep-admin does not match any administrator account.');
  } else if (admins.length === 1) {
    keep = admins[0];
  } else if (admins.length > 1) {
    throw new Error(`Found ${admins.length} administrator accounts. Choose the one to keep with --keep-admin=<phone>.`);
  }

  // Everything that is not the kept admin, not a courier and not already a moderator.
  const filter = { role: { $nin: ['courier', 'moderator'] } };
  if (keep) filter._id = { $ne: keep._id };
  const toConvert = await raw.find(filter, { projection: { name: 1, phone: 1, role: 1 } }).toArray();

  const plan = {
    keepAdmin: keep ? { id: String(keep._id), name: keep.name } : null,
    convert: toConvert.map((u) => ({ id: String(u._id), name: u.name, fromRole: u.role })),
    applied: false,
  };
  if (!apply || toConvert.length === 0) return { ...plan, applied: apply };

  const ids = toConvert.map((u) => u._id);
  // Native driver on purpose: demotion is always allowed and must not run
  // through document validation of legacy (possibly incomplete) records.
  await raw.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        role: 'moderator',
        status: 'disabled',
        isActive: false,
        permissions: { sections: {}, dangerous: [], fields: [] },
        updatedAt: new Date(),
      },
    },
  );
  await Session.deleteMany({ user: { $in: ids } });
  for (const u of toConvert) {
    await recordEvent({
      subjectUser: u._id,
      type: 'account_migrated_to_moderator',
      actor: SYSTEM_ACTOR,
      previous: { role: u.role },
      next: { role: 'moderator', status: 'disabled' },
    });
  }
  return { ...plan, applied: true };
}
