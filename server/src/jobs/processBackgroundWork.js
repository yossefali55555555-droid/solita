import { processDueOperations } from '../services/syncService.js';
import { processPendingWebhooks } from '../services/webhookService.js';
import { pollEasyOrders } from '../services/pollService.js';

/**
 * Serverless-compatible background processing. Invoked by:
 *  - Vercel Cron  → GET /api/cron/process (protected by CRON_SECRET)
 *  - Admin button → POST /api/admin/sync/process-due
 *  - External cron (e.g. every 3 minutes) → GET /api/cron/process
 *  - CLI          → npm run sync:run
 * All state lives in MongoDB, so any invocation can pick up where another
 * left off; leases prevent double processing.
 */
export async function processBackgroundWork({ timeBudgetMs = 20_000 } = {}) {
  const started = Date.now();
  // Pull new orders first: it is the fallback when webhooks do not arrive.
  const poll = await pollEasyOrders();
  const webhooks = await processPendingWebhooks({ timeBudgetMs: Math.floor(timeBudgetMs / 3) });
  const remaining = Math.max(1000, timeBudgetMs - (Date.now() - started));
  const operations = await processDueOperations({ timeBudgetMs: remaining });
  return { poll, webhooks, operations, durationMs: Date.now() - started };
}
