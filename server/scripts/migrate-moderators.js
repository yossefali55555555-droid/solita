#!/usr/bin/env node
/**
 * Moderators phase 1 migration (run locally by the owner only).
 *
 *   npm run migrate:moderators                         dry run: prints the plan, changes nothing
 *   npm run migrate:moderators -- --apply              apply (only one admin exists)
 *   npm run migrate:moderators -- --keep-admin=01xxxxxxxxx --apply
 *                                                      several admins: keep this one,
 *                                                      every other admin becomes a disabled moderator
 *
 * Steps (see src/db/migrations/moderatorsPhase1.js):
 *  1. Every account that is not the kept admin and not a courier becomes a
 *     moderator with no permissions, status "disabled"; its sessions are deleted.
 *  2. Builds the partial unique index `one_admin_only` after checking that
 *     exactly one admin is left.
 * Idempotent: running it twice changes nothing the second time.
 */
import '../src/config/loadEnv.js';
import { getConfig } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { ensureSingleAdminIndex, migrateLegacyAccounts } from '../src/db/migrations/moderatorsPhase1.js';

const apply = process.argv.includes('--apply');
const keepArg = process.argv.find((a) => a.startsWith('--keep-admin='));
const keepAdminPhone = keepArg ? keepArg.slice('--keep-admin='.length) : undefined;

async function main() {
  if (getConfig().mockMode) throw new Error('migrate:moderators must run against a real MongoDB (MOCK_MODE is enabled).');
  await connectDb();

  const plan = await migrateLegacyAccounts({ keepAdminPhone, apply });
  console.log(`Administrator kept: ${plan.keepAdmin ? plan.keepAdmin.name : '(none found)'}`);
  if (plan.convert.length === 0) console.log('No legacy accounts to convert.');
  for (const u of plan.convert) console.log(` - ${u.name} (${u.fromRole}) → disabled moderator`);

  if (!apply) {
    console.log('\nDry run only. Nothing was changed. Re-run with --apply to apply.');
    return;
  }
  const index = await ensureSingleAdminIndex();
  console.log(`\nAccounts converted: ${plan.convert.length}. One-admin index: ${index.status}${index.reason ? ` (${index.reason})` : ''}.`);
  if (index.status === 'skipped') process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb().catch(() => {}));
