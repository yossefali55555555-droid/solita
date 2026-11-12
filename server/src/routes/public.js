import express, { Router } from 'express';
import cors from 'cors';
import { getConfig } from '../config/env.js';
import { connectDb } from '../db/connect.js';
import { notFoundHandler } from '../middleware/errorHandler.js';
import { publicConfigRateLimiter, publicEventsRateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { badRequest, forbidden } from '../utils/errors.js';
import { eventsEnvelopeSchema, PUBLIC_BODY_LIMIT } from '../validators/storefront.js';
import * as pub from '../controllers/publicController.js';

const normalizeOrigin = (o) => String(o || '').replace(/\/+$/, '');

/**
 * Public storefront API (/api/public/*): no login, no cookies, no CSRF.
 *  - CORS only for STOREFRONT_ORIGINS (default https://solita.myeasyorders.com).
 *  - POST requests must carry an allowed Origin header.
 *  - Bodies are limited to 32 KB; JSON or text/plain JSON (navigator.sendBeacon).
 *  - Per-IP rate limits backed by MongoDB.
 * Mounted before the dashboard middleware, so the dashboard's CORS, session
 * and CSRF rules are unchanged.
 */
export function buildPublicRouter() {
  const config = getConfig();
  const isStorefront = (origin) => config.storefrontOrigins.includes(normalizeOrigin(origin));
  const r = Router();

  r.use((_req, res, next) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });
  r.use(
    cors({
      origin(origin, cb) {
        cb(null, Boolean(origin) && isStorefront(origin));
      },
      credentials: false,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
      maxAge: 600,
    }),
  );
  r.use(express.json({ limit: PUBLIC_BODY_LIMIT, strict: true }));
  r.use(express.text({ type: 'text/plain', limit: PUBLIC_BODY_LIMIT }));
  r.use((req, _res, next) => {
    if (typeof req.body !== 'string') return next();
    try {
      req.body = JSON.parse(req.body);
      next();
    } catch {
      next(badRequest('صيغة البيانات غير صحيحة', 'INVALID_JSON'));
    }
  });
  r.use(async (_req, _res, next) => {
    await connectDb();
    next();
  });

  const requireStorefrontOrigin = (req, _res, next) => {
    if (isStorefront(req.get('origin'))) return next();
    next(forbidden('مصدر الطلب غير مسموح', 'BAD_ORIGIN'));
  };

  r.get('/site-config', publicConfigRateLimiter(), pub.getSiteConfig);
  r.post(
    '/events',
    requireStorefrontOrigin,
    publicEventsRateLimiter(),
    validate({ body: eventsEnvelopeSchema }),
    pub.postEvents,
  );
  r.use(notFoundHandler);
  return r;
}
