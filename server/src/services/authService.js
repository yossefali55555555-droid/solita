import crypto from 'node:crypto';
import { Session, User } from '../models/index.js';
import { ACCOUNT_STATUSES } from '../constants/statuses.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../utils/errors.js';
import { normalizePhone } from '../utils/phone.js';
import { sha256 } from '../utils/sanitize.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwordService.js';
import { recordEvent, SYSTEM_ACTOR, userActor } from './auditService.js';
import { actorLabel, raiseAlert } from './alertService.js';
import { recordActivitySafely } from './activityService.js';
import { bumpCounter, clearCounter, readCounter } from './counterService.js';
import { createPreAuth, getSecurity, isMfaEnabled, verifyPreAuth } from './mfaService.js';

/** Active = not deactivated (couriers: isActive) and status "active" (staff). */
export function isAccountActive(user) {
  return Boolean(user?.isActive) && (user.status === undefined || user.status === 'active');
}

const SESSION_TTL_MS = {
  admin: 12 * 60 * 60 * 1000, // 12 hours
  moderator: 12 * 60 * 60 * 1000, // 12 hours (several devices allowed)
  courier: 7 * 24 * 60 * 60 * 1000, // 7 days (mobile use)
};
const MAX_FAILED_LOGINS = 8;
const LOCK_MS = 15 * 60 * 1000;

const INVALID_CREDENTIALS = 'رقم الهاتف أو كلمة المرور غير صحيحة';

function findByIdentifier(identifier) {
  const value = String(identifier || '').trim();
  const query = value.includes('@') ? { email: value.toLowerCase() } : { phone: normalizePhone(value) };
  return User.findOne(query).select('+passwordHash +failedLoginCount +lockedUntil');
}

const ADMIN_FAIL_WINDOW_MS = LOCK_MS;
const ADMIN_ACCOUNT_ALERT_AT = 5;

async function createSession(user, { userAgent, mfaVerifiedAt = null } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = SESSION_TTL_MS[user.role] || SESSION_TTL_MS.admin;
  const expiresAt = new Date(Date.now() + ttl);
  const now = new Date();
  await Session.create({
    tokenHash: sha256(token),
    user: user._id,
    expiresAt,
    lastSeenAt: now,
    userAgent: userAgent ? String(userAgent).slice(0, 300) : undefined,
    mfaVerifiedAt,
    reauthAt: now,
  });
  return { token, expiresAt };
}

/**
 * Wrong password. Couriers/moderators: 8 → the account is locked 15 min (as
 * before). Administrator: counted per account + IP (SPEC (هـ)), so someone
 * who only knows the owner's phone number cannot lock the owner out; the
 * account-wide count only raises an alert.
 */
async function registerFailedPassword(user, ip) {
  if (user.role === 'admin') {
    const perIp = await bumpCounter(`adminfail:${user._id}:${ip || 'unknown'}`, ADMIN_FAIL_WINDOW_MS);
    const total = await bumpCounter(`adminfail:${user._id}:all`, ADMIN_FAIL_WINDOW_MS);
    if (perIp === MAX_FAILED_LOGINS) {
      await raiseAlert({
        type: 'login_locked',
        severity: 'security',
        actor: user,
        message: `أُوقف الدخول 15 دقيقة لحساب ${actorLabel(user)} من عنوان واحد بعد ${MAX_FAILED_LOGINS} محاولات خاطئة.`,
      });
    } else if (total === ADMIN_ACCOUNT_ALERT_AT) {
      await raiseAlert({
        type: 'admin_password_failures',
        severity: 'security',
        actor: user,
        message: `محاولات كلمة مرور خاطئة متكررة على حساب ${actorLabel(user)} خلال 15 دقيقة.`,
      });
    }
    return;
  }
  const failed = (user.failedLoginCount || 0) + 1;
  const update = { failedLoginCount: failed };
  if (failed >= MAX_FAILED_LOGINS) {
    update.lockedUntil = new Date(Date.now() + LOCK_MS);
    update.failedLoginCount = 0;
  }
  await User.updateOne({ _id: user._id }, { $set: update });
  if (update.lockedUntil) {
    await raiseAlert({
      type: 'login_locked',
      actor: user,
      message: `أُوقف الدخول 15 دقيقة لحساب ${actorLabel(user)} بعد ${MAX_FAILED_LOGINS} محاولات خاطئة.`,
    });
  }
}

async function adminLockedFromIp(user, ip) {
  if (user.role !== 'admin') return false;
  return (await readCounter(`adminfail:${user._id}:${ip || 'unknown'}`, ADMIN_FAIL_WINDOW_MS)) >= MAX_FAILED_LOGINS;
}

const LOCKED_MESSAGE = 'تم إيقاف تسجيل الدخول مؤقتاً بسبب محاولات متكررة. حاول لاحقاً.';

/**
 * Stage one of sign-in. Returns { user, token, expiresAt } (signed in), or
 * { mfaRequired: true, preauthToken, preauthExpiresAt } when the account is
 * the administrator with 2FA on (stage two: completeMfaLogin).
 */
export async function login({ identifier, password, userAgent, ip }) {
  const user = await findByIdentifier(identifier);
  if (!user) {
    await verifyAgainstDummy(password);
    throw unauthorized(INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  }
  if ((user.lockedUntil && user.lockedUntil > new Date()) || (await adminLockedFromIp(user, ip))) {
    throw new AppError(429, 'ACCOUNT_LOCKED', LOCKED_MESSAGE);
  }

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    await registerFailedPassword(user, ip);
    throw unauthorized(INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  }

  // Inactive accounts are rejected only after the password check, so the
  // response does not reveal which phone numbers exist.
  if (user.status === 'invited') {
    throw forbidden('لم يُفعَّل هذا الحساب بعد. استخدم رابط الدعوة.', 'ACCOUNT_INVITED');
  }
  if (!isAccountActive(user)) throw forbidden('هذا الحساب غير مفعل. تواصل مع المشرف.', 'ACCOUNT_INACTIVE');

  if (user.role === 'admin' && isMfaEnabled(await getSecurity(user._id))) {
    const pre = await createPreAuth(user, { ip, userAgent });
    return { mfaRequired: true, preauthToken: pre.token, preauthExpiresAt: pre.expiresAt };
  }
  return finishLogin(user, { userAgent, ip });
}

export async function finishLogin(user, { userAgent, ip, mfaVerifiedAt = null }) {
  await User.updateOne(
    { _id: user._id },
    { $set: { failedLoginCount: 0, lastLoginAt: new Date() }, $unset: { lockedUntil: 1 } },
  );
  if (user.role === 'admin') await clearCounter(`adminfail:${user._id}:${ip || 'unknown'}`, ADMIN_FAIL_WINDOW_MS);
  const { token, expiresAt } = await createSession(user, { userAgent, mfaVerifiedAt });
  return { user, token, expiresAt };
}

/** Stage two: a correct TOTP or recovery code → the real 12-hour session. */
export async function completeMfaLogin({ preauthToken, code, userAgent, ip }) {
  const result = await verifyPreAuth(preauthToken, code);
  const { user } = result;
  if (!isAccountActive(user)) throw forbidden('هذا الحساب غير مفعل. تواصل مع المشرف.', 'ACCOUNT_INACTIVE');
  const signed = await finishLogin(user, { userAgent: userAgent || result.userAgent, ip: ip || result.ip, mfaVerifiedAt: new Date() });
  return { ...signed, usedRecovery: result.usedRecovery, recoveryLeft: result.recoveryLeft };
}

/** Re-issue a session after the user's own password change (all others were revoked). */
export async function reissueSession(user, previousSession, { userAgent }) {
  return createSession(user, { userAgent, mfaVerifiedAt: previousSession?.mfaVerifiedAt || null });
}

/** Resolve a session token to an active user, or null. */
export async function resolveSession(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const session = await Session.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } }).lean();
  if (!session) return null;
  const user = await User.findById(session.user);
  if (!user || !isAccountActive(user)) return null;
  // Sessions created before a password change are invalid.
  if (user.passwordChangedAt && session.createdAt < user.passwordChangedAt) return null;
  return { user, session };
}

export async function logout(token) {
  if (!token) return;
  await Session.deleteOne({ tokenHash: sha256(token) });
}

export async function revokeAllSessions(userId) {
  await Session.deleteMany({ user: userId });
}

/**
 * Disable / re-enable a moderator account. Disabling deletes all of its
 * sessions at once (resolveSession also refuses non-active accounts, so a
 * request racing the delete is rejected too). The administrator can never
 * be disabled from the API.
 */
export async function setAccountStatus(actor, userId, status) {
  if (!ACCOUNT_STATUSES.includes(status)) throw badRequest('حالة الحساب غير صالحة');
  const user = await User.findById(userId);
  if (!user) throw notFound('الحساب غير موجود');
  if (user.role === 'admin') throw forbidden('لا يمكن إيقاف حساب الأدمن', 'ADMIN_PROTECTED');
  if (user.role !== 'moderator') throw notFound('الحساب غير موجود');
  const previous = user.status || 'active';
  user.status = status;
  user.isActive = status === 'active';
  await user.save();
  if (status !== 'active') await revokeAllSessions(user._id);
  if (previous !== status) {
    await recordEvent({
      subjectUser: user._id,
      type: status === 'disabled' ? 'account_disabled' : status === 'active' ? 'account_enabled' : 'account_invited',
      actor: actor ? userActor(actor) : SYSTEM_ACTOR,
      previous: { status: previous },
      next: { status },
    });
  }
  return user;
}

export async function changeOwnPassword(user, { currentPassword, newPassword }) {
  const withHash = await User.findById(user._id).select('+passwordHash');
  if (!(await verifyPassword(withHash.passwordHash, currentPassword))) {
    throw unauthorized('كلمة المرور الحالية غير صحيحة', 'INVALID_CREDENTIALS');
  }
  const passwordChangedAt = new Date(Date.now() - 1000);
  await User.updateOne(
    { _id: user._id },
    { $set: { passwordHash: await hashPassword(newPassword), mustChangePassword: false, passwordChangedAt } },
  );
  await revokeAllSessions(user._id);
  await recordEvent({ subjectUser: user._id, type: 'password_changed', actor: userActor(user) });
  await recordActivitySafely({ actor: user, action: 'auth.password_changed', severity: 'security', sentence: 'تغيير كلمة المرور', targets: [{ type: 'user', id: user._id, label: user.name }] });
}
