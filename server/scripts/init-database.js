#!/usr/bin/env node
/**
 * npm run db:init
 *
 * Creates or verifies all collections and indexes in the `solita` database.
 * Safe to run any number of times: it never drops collections, documents or
 * indexes.
 */
import { ConfigError, getConfig } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { initDatabase } from '../src/db/initDatabase.js';

async function main() {
  const config = getConfig();
  if (config.mockMode) {
    console.error('db:init must run against a real MongoDB (MOCK_MODE is enabled).');
    process.exit(1);
  }
  console.log(`Connecting to MongoDB (database "${config.databaseName}")...`);
  await connectDb();
  const report = await initDatabase({ log: (line) => console.log(`  ✓ ${line}`) });
  const created = report.filter((r) => r.created).length;
  console.log(`\nDone. ${report.length} collections verified (${created} newly created). No data was removed.`);
}

main()
  .catch((err) => {
    if (err instanceof ConfigError) console.error(err.message);
    else console.error(`Database initialization failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb().catch(() => {}));
