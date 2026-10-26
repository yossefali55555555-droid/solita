import { getConfig } from '../config/env.js';
import { receiveWebhook } from '../services/webhookService.js';
import { processBackgroundWork } from '../jobs/processBackgroundWork.js';
import { safeEqual } from '../utils/sanitize.js';
import { logger } from '../utils/logger.js';

/**
 * Webhook authentication uses the documented `secret` header that EasyOrders
 * sends with every webhook request. No signature scheme is invented.
 */
function authenticate(req, kind) {
  const { webhookSecret, statusWebhookSecret } = getConfig().easyOrders;
  const expected = kind === 'status' ? [statusWebhookSecret, webhookSecret] : [webhookSecret, statusWebhookSecret];
  const configured = expected.filter(Boolean);
  if (!configured.length) return { ok: false, status: 503, code: 'WEBHOOK_NOT_CONFIGURED' };
  const provided = req.get('secret');
  if (!provided || !configured.some((s) => safeEqual(provided, s))) {
    return { ok: false, status: 401, code: 'INVALID_WEBHOOK_SECRET' };
  }
  return { ok: true };
}

function handler(kind) {
  return async (req, res) => {
    const auth = authenticate(req, kind);
    if (!auth.ok) {
      logger.warn('Rejected webhook', { kind, code: auth.code, ip: req.ip });
      return res.status(auth.status).json({ error: { code: auth.code, message: 'Unauthorized webhook' } });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: { code: 'INVALID_PAYLOAD', message: 'Expected a JSON object' } });
    }
    // Both endpoints accept both documented payload shapes, so a single
    // EasyOrders webhook URL also works; the payload decides the handler.
    const result = await receiveWebhook(req.body);
    res.status(result.httpStatus).json(result.body);
  };
}

export const ordersWebhook = handler('orders');
export const statusWebhook = handler('status');

/** Vercel Cron entry point (Authorization: Bearer <CRON_SECRET>). */
export async function cronProcess(req, res) {
  const secret = getConfig().cronSecret;
  if (!secret) return res.status(503).json({ error: { code: 'CRON_NOT_CONFIGURED', message: 'CRON_SECRET is not set' } });
  const header = req.get('authorization') || '';
  if (!safeEqual(header, `Bearer ${secret}`)) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
  }
  res.json(await processBackgroundWork({ timeBudgetMs: 22_000 }));
}
