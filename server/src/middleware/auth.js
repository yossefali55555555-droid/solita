import { getConfig } from '../config/env.js';
import { resolveSession } from '../services/authService.js';
import { forbidden, unauthorized } from '../utils/errors.js';

export function sessionCookieName() {
  // The __Host- prefix forces Secure, Path=/ and no Domain attribute.
  return getConfig().cookieSecure ? '__Host-solita_session' : 'solita_session';
}

export function sessionCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    secure: getConfig().cookieSecure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  };
}

/** Attach req.user / req.session when a valid session cookie is present. */
export async function loadSession(req, _res, next) {
  const token = req.cookies?.[sessionCookieName()];
  req.user = null;
  req.sessionToken = null;
  if (token) {
    const resolved = await resolveSession(token);
    if (resolved) {
      req.user = resolved.user;
      req.sessionToken = token;
    }
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/** Role is always read from the database user, never from the request. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/**
 * Accounts flagged mustChangePassword (e.g. after an admin reset) may only
 * use the auth endpoints until they choose a new password.
 */
export function requirePasswordUpToDate(req, _res, next) {
  if (req.user?.mustChangePassword) {
    return next(forbidden('يجب تغيير كلمة المرور قبل المتابعة', 'PASSWORD_CHANGE_REQUIRED'));
  }
  next();
}
