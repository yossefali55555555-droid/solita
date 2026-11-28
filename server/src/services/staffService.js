import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { AccountInvite, Session, User } from '../models/index.js';
import { INVITE_TTL_MS } from '../models/AccountInvite.js';
import { ACCOUNT_STATUS_AR } from '../constants/activity.js';
import { FIELDS } from '../constants/permissions.js';
import { getConfig } from '../config/env.js';
import { badRequest, conflict, forbidden, isDuplicateKeyError, notFound, unauthorized } from '../utils/errors.js';
import { sha256 } from '../utils/sanitize.js';
import { logger } from '../utils/logger.js';
import { hashPassword } from './passwordService.js';
import { raiseAlert } from './alertService.js';
import { recordActivity } from './activityService.js';
import { finishLogin } from './authService.js';
import { deviceLabel } from '../utils/device.js';
import { PermissionTemplate } from '../models/index.js';
import { ensureDefaultTemplates } from './templateService.js';
import { diffPermissions, grantUntil, normalizePermissions, plainPermissions, summarizePermissions } from './permissionEditor.js';

/**
 * Staff (moderator) account management for the administrator (phase 4).
 * Every change and its activity line are written in one MongoDB transaction
 * (SPEC (ز): dangerous actions and their line stay together). Only moderator
 * accounts are managed here: the administrator and couriers are never touched.
 */

const day = (d) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');

/** Run `fn(session)` in a transaction; falls back to plain writes where transactions do not exist (a local standalone mongod). */
async function inTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    if (err?.codeName === 'IllegalOperation' || /replica set|Transaction numbers/i.test(err?.message || '')) {
      logger.warn('Transactions are not available; writing without one');
      return fn(null);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

const opt = (session) => (session ? { session } : {});

// ---------------------------------------------------------------- helpers

const SECRET_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** A readable temporary password with letters and digits (shown once). */
export function generateTempPassword(length = 14) {
  let out = '';
  const bytes = crypto.randomBytes(length * 2);
  for (let i = 0; out.length < length - 2; i += 1) out += SECRET_ALPHABET[bytes[i] % SECRET_ALPHABET.length];
  return `${out}${crypto.randomInt(10, 100)}`; // always ends with digits, and has letters
}

function inviteLink(token) {
  const origin = getConfig().clientOrigins[0] || '';
  return `${origin}/invite#t=${token}`;
}

function newInviteToken() {
  const token = crypto.randomBytes(32).toString('base64url'); // 256 bits
  return { token, tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) };
}

async function moderatorOrThrow(id, { session = null, select = '' } = {}) {
  if (!mongoose.isValidObjectId(id)) throw notFound('الحساب غير موجود');
  const user = await User.findById(id).select(select).session(session);
  if (!user) throw notFound('الحساب غير موجود');
  if (user.role === 'admin') throw forbidden('لا يمكن تعديل حساب الأدمن من هنا', 'ADMIN_PROTECTED');
  if (user.role !== 'moderator') throw notFound('الحساب غير موجود');
  return user;
}

function summary(user, extras = {}) {
  const perms = plainPermissions(user.permissions);
  const phoneGrant = perms.fields.find((g) => g.key === 'customerPhone');
  return {
    id: String(user._id),
    name: user.name,
    phone: user.phone,
    status: user.status || 'active',
    statusLabel: ACCOUNT_STATUS_AR[user.status || 'active'],
    templateName: user.templateName || null,
    mustChangePassword: Boolean(user.mustChangePassword),
    lastLoginAt: user.lastLoginAt || null,
    createdAt: user.createdAt,
    permissions: { sections: perms.sections, dangerous: perms.dangerous, fields: perms.fields.map((g) => ({ key: g.key, until: g.until ? g.until.toISOString() : null })) },
    phoneGrant: phoneGrant ? { until: phoneGrant.until ? phoneGrant.until.toISOString() : null } : null,
    ...extras,
  };
}

// ---------------------------------------------------------------- reading

export async function listStaff() {
  const users = await User.find({ role: 'moderator' }).sort({ createdAt: 1 }).lean();
  const sessions = await Session.aggregate([
    { $match: { user: { $in: users.map((u) => u._id) }, expiresAt: { $gt: new Date() } } },
    { $group: { _id: '$user', n: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(sessions.map((s) => [String(s._id), s.n]));
  return users.map((u) => summary(u, { activeSessions: counts[String(u._id)] || 0 }));
}

export async function getStaff(id) {
  const user = await moderatorOrThrow(id);
  const [sessions, invite] = await Promise.all([listSessions(user._id), AccountInvite.findOne({ user: user._id, expiresAt: { $gt: new Date() } }).select('expiresAt createdAt').lean()]);
  return summary(user, { sessions, invite: invite ? { expiresAt: invite.expiresAt, createdAt: invite.createdAt } : null, invitePending: Boolean(user.invitePending) });
}

export async function listSessions(userId) {
  const rows = await Session.find({ user: userId, expiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 }).lean();
  return rows.map((s) => ({ id: String(s._id), device: deviceLabel(s.userAgent), createdAt: s.createdAt, lastSeenAt: s.lastSeenAt || s.createdAt, expiresAt: s.expiresAt }));
}

// ---------------------------------------------------------------- create

/**
 * Create a moderator. `mode`:
 *   password: temporary password (given or generated), shown once, changed at first sign-in
 *   invite:   status «invited» + a 48-hour single-use link, shown once
 * Permissions come from `templateName` (copied now) and/or an explicit set.
 */
export async function createStaff(admin, { name, phone, mode, password, templateName, permissions }) {
  let perms = { sections: {}, dangerous: [], fields: [] };
  let label = null;
  if (templateName) {
    await ensureDefaultTemplates();
    const tpl = await PermissionTemplate.findOne({ name: templateName }).lean();
    if (!tpl) throw badRequest('القالب غير موجود');
    perms = normalizePermissions({ sections: tpl.sections, dangerous: tpl.dangerous, fields: tpl.fields });
    label = tpl.name;
  }
  if (permissions) {
    perms = normalizePermissions(permissions);
    if (!templateName) label = 'مخصص';
  }
  const isInvite = mode === 'invite';
  const tempPassword = isInvite ? null : password || generateTempPassword();
  const invite = isInvite ? newInviteToken() : null;
  const passwordHash = await hashPassword(tempPassword || crypto.randomBytes(24).toString('base64url'));

  try {
    return await inTransaction(async (session) => {
      const [user] = await User.create(
        [
          {
            name,
            phone,
            passwordHash,
            role: 'moderator',
            isActive: !isInvite,
            status: isInvite ? 'invited' : 'active',
            invitePending: isInvite,
            mustChangePassword: !isInvite,
            permissions: perms,
            templateName: label || undefined,
            createdBy: admin._id,
          },
        ],
        opt(session),
      );
      if (invite) await AccountInvite.create([{ tokenHash: invite.tokenHash, user: user._id, expiresAt: invite.expiresAt, createdBy: admin._id }], opt(session));
      await recordActivity({
        actor: admin,
        action: 'account.created',
        severity: 'security',
        sentence: `إنشاء حساب مودريتور ${`«${name}»`} ${isInvite ? 'بلينك دعوة' : 'بكلمة سر مؤقتة'}${label ? ` (قالب «${label}»)` : ''}`,
        targets: [{ type: 'user', id: user._id, label: name }],
        after: summarizePermissions(perms),
        session,
      });
      return {
        account: summary(user),
        ...(tempPassword ? { tempPassword } : {}),
        ...(invite ? { invite: { token: invite.token, link: inviteLink(invite.token), expiresAt: invite.expiresAt } } : {}),
      };
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('هذا الرقم مستخدم في حساب آخر', 'DUPLICATE_USER');
    throw err;
  }
}

// ---------------------------------------------------------------- edit

export async function updateStaff(admin, id, { name, phone, permissions, templateName }) {
  return inTransaction(async (session) => {
    const user = await moderatorOrThrow(id, { session });
    const lines = [];
    const before = {};
    const after = {};
    if (name !== undefined && name !== user.name) {
      lines.push(`الاسم من «${user.name}» إلى «${name}»`);
      before.name = user.name;
      after.name = name;
      user.name = name;
    }
    if (phone !== undefined && phone !== user.phone) {
      lines.push('رقم الهاتف'); // the number itself is never written to the log
      user.phone = phone;
    }
    let permissionLines = [];
    if (permissions !== undefined) {
      const next = normalizePermissions(permissions);
      permissionLines = diffPermissions(plainPermissions(user.permissions), next);
      if (permissionLines.length) {
        before.permissions = summarizePermissions(plainPermissions(user.permissions));
        after.permissions = summarizePermissions(next);
        user.permissions = next;
      }
    }
    if (templateName !== undefined && templateName !== (user.templateName || '')) user.templateName = templateName || undefined;
    if (!lines.length && !permissionLines.length && templateName === undefined) return summary(user);
    try {
      await user.save(opt(session));
    } catch (err) {
      if (isDuplicateKeyError(err)) throw conflict('هذا الرقم مستخدم في حساب آخر', 'DUPLICATE_USER');
      throw err;
    }
    const parts = [];
    if (lines.length) parts.push(`تعديل بيانات ${`«${user.name}»`}: ${lines.join('، ')}`);
    if (permissionLines.length) parts.push(`تعديل صلاحيات ${`«${user.name}»`}: ${permissionLines.join('؛ ')}`);
    if (parts.length) {
      await recordActivity({
        actor: admin,
        action: permissionLines.length ? 'account.permissions_changed' : 'account.updated',
        severity: 'security',
        sentence: parts.join(' — '),
        targets: [{ type: 'user', id: user._id, label: user.name }],
        before,
        after,
        session,
      });
    }
    return summary(user);
  });
}

/** Grant the customer-phone permission for a limited time (or any temporary field). */
export async function grantField(admin, id, key, { duration, until }) {
  if (!FIELDS[key]?.temporary) throw badRequest('هذا التصريح لا يُمنح مؤقتًا');
  const end = grantUntil({ duration, until });
  return inTransaction(async (session) => {
    const user = await moderatorOrThrow(id, { session });
    const current = plainPermissions(user.permissions);
    const next = normalizePermissions({ ...current, fields: [...current.fields.filter((g) => g.key !== key), { key, until: end }] });
    user.permissions = next;
    await user.save(opt(session));
    await recordActivity({
      actor: admin,
      action: 'account.field_granted',
      severity: 'security',
      sentence: `منح ${FIELDS[key].label} مؤقتًا لـ«${user.name}» حتى ${day(end)}`,
      targets: [{ type: 'user', id: user._id, label: user.name }],
      after: { field: key, until: end.toISOString() },
      session,
    });
    return summary(user);
  });
}

export async function revokeField(admin, id, key) {
  if (!FIELDS[key]) throw badRequest('تصريح غير معروف');
  return inTransaction(async (session) => {
    const user = await moderatorOrThrow(id, { session });
    const current = plainPermissions(user.permissions);
    if (!current.fields.some((g) => g.key === key)) return summary(user);
    user.permissions = normalizePermissions({ ...current, fields: current.fields.filter((g) => g.key !== key) });
    await user.save(opt(session));
    await recordActivity({
      actor: admin,
      action: 'account.field_revoked',
      severity: 'security',
      sentence: `سحب ${FIELDS[key].label} من «${user.name}»`,
      targets: [{ type: 'user', id: user._id, label: user.name }],
      after: { field: key },
      session,
    });
    return summary(user);
  });
}

// ---------------------------------------------------------------- status, sessions, password

/** Disable or enable. Disabling deletes every session and every unused invite link. */
export async function setStatus(admin, id, status) {
  if (!['active', 'disabled'].includes(status)) throw badRequest('حالة الحساب غير صالحة');
  return inTransaction(async (session) => {
    const user = await moderatorOrThrow(id, { session });
    const previous = user.status || 'active';
    // A disabled account that never accepted its invite goes back to «invited», never straight to «active».
    const next = status === 'active' && user.invitePending ? 'invited' : status;
    if (previous === next) return summary(user);
    user.status = next;
    user.isActive = next === 'active';
    await user.save(opt(session));
    if (next === 'disabled') {
      await Session.deleteMany({ user: user._id }, opt(session));
      await AccountInvite.deleteMany({ user: user._id }, opt(session));
    }
    await recordActivity({
      actor: admin,
      action: next === 'disabled' ? 'account.disabled' : 'account.enabled',
      severity: 'security',
      sentence: next === 'disabled' ? `إيقاف حساب «${user.name}» وإنهاء كل جلساته` : next === 'invited' ? `إعادة حساب «${user.name}» إلى حالة المدعو (يحتاج لينك دعوة جديدًا)` : `إعادة تفعيل حساب «${user.name}»`,
      targets: [{ type: 'user', id: user._id, label: user.name }],
      before: { status: previous },
      after: { status: next },
      session,
    });
    return summary(user);
  });
}

export async function revokeSessions(admin, id, sessionId = null) {
  return inTransaction(async (session) => {
    const user = await moderatorOrThrow(id, { session });
    const filter = { user: user._id };
    if (sessionId) {
      if (!mongoose.isValidObjectId(sessionId)) throw notFound('الجلسة غير موجودة');
      filter._id = sessionId;
    }
    const res = await Session.deleteMany(filter, opt(session));
    await recordActivity({
      actor: admin,
      action: 'account.sessions_revoked',
      severity: 'security',
      sentence: sessionId ? `إنهاء جلسة واحدة لـ«${user.name}»` : `طرد «${user.name}» من كل جلساته (${res.deletedCount})`,
      targets: [{ type: 'user', id: user._id, label: user.name }],
      after: { count: res.deletedCount },
      session,
    });
    return { revoked: res.deletedCount };
  });
}

/** New temporary password (shown once), sessions ended, change forced at the next sign-in. */
export async function resetPassword(admin, id, { newPassword } = {}) {
  const tempPassword = newPassword || generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  const result = await inTransaction(async (session) => {
    const user = await moderatorOrThrow(id, { session });
    if (user.status === 'invited') throw conflict('الحساب لم يقبل الدعوة بعد، ولّد لينك دعوة جديدًا بدل كلمة السر', 'ACCOUNT_INVITED');
    user.passwordHash = passwordHash;
    user.mustChangePassword = true;
    user.passwordChangedAt = new Date(Date.now() - 1000);
    user.failedLoginCount = 0;
    user.lockedUntil = undefined;
    await user.save(opt(session));
    await Session.deleteMany({ user: user._id }, opt(session));
    await recordActivity({
      actor: admin,
      action: 'auth.staff_password_reset',
      severity: 'security',
      sentence: `إعادة تعيين كلمة سر «${user.name}» وإنهاء جلساته`,
      targets: [{ type: 'user', id: user._id, label: user.name }],
      session,
    });
    return { name: user.name, id: user._id };
  });
  // Phase-3 alert: a password reset always shows on the security page and in the daily email.
  await raiseAlert({
    type: 'staff_password_reset',
    key: `moderator_password_reset:${result.id}`,
    actor: admin,
    message: `أُعيد تعيين كلمة سر المودريتور «${result.name}».`,
  });
  return { tempPassword };
}

// ---------------------------------------------------------------- invites

export async function regenerateInvite(admin, id) {
  const invite = newInviteToken();
  return inTransaction(async (session) => {
    const user = await moderatorOrThrow(id, { session });
    if (user.status !== 'invited') throw conflict('لينك الدعوة متاح للحسابات المدعوة فقط', 'NOT_INVITED');
    await AccountInvite.deleteMany({ user: user._id }, opt(session)); // the old link stops working
    await AccountInvite.create([{ tokenHash: invite.tokenHash, user: user._id, expiresAt: invite.expiresAt, createdBy: admin._id }], opt(session));
    await recordActivity({
      actor: admin,
      action: 'account.invite_created',
      severity: 'security',
      sentence: `إنشاء لينك دعوة جديد لـ«${user.name}» (يلغي القديم)`,
      targets: [{ type: 'user', id: user._id, label: user.name }],
      session,
    });
    return { invite: { token: invite.token, link: inviteLink(invite.token), expiresAt: invite.expiresAt } };
  });
}

const INVALID_INVITE = 'لينك الدعوة غير صالح أو انتهت مدته';

/** Public: the invited person sets a password with the link's token and is signed in. */
export async function acceptInvite({ token, password, userAgent, ip }) {
  if (!token || typeof token !== 'string' || token.length > 200) throw unauthorized(INVALID_INVITE, 'INVALID_INVITE');
  const passwordHash = await hashPassword(password);
  const user = await inTransaction(async (session) => {
    // Claim the token first: deleting it is atomic, so a link works once.
    const invite = await AccountInvite.findOneAndDelete({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } }, opt(session));
    if (!invite) throw unauthorized(INVALID_INVITE, 'INVALID_INVITE');
    const account = await User.findById(invite.user).session(session);
    // A disabled account never comes back through an old link.
    if (!account || account.role !== 'moderator' || account.status !== 'invited') throw unauthorized(INVALID_INVITE, 'INVALID_INVITE');
    account.passwordHash = passwordHash;
    account.status = 'active';
    account.isActive = true;
    account.invitePending = false;
    account.mustChangePassword = false;
    account.passwordChangedAt = new Date(Date.now() - 1000);
    await account.save(opt(session));
    await AccountInvite.deleteMany({ user: account._id }, opt(session));
    await recordActivity({
      actor: account,
      action: 'auth.invite_accepted',
      severity: 'security',
      sentence: 'قبول الدعوة وتعيين كلمة المرور',
      targets: [{ type: 'user', id: account._id, label: account.name }],
      session,
    });
    return account;
  });
  return finishLogin(user, { userAgent, ip });
}
