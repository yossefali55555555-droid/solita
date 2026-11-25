import crypto from 'node:crypto';
import net from 'node:net';
import { z } from 'zod';

/**
 * Central, validated configuration.
 *
 * The configuration is parsed lazily (on first use) so tests and scripts can
 * prepare process.env before anything reads it. Call resetConfig() after
 * changing process.env in tests.
 */

export const DATABASE_NAME = 'solita';

/** The public EasyOrders storefront that may call /api/public/*. */
export const DEFAULT_STOREFRONT_ORIGIN = 'https://solita.myeasyorders.com';

const booleanString = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  VERCEL: optionalString,
  VERCEL_ENV: optionalString,
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: optionalString,
  MONGODB_DNS_SERVERS: optionalString,
  SESSION_SECRET: optionalString,
  CLIENT_ORIGIN: z.string().optional().default('http://localhost:5173'),
  STOREFRONT_ORIGINS: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v : DEFAULT_STOREFRONT_ORIGIN)),
  EASYORDERS_API_KEY: optionalString,
  // Shared secret for the coupon sync bookmarklet (/api/coupon-sync). Unset = sync disabled.
  COUPON_SYNC_SECRET: optionalString,
  COUPON_SYNC_ORIGINS: z.string().optional().default('https://app.easy-orders.net'),
  EASYORDERS_API_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : 'https://api.easy-orders.net'))
    .pipe(z.url({ protocol: /^https?$/ })),
  EASYORDERS_WEBHOOK_SECRET: optionalString,
  EASYORDERS_STATUS_WEBHOOK_SECRET: optionalString,
  CRON_SECRET: optionalString,
  MOCK_MODE: booleanString,
  // Admin 2FA (moderators phase 3). 32 random bytes as base64/base64url/hex,
  // made with `npm run mfa:keygen` and pasted into Vercel by the owner.
  MFA_ENCRYPTION_KEY: optionalString,
  MFA_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(999).optional().default(1),
  // Alert emails via Gmail SMTP with an app password (owner sets both in Vercel).
  GMAIL_SMTP_USER: optionalString,
  GMAIL_SMTP_APP_PASSWORD: optionalString,
});

/** 32-byte key from base64 / base64url / hex, or null when it is not one. */
export function parseEncryptionKey(value) {
  if (!value) return null;
  const v = value.trim();
  const candidates = /^[0-9a-fA-F]{64}$/.test(v) ? [Buffer.from(v, 'hex')] : [Buffer.from(v, 'base64'), Buffer.from(v, 'base64url')];
  return candidates.find((b) => b.length === 32) || null;
}

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid server configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

let cached = null;
let ephemeralSecret = null;

export function loadConfig(env = process.env, { forceMock } = {}) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const problems = [];

  const onVercel = Boolean(e.VERCEL) || Boolean(e.VERCEL_ENV);
  const isProduction = e.NODE_ENV === 'production' || onVercel;
  const isTest = e.NODE_ENV === 'test' && !onVercel;
  const mockMode = Boolean(forceMock || e.MOCK_MODE);

  if (mockMode && isProduction) {
    problems.push(
      'MOCK_MODE cannot be enabled in production or on Vercel. Remove MOCK_MODE or set it to false.',
    );
  }

  if (!e.MONGODB_URI && !mockMode && !isTest) {
    problems.push(
      'MONGODB_URI is required. Add your MongoDB Atlas connection string, or run `npm run dev:mock` for local demo mode.',
    );
  }
  if (e.MONGODB_URI && !/^mongodb(\+srv)?:\/\//.test(e.MONGODB_URI)) {
    problems.push('MONGODB_URI must start with mongodb:// or mongodb+srv://');
  }
  const mongodbDnsServers = e.MONGODB_DNS_SERVERS
    ? e.MONGODB_DNS_SERVERS.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  if (mongodbDnsServers.some((ip) => net.isIP(ip) === 0)) {
    problems.push('MONGODB_DNS_SERVERS must be a comma-separated list of IP addresses, e.g. 8.8.8.8,1.1.1.1');
  }

  let sessionSecret = e.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    if (isProduction) {
      problems.push('SESSION_SECRET is required in production and must be at least 32 characters.');
    } else {
      // Development/test only: an ephemeral per-process secret (sessions/CSRF
      // tokens become invalid when the process restarts).
      ephemeralSecret ||= crypto.randomBytes(48).toString('base64url');
      sessionSecret = ephemeralSecret;
    }
  }

  const clientOrigins = e.CLIENT_ORIGIN.split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  for (const origin of clientOrigins) {
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
      problems.push(`CLIENT_ORIGIN contains an invalid origin: "${origin}"`);
    }
  }

  const storefrontOrigins = e.STOREFRONT_ORIGINS.split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  for (const origin of storefrontOrigins) {
    if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
      problems.push(`STOREFRONT_ORIGINS contains an invalid origin: "${origin}"`);
    }
  }

  // A bad 2FA key never stops the site (the admin can still sign in with a
  // recovery code); 2FA setup simply reports it.
  const mfaKey = parseEncryptionKey(e.MFA_ENCRYPTION_KEY);
  const mfaKeyProblem = e.MFA_ENCRYPTION_KEY && !mfaKey ? 'MFA_ENCRYPTION_KEY must be 32 bytes (base64 or hex)' : null;

  if (problems.length) throw new ConfigError(problems);

  return Object.freeze({
    nodeEnv: e.NODE_ENV,
    isProduction,
    isTest,
    onVercel,
    port: e.PORT,
    mongodbUri: e.MONGODB_URI,
    mongodbDnsServers,
    databaseName: DATABASE_NAME,
    sessionSecret,
    sessionSecretIsEphemeral: sessionSecret === ephemeralSecret,
    clientOrigins,
    storefrontOrigins,
    couponSync: Object.freeze({
      secret: e.COUPON_SYNC_SECRET,
      origins: e.COUPON_SYNC_ORIGINS.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean),
    }),
    mockMode,
    cookieSecure: isProduction,
    cronSecret: e.CRON_SECRET,
    mfa: Object.freeze({ key: mfaKey, keyVersion: e.MFA_ENCRYPTION_KEY_VERSION, keyProblem: mfaKeyProblem }),
    mail: Object.freeze({
      user: e.GMAIL_SMTP_USER,
      pass: e.GMAIL_SMTP_APP_PASSWORD ? e.GMAIL_SMTP_APP_PASSWORD.replace(/\s+/g, '') : undefined,
      configured: Boolean(e.GMAIL_SMTP_USER && e.GMAIL_SMTP_APP_PASSWORD),
    }),
    easyOrders: Object.freeze({
      apiKey: e.EASYORDERS_API_KEY,
      baseUrl: e.EASYORDERS_API_BASE_URL.replace(/\/+$/, ''),
      webhookSecret: e.EASYORDERS_WEBHOOK_SECRET,
      statusWebhookSecret: e.EASYORDERS_STATUS_WEBHOOK_SECRET || e.EASYORDERS_WEBHOOK_SECRET,
      apiConfigured: Boolean(e.EASYORDERS_API_KEY),
      webhooksConfigured: Boolean(e.EASYORDERS_WEBHOOK_SECRET),
      timeoutMs: 10_000,
      // Documented limit is 40 requests/minute; keep a safety margin.
      maxRequestsPerMinute: 35,
    }),
  });
}

export function getConfig() {
  if (!cached) cached = loadConfig(process.env, { forceMock: process.argv.includes('--mock') });
  return cached;
}

export function resetConfig() {
  cached = null;
}
