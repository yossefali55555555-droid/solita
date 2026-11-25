import { publicUser } from '../models/index.js';
import { getConfig } from '../config/env.js';
import { preAuthCookieName, sessionCookieName, sessionCookieOptions } from '../middleware/auth.js';
import { createCsrfToken, csrfCookieName, isValidCsrfToken, setCsrfCookie } from '../middleware/csrf.js';
import { changeOwnPassword, completeMfaLogin, login, logout, reissueSession } from '../services/authService.js';
import * as mfa from '../services/mfaService.js';
import { listAlerts, markAlertsRead, unreadAlertCount } from '../services/alertService.js';
import { listNotifications, markAllRead } from '../services/notificationService.js';
import { effectivePermissions } from '../services/permissionService.js';

/** The signed-in user + effective permissions (null for couriers). */
function sessionUser(user) {
  return { ...publicUser(user), templateName: user.templateName || null, permissions: effectivePermissions(user) };
}

/** Admin only: a short security summary for the banner and the menu badge. */
async function withSecurity(user) {
  const base = sessionUser(user);
  if (user.role !== 'admin') return base;
  const [sec, unreadAlerts] = await Promise.all([mfa.getSecurity(user._id), unreadAlertCount()]);
  return { ...base, security: { mfaEnabled: mfa.isMfaEnabled(sec), emailLinked: Boolean(sec?.emailVerifiedAt), unreadAlerts } };
}

function setSession(res, token, expiresAt) {
  res.cookie(sessionCookieName(), token, sessionCookieOptions(expiresAt));
  res.clearCookie(preAuthCookieName(), { ...sessionCookieOptions(), expires: undefined });
  // Rotate the CSRF token at sign-in.
  const csrfToken = createCsrfToken();
  setCsrfCookie(res, csrfToken);
  return csrfToken;
}

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
  const result = await login({ identifier, password, userAgent: req.get('user-agent'), ip: req.ip });
  if (result.mfaRequired) {
    // Stage two: only a short pre-auth cookie, no session and no user data.
    res.cookie(preAuthCookieName(), result.preauthToken, sessionCookieOptions(result.preauthExpiresAt));
    return res.json({ mfaRequired: true, expiresAt: result.preauthExpiresAt });
  }
  const csrfToken = setSession(res, result.token, result.expiresAt);
  res.json({ user: await withSecurity(result.user), csrfToken, mockMode: getConfig().mockMode });
}

export async function postMfaVerify(req, res) {
  const result = await completeMfaLogin({
    preauthToken: req.cookies?.[preAuthCookieName()],
    code: req.valid.body.code,
    userAgent: req.get('user-agent'),
    ip: req.ip,
  });
  const csrfToken = setSession(res, result.token, result.expiresAt);
  res.json({
    user: await withSecurity(result.user),
    csrfToken,
    mockMode: getConfig().mockMode,
    usedRecovery: result.usedRecovery,
    recoveryLeft: result.recoveryLeft,
  });
}

export async function postLogout(req, res) {
  await logout(req.sessionToken);
  res.clearCookie(sessionCookieName(), { ...sessionCookieOptions(), expires: undefined });
  res.json({ ok: true });
}

export async function getMe(req, res) {
  res.json({ user: await withSecurity(req.user), mockMode: getConfig().mockMode, csrfToken: issueCsrf(req, res) });
}

export async function postChangePassword(req, res) {
  await changeOwnPassword(req.user, req.valid.body);
  // All sessions were revoked; issue a new one for this device. It keeps
  // its 2FA check: the user just proved the current password here.
  const { token, expiresAt } = await reissueSession(req.user, req.authSession, { userAgent: req.get('user-agent') });
  res.cookie(sessionCookieName(), token, sessionCookieOptions(expiresAt));
  req.user.mustChangePassword = false;
  res.json({ user: await withSecurity(req.user) });
}

export async function getNotifications(req, res) {
  res.json(await listNotifications(req.user._id));
}

export async function postNotificationsRead(req, res) {
  await markAllRead(req.user._id);
  res.json({ ok: true });
}

// ---------------- Step-up and admin security (phase 3) ----------------

export async function postStepUp(req, res) {
  res.json(await mfa.performStepUp(req.user, req.authSession, req.valid.body));
}

export async function getSecurity(req, res) {
  res.json(await mfa.securityStatus(req.user));
}

export async function postMfaSetup(req, res) {
  res.json(await mfa.beginTotpSetup(req.user));
}

export async function postMfaConfirm(req, res) {
  res.json(await mfa.confirmTotpSetup(req.user, req.authSession, req.valid.body.code));
}

export async function postRecoveryCodes(req, res) {
  res.json(await mfa.regenerateRecoveryCodes(req.user));
}

export async function postSecurityEmail(req, res) {
  res.json(await mfa.startEmailLink(req.user, req.valid.body.email));
}

export async function postSecurityEmailVerify(req, res) {
  res.json(await mfa.confirmEmailLink(req.user, req.valid.body.code));
}

export async function postSecurityEmailTest(req, res) {
  res.json(await mfa.sendTestEmail(req.user));
}

export async function getAlerts(req, res) {
  res.json(await listAlerts());
}

export async function postAlertsRead(req, res) {
  await markAlertsRead();
  res.json({ ok: true });
}
