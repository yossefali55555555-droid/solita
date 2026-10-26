import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { ConfigError, getConfig } from './config/env.js';
import { connectDb } from './db/connect.js';
import { loadSession } from './middleware/auth.js';
import { csrfProtection } from './middleware/csrf.js';
import { apiRateLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { buildRouter } from './routes/index.js';
import { logger } from './utils/logger.js';

/**
 * Build the Express application. Routes live under /api so the same app
 * works behind the Vercel rewrite (/api/* → api/index.js) and locally.
 */
export function createApp() {
  const config = getConfig();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Vercel / reverse proxy: needed for correct client IPs in rate limiting

  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );
  app.use(
    cors({
      origin(origin, cb) {
        // Same-origin and server-to-server requests have no Origin header.
        if (!origin) return cb(null, true);
        cb(null, config.clientOrigins.includes(origin.replace(/\/+$/, '')));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '256kb', strict: true }));
  app.use(cookieParser());

  // Health check does not touch the database.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, mockMode: config.mockMode, time: new Date().toISOString() });
  });

  // Ensure a (cached) database connection for every other API request.
  app.use('/api', async (_req, _res, next) => {
    await connectDb();
    next();
  });

  app.use('/api', apiRateLimiter());
  app.use('/api', loadSession);
  app.use('/api', csrfProtection({ exclude: ['/webhooks/', '/cron/'] }));
  app.use('/api', buildRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let cachedApp = null;

/**
 * Lazily created singleton for serverless use. If the configuration is
 * invalid, a minimal app answers every request with a clear 503 instead of
 * crashing the function (details go to the logs only).
 */
export function getApp() {
  if (cachedApp) return cachedApp;
  try {
    cachedApp = createApp();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    logger.error('Server configuration error', { problems: err.problems });
    const fallback = express();
    fallback.use((_req, res) =>
      res.status(503).json({
        error: { code: 'CONFIG_ERROR', message: 'إعدادات الخادم غير مكتملة. راجع متغيرات البيئة.' },
      }),
    );
    return fallback;
  }
  return cachedApp;
}
