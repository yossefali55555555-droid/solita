import crypto from 'node:crypto';
import { getConfig } from '../config/env.js';
import { forbidden } from '../utils/errors.js';
import { safeEqual } from '../utils/sanitize.js';

/**
 * CSRF protection: signed double-submit cookie + Origin verification.
 *
 *  - The server issues a random token signed with SESSION_SECRET in a
 *    readable (non-HttpOnly) cookie.
 *  - The frontend echoes it in the X-CSRF-Token header on every unsafe request.
 *  - A cross-site attacker can neither read the cookie nor forge the signature.
 *  - When an Origin header is present it must be an allowed origin.
 *
 * Webhooks and cron endpoints are excluded: they are not cookie-authenticated
 * and use their own shared secrets.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-csrf-token';

export function csrfCookieName() {
  return getConfig().cookieSecure ? '__Host-solita_csrf' : 'solita_csrf';
}

function sign(nonce) {
  return crypto.createHmac('sha256', getConfig().sessionSecret).update(nonce).digest('base64url');
}

export function createCsrfToken() {
  const nonce = crypto.randomBytes(24).toString('base64url');
  return `${nonce}.${sign(nonce)}`;
}

export function isValidCsrfToken(token) {
  if (typeof token !== 'string' || token.length > 200) return false;
  const [nonce, signature] = token.split('.');
  if (!nonce || !signature) return false;
  return safeEqual(signature, sign(nonce));
}

export function setCsrfCookie(res, token) {
  res.cookie(csrfCookieName(), token, {
    httpOnly: false,
    secure: getConfig().cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

export function csrfProtection({ exclude = [] } = {}) {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (exclude.some((prefix) => req.path.startsWith(prefix))) return next();

    const origin = req.get('origin');
    if (origin && !isAllowedOrigin(req, origin)) {
      return next(forbidden('مصدر الطلب غير مسموح', 'BAD_ORIGIN'));
    }

    const cookieToken = req.cookies?.[csrfCookieName()];
    const headerToken = req.get(CSRF_HEADER);
    if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken) || !isValidCsrfToken(headerToken)) {
      return next(forbidden('انتهت صلاحية الجلسة الأمنية. حدّث الصفحة وحاول مرة أخرى.', 'CSRF_INVALID'));
    }
    next();
  };
}

function isAllowedOrigin(req, origin) {
  const normalized = origin.replace(/\/+$/, '');
  if (getConfig().clientOrigins.includes(normalized)) return true;
  // Same-origin requests (frontend and API served from the same Vercel domain).
  const host = req.get('x-forwarded-host') || req.get('host');
  return Boolean(host) && (normalized === `https://${host}` || normalized === `http://${host}`);
}
