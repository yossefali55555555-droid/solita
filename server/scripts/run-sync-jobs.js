#!/usr/bin/env node
/**
 * npm run sync:run
 * Process due EasyOrders sync operations and webhook retries once (same work
 * as the Vercel Cron endpoint). Useful for manual operations or an external
 * scheduler.
 */
import '../src/config/loadEnv.js';
import { getConfig } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { processBackgroundWork } from '../src/jobs/processBackgroundWork.js';

async function main() {
  if (getConfig().mockMode) throw new Error('sync:run must run against a real MongoDB.');
  await connectDb();
  const result = await processBackgroundWork({ timeBudgetMs: 60_000 });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb().catch(() => {}));
