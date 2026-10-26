import crypto from 'node:crypto';
import { Session, User } from '../models/index.js';
import { AppError, forbidden, unauthorized } from '../utils/errors.js';
import { normalizePhone } from '../utils/phone.js';
import { sha256 } from '../utils/sanitize.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwordService.js';
import { recordEvent, userActor } from './auditService.js';

const SESSION_TTL_MS = {
  admin: 12 * 60 * 60 * 1000, // 12 hours
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

export async function login({ identifier, password, userAgent }) {
  const user = await findByIdentifier(identifier);
  if (!user) {
    await verifyAgainstDummy(password);
    throw unauthorized(INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(
      429,
      'ACCOUNT_LOCKED',
      'تم إيقاف تسجيل الدخول مؤقتاً بسبب محاولات متكررة. حاول لاحقاً.',
    );
  }

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    const failed = (user.failedLoginCount || 0) + 1;
    const update = { failedLoginCount: failed };
    if (failed >= MAX_FAILED_LOGINS) {
      update.lockedUntil = new Date(Date.now() + LOCK_MS);
      update.failedLoginCount = 0;
    }
    await User.updateOne({ _id: user._id }, { $set: update });
    throw unauthorized(INVALID_CREDENTIALS, 'INVALID_CREDENTIALS');
  }

  // Inactive accounts are rejected only after the password check, so the
  // response does not reveal which phone numbers exist.
  if (!user.isActive) throw forbidden('هذا الحساب غير مفعل. تواصل مع المشرف.', 'ACCOUNT_INACTIVE');

  await User.updateOne(
    { _id: user._id },
    { $set: { failedLoginCount: 0, lastLoginAt: new Date() }, $unset: { lockedUntil: 1 } },
  );

  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = SESSION_TTL_MS[user.role] || SESSION_TTL_MS.admin;
  const expiresAt = new Date(Date.now() + ttl);
  await Session.create({
    tokenHash: sha256(token),
    user: user._id,
    expiresAt,
    lastSeenAt: new Date(),
    userAgent: userAgent ? String(userAgent).slice(0, 300) : undefined,
  });

  return { user, token, expiresAt };
}

/** Resolve a session token to an active user, or null. */
export async function resolveSession(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const session = await Session.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } }).lean();
  if (!session) return null;
  const user = await User.findById(session.user);
  if (!user || !user.isActive) return null;
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
}
