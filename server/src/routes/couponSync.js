import express, { Router } from 'express';
import cors from 'cors';
import { getConfig } from '../config/env.js';
import { connectDb } from '../db/connect.js';
import { notFoundHandler } from '../middleware/errorHandler.js';
import { publicConfigRateLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import { serviceUnavailable, unauthorized } from '../utils/errors.js';
import { safeEqual } from '../utils/sanitize.js';
import { importCouponsBody } from '../validators/storefront.js';
import * as couponCtl from '../controllers/couponController.js';

/**
 * Coupon sync (/api/coupon-sync/*): EasyOrders has no public coupon API, so a
 * bookmarklet run inside the EasyOrders dashboard (with the owner's own login)
 * sends the full coupon list here and applies the edits made in this dashboard.
 *  - Needs the shared secret COUPON_SYNC_SECRET in the X-Sync-Secret header.
 *  - CORS only for COUPON_SYNC_ORIGINS (default https://app.easy-orders.net).
 *  - No cookies, no CSRF. Disabled while the secret is not set.
 */
export function buildCouponSyncRouter() {
  const r = Router();
  r.use(
    cors({
      origin(origin, cb) {
        cb(null, Boolean(origin) && getConfig().couponSync.origins.includes(String(origin).replace(/\/+$/, '')));
      },
      credentials: false,
      methods: ['POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Sync-Secret'],
      maxAge: 600,
    }),
  );
  r.use(express.json({ limit: '2mb', strict: true }));
  r.use(async (_req, _res, next) => {
    await connectDb();
    next();
  });
  r.post(
    '/exchange',
    publicConfigRateLimiter({ limit: 20 }),
    (req, _res, next) => {
      const { secret } = getConfig().couponSync;
      if (!secret) return next(serviceUnavailable('مزامنة الكوبونات غير مفعّلة', 'SYNC_DISABLED'));
      if (!safeEqual(String(req.get('x-sync-secret') || ''), secret)) return next(unauthorized('غير مصرح', 'BAD_SYNC_SECRET'));
      next();
    },
    validate({ body: importCouponsBody }),
    couponCtl.syncExchange,
  );
  r.use(notFoundHandler);
  return r;
}
