import { publicUser } from '../models/index.js';
import { getConfig } from '../config/env.js';
import { sessionCookieName, sessionCookieOptions } from '../middleware/auth.js';
import { createCsrfToken, csrfCookieName, isValidCsrfToken, setCsrfCookie } from '../middleware/csrf.js';
import { changeOwnPassword, login, logout } from '../services/authService.js';
import { listNotifications, markAllRead } from '../services/notificationService.js';

function issueCsrf(req, res) {
  const existing = req.cookies?.[csrfCookieName()];
  const token = existing && isValidCsrfToken(existing) ? existing : createCsrfToken();
  setCsrfCookie(res, token);
  return token;
}

export function csrf(req, res) {
  res.json({ csrfToken: issueCsrf(req, res) });
}

export async function postLogin(req, res) {
  const { identifier, password } = req.valid.body;
  const { user, token, expiresAt } = await login({ identifier, password, userAgent: req.get('user-agent') });
  res.cookie(sessionCookieName(), token, sessionCookieOptions(expiresAt));
  // Rotate the CSRF token at login.
  const csrfToken = createCsrfToken();
  setCsrfCookie(res, csrfToken);
  res.json({ user: publicUser(user), csrfToken, mockMode: getConfig().mockMode });
}

export async function postLogout(req, res) {
  await logout(req.sessionToken);
  res.clearCookie(sessionCookieName(), { ...sessionCookieOptions(), expires: undefined });
  res.json({ ok: true });
}

export function getMe(req, res) {
  res.json({ user: publicUser(req.user), mockMode: getConfig().mockMode, csrfToken: issueCsrf(req, res) });
}

export async function postChangePassword(req, res) {
  await changeOwnPassword(req.user, req.valid.body);
  // All sessions were revoked; sign the user in again with the new password.
  const { user, token, expiresAt } = await login({
    identifier: req.user.phone,
    password: req.valid.body.newPassword,
    userAgent: req.get('user-agent'),
  });
  res.cookie(sessionCookieName(), token, sessionCookieOptions(expiresAt));
  res.json({ user: publicUser(user) });
}

export async function getNotifications(req, res) {
  res.json(await listNotifications(req.user._id));
}

export async function postNotificationsRead(req, res) {
  await markAllRead(req.user._id);
  res.json({ ok: true });
}
