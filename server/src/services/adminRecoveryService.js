import mongoose from 'mongoose';
import { AccountSecurity, PreAuth, Session, User } from '../models/index.js';
import { recordEvent, SYSTEM_ACTOR } from './auditService.js';
import { raiseAlert } from './alertService.js';

/**
 * Local recovery of the administrator account (SPEC (هـ)). Used ONLY by
 * server/scripts/create-admin.js on the owner's computer with the local
 * .env; there is no HTTP endpoint for any of this.
 */

/**
 * "Reset 2FA": clears the TOTP secret (also a pending setup) and the
 * recovery codes, signs the admin out everywhere and writes a security
 * event. The admin signs in with the password only and sets 2FA up again.
 * The linked personal email is kept.
 */
export async function resetAdminMfa() {
  const admin = await User.findOne({ role: 'admin' });
  if (!admin) throw new Error('No administrator account exists.');
  const sec = await AccountSecurity.findOne({ user: admin._id }).lean();
  const hadMfa = Boolean(sec?.totp?.secretEnc);
  await AccountSecurity.updateOne(
    { user: admin._id },
    { $set: { totp: null, totpPending: null, totpEnabledAt: null, lastTotpStep: null, recoveryCodes: [], recoveryCodesAt: null } },
  );
  const sessions = await Session.deleteMany({ user: admin._id });
  await PreAuth.deleteMany({ user: admin._id });
  await recordEvent({ subjectUser: admin._id, type: 'admin_mfa_reset_cli', actor: SYSTEM_ACTOR, previous: { mfaEnabled: hadMfa } });
  await raiseAlert({
    type: 'admin_mfa_reset_cli',
    severity: 'security',
    message: `أُعيد ضبط التحقق بخطوتين لحساب الأدمن ${admin.name} من سكريبت الاسترجاع المحلي، وأُنهيت كل جلساته. فعّله من جديد من صفحة الأمان.`,
  });
  return { admin, hadMfa, sessionsRevoked: sessions.deletedCount };
}

/**
 * "Transfer admin": demotes the current administrator to a disabled
 * moderator with no permissions and promotes `targetPhone` (an existing
 * moderator; couriers are never promoted) in ONE transaction, so there is
 * never zero or two admins. Both accounts are signed out everywhere and the
 * new admin starts without 2FA (set it up after the first sign-in).
 * With `create` = { name, passwordHash } a new account is created instead
 * when the phone number has no account.
 */
export async function transferAdmin({ targetPhone, create = null }) {
  const current = await User.findOne({ role: 'admin' });
  if (!current) throw new Error('No administrator account exists. Use: npm run admin:create');
  let target = await User.findOne({ phone: targetPhone });
  if (target?.role === 'admin') throw new Error('This phone number is already the administrator.');
  if (target?.role === 'courier') throw new Error('Courier accounts are never promoted to administrator.');
  if (!target && !create) throw new Error('No account with this phone number. Run again with --create-target.');

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await User.updateOne(
        { _id: current._id },
        { $set: { role: 'moderator', status: 'disabled', isActive: false, permissions: { sections: {}, dangerous: [], fields: [] } } },
        { session },
      );
      if (target) {
        await User.updateOne(
          { _id: target._id },
          { $set: { role: 'admin', status: 'active', isActive: true, mustChangePassword: false }, $unset: { permissions: 1, templateName: 1 } },
          { session, allowAdminRoleChange: true },
        );
      } else {
        [target] = await User.create(
          [{ name: create.name, phone: targetPhone, passwordHash: create.passwordHash, role: 'admin', isActive: true }],
          { session },
        );
      }
      await AccountSecurity.deleteMany({ user: { $in: [current._id, target._id] } }, { session });
      await Session.deleteMany({ user: { $in: [current._id, target._id] } }, { session });
      await PreAuth.deleteMany({ user: { $in: [current._id, target._id] } }, { session });
    });
  } finally {
    await session.endSession();
  }
  await recordEvent({
    subjectUser: target._id,
    type: 'admin_transferred_cli',
    actor: SYSTEM_ACTOR,
    previous: { admin: String(current._id) },
    next: { admin: String(target._id) },
  });
  await raiseAlert({
    type: 'admin_transferred_cli',
    severity: 'security',
    message: `نُقل حساب الأدمن من ${current.name} إلى ${target.name} بسكريبت الاسترجاع المحلي.`,
  });
  return { from: current, to: target };
}
