import crypto from 'node:crypto';
import { AccountSecurity, PreAuth, Session, User } from '../models/index.js';
import { DANGEROUS } from '../constants/permissions.js';
import { AppError, badRequest, serviceUnavailable, unauthorized } from '../utils/errors.js';
import { sha256 } from '../utils/sanitize.js';
import { recordEvent, userActor } from './auditService.js';
import { actorLabel, raiseAlert } from './alertService.js';
import { bumpCounter, clearCounter } from './counterService.js';
import { mailConfigured, sendMail } from './mailService.js';
import { verifyPassword } from './passwordService.js';
import {
  decryptSecret,
  encryptSecret,
  generateEmailCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  matchTotp,
  mfaKeyStatus,
  otpauthUri,
} from './mfaCrypto.js';

/**
 * Administrator 2FA and step-up (moderators phase 3, SPEC (هـ)).
 *
 * 2FA is opt-in until the owner confirms the setup with a first correct
 * code: before that nothing changes at sign-in, so the owner cannot be
 * locked out by a half-finished setup. Once on, every admin sign-in needs a
 * TOTP code or a one-time recovery code. Losing both: the local recovery
 * script (server/scripts/create-admin.js --reset-2fa).
 */

export const PREAUTH_TTL_MS = 5 * 60 * 1000;
export const PREAUTH_MAX_ATTEMPTS = 5;
const PENDING_SETUP_TTL_MS = 15 * 60 * 1000;
const SETUP_MAX_ATTEMPTS = 5;
export const STEP_UP_ALWAYS_MS = 60 * 1000;
export const REAUTH_RECENT_MS = 10 * 60 * 1000;
const STEP_UP_WINDOW_MS = 15 * 60 * 1000;
const STEP_UP_MAX_FAILS = 5;
const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const EMAIL_RESEND_MS = 60 * 1000;
const EMAIL_SENDS_PER_DAY = 5;

export const SECURITY_ACTION = 'security';

const NO_KEY_MESSAGE =
  'مفتاح تشفير التحقق بخطوتين غير مضبوط على الخادم (MFA_ENCRYPTION_KEY). أضفه في إعدادات فيرسل ثم أعد المحاولة.';

export function getSecurity(userId) {
  return AccountSecurity.findOne({ user: userId });
}

async function ensureSecurity(userId) {
  return AccountSecurity.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { user: userId } },
    { upsert: true, returnDocument: 'after' },
  );
}

export function isMfaEnabled(sec) {
  return Boolean(sec?.totp?.secretEnc);
}

export async function securityStatus(user) {
  const sec = await getSecurity(user._id);
  const key = mfaKeyStatus();
  const pendingFresh = sec?.totpPending && Date.now() - sec.totpPending.createdAt < PENDING_SETUP_TTL_MS;
  return {
    mfa: {
      enabled: isMfaEnabled(sec),
      enabledAt: sec?.totpEnabledAt || null,
      setupPending: Boolean(pendingFresh),
      recoveryCodesLeft: (sec?.recoveryCodes || []).filter((c) => !c.usedAt).length,
      recoveryCodesAt: sec?.recoveryCodesAt || null,
      keyAvailable: key.available,
      keyProblem: Boolean(key.problem),
      // The secret was made with another key version (key rotated or lost).
      keyMismatch: isMfaEnabled(sec) && sec.totp.keyVersion !== key.keyVersion,
    },
    email: {
      address: sec?.emailVerifiedAt ? sec.email : null,
      verifiedAt: sec?.emailVerifiedAt || null,
      pendingAddress: sec?.emailPending && sec.emailPending.expiresAt > new Date() ? sec.emailPending.address : null,
    },
    mailConfigured: mailConfigured(),
  };
}

// ---------------- Two-stage sign-in ----------------

/** Called by login() after a correct password for an account with 2FA on. */
export async function createPreAuth(user, { ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PREAUTH_TTL_MS);
  await PreAuth.create({
    tokenHash: sha256(token),
    user: user._id,
    expiresAt,
    ip: ip ? String(ip).slice(0, 80) : undefined,
    userAgent: userAgent ? String(userAgent).slice(0, 300) : undefined,
  });
  return { token, expiresAt };
}

/** Accept a TOTP code once per time step (replay guard, atomic). */
async function acceptTotp(sec, code) {
  const secret = decryptSecret(sec.totp?.secretEnc);
  if (!secret) return { ok: false, reason: 'KEY_UNAVAILABLE' };
  const step = matchTotp(secret, code);
  if (step === null) return { ok: false, reason: 'WRONG_CODE' };
  const res = await AccountSecurity.updateOne(
    { _id: sec._id, $or: [{ lastTotpStep: null }, { lastTotpStep: { $lt: step } }] },
    { $set: { lastTotpStep: step } },
  );
  if (!res.modifiedCount) return { ok: false, reason: 'CODE_REUSED' };
  return { ok: true };
}

/** Use one recovery code (atomic). Returns the number left, or -1 if not valid. */
async function consumeRecoveryCode(sec, code) {
  const hash = hashRecoveryCode(code);
  const res = await AccountSecurity.updateOne(
    { _id: sec._id, recoveryCodes: { $elemMatch: { hash, usedAt: null } } },
    { $set: { 'recoveryCodes.$.usedAt': new Date() } },
  );
  if (!res.modifiedCount) return -1;
  const fresh = await AccountSecurity.findById(sec._id).select('recoveryCodes').lean();
  return fresh.recoveryCodes.filter((c) => !c.usedAt).length;
}

const WRONG_CODE_MESSAGE = 'كود التحقق غير صحيح';

/**
 * Second stage of the admin sign-in. Returns the user on success; the
 * caller (authService.completeMfaLogin) creates the real session.
 */
export async function verifyPreAuth(preauthToken, code) {
  if (!preauthToken || typeof preauthToken !== 'string' || preauthToken.length > 200) {
    throw unauthorized('انتهت مهلة التحقق. سجّل الدخول من جديد.', 'MFA_SESSION_EXPIRED');
  }
  const pre = await PreAuth.findOne({ tokenHash: sha256(preauthToken), expiresAt: { $gt: new Date() } });
  if (!pre) throw unauthorized('انتهت مهلة التحقق. سجّل الدخول من جديد.', 'MFA_SESSION_EXPIRED');
  const user = await User.findById(pre.user);
  const sec = user ? await getSecurity(user._id) : null;
  if (!user || !isMfaEnabled(sec)) {
    await PreAuth.deleteOne({ _id: pre._id });
    throw unauthorized('انتهت مهلة التحقق. سجّل الدخول من جديد.', 'MFA_SESSION_EXPIRED');
  }

  let usedRecovery = false;
  let recoveryLeft = null;
  let ok;
  let reason = 'WRONG_CODE';
  if (looksLikeRecoveryCode(code)) {
    recoveryLeft = await consumeRecoveryCode(sec, code);
    ok = recoveryLeft >= 0;
    usedRecovery = ok;
  } else {
    const r = await acceptTotp(sec, code);
    ok = r.ok;
    reason = r.reason;
  }

  if (!ok) {
    const updated = await PreAuth.findOneAndUpdate({ _id: pre._id }, { $inc: { attempts: 1 } }, { returnDocument: 'after' });
    const attempts = updated?.attempts ?? PREAUTH_MAX_ATTEMPTS;
    if (attempts >= PREAUTH_MAX_ATTEMPTS) {
      await PreAuth.deleteOne({ _id: pre._id });
      await recordEvent({ subjectUser: user._id, type: 'mfa_login_blocked', actor: userActor(user), metadata: { ip: pre.ip } });
      await raiseAlert({
        type: 'mfa_login_blocked',
        severity: 'security',
        actor: user,
        message: `${PREAUTH_MAX_ATTEMPTS} أكواد تحقق خاطئة بعد كلمة مرور صحيحة على حساب ${actorLabel(user)}. إن لم تكن أنت، فكلمة المرور معروفة لغيرك: غيّرها الآن.`,
      });
      throw unauthorized('محاولات كثيرة خاطئة. سجّل الدخول من جديد.', 'MFA_SESSION_EXPIRED');
    }
    await raiseAlert({
      type: 'mfa_failed',
      actor: user,
      message: `كود تحقق بخطوتين خاطئ بعد كلمة مرور صحيحة على حساب ${actorLabel(user)}.`,
    });
    if (reason === 'KEY_UNAVAILABLE') {
      throw new AppError(
        503,
        'MFA_KEY_UNAVAILABLE',
        'تعذر قراءة سر التحقق على الخادم (مفتاح التشفير غير متاح). استخدم كود استرجاع، أو سكريبت الاسترجاع المحلي.',
      );
    }
    if (reason === 'CODE_REUSED') {
      throw unauthorized('هذا الكود استُخدم للتو. انتظر الكود التالي في التطبيق.', 'MFA_CODE_REUSED');
    }
    throw unauthorized(WRONG_CODE_MESSAGE, 'MFA_INVALID_CODE');
  }

  await PreAuth.deleteOne({ _id: pre._id });
  if (usedRecovery) {
    await recordEvent({ subjectUser: user._id, type: 'mfa_recovery_code_used', actor: userActor(user), metadata: { left: recoveryLeft } });
    await raiseAlert({
      type: 'recovery_code_used',
      severity: 'security',
      actor: user,
      key: `recovery_code_used:${user._id}:${recoveryLeft}`,
      message: `استُخدم كود استرجاع لدخول حساب ${actorLabel(user)}. الباقي: ${recoveryLeft} من 10.${recoveryLeft <= 3 ? ' أنشئ أكوادًا جديدة من صفحة الأمان.' : ''}`,
    });
  }
  return { user, usedRecovery, recoveryLeft, ip: pre.ip, userAgent: pre.userAgent };
}

// ---------------- Setup ----------------

export async function beginTotpSetup(user) {
  const key = mfaKeyStatus();
  if (!key.available) throw serviceUnavailable(NO_KEY_MESSAGE, 'MFA_KEY_MISSING');
  const secret = generateTotpSecret();
  const { enc, keyVersion } = encryptSecret(secret);
  await ensureSecurity(user._id);
  await AccountSecurity.updateOne(
    { user: user._id },
    { $set: { totpPending: { secretEnc: enc, keyVersion, createdAt: new Date(), attempts: 0 } } },
  );
  return { secret, otpauthUri: otpauthUri(secret, user.phone), issuer: 'Solita' };
}

/** First correct code turns 2FA on and returns the 10 recovery codes (shown once). */
export async function confirmTotpSetup(user, session, code) {
  const sec = await getSecurity(user._id);
  const pending = sec?.totpPending;
  if (!pending || Date.now() - pending.createdAt > PENDING_SETUP_TTL_MS) {
    throw badRequest('انتهت مهلة الإعداد. ابدأ من جديد.', 'MFA_SETUP_EXPIRED');
  }
  const secret = decryptSecret(pending.secretEnc);
  if (!secret) throw serviceUnavailable(NO_KEY_MESSAGE, 'MFA_KEY_MISSING');
  const step = matchTotp(secret, code);
  if (step === null) {
    const attempts = (pending.attempts || 0) + 1;
    if (attempts >= SETUP_MAX_ATTEMPTS) {
      await AccountSecurity.updateOne({ _id: sec._id }, { $set: { totpPending: null } });
      throw badRequest('أكواد خاطئة كثيرة. ابدأ الإعداد من جديد، وتأكد أن وقت الهاتف مضبوط تلقائيًا.', 'MFA_SETUP_EXPIRED');
    }
    await AccountSecurity.updateOne({ _id: sec._id }, { $set: { 'totpPending.attempts': attempts } });
    throw badRequest('الكود غير صحيح. اكتب الكود الظاهر الآن في التطبيق.', 'MFA_INVALID_CODE');
  }
  const wasEnabled = isMfaEnabled(sec);
  const { codes, hashes } = generateRecoveryCodes();
  const now = new Date();
  await AccountSecurity.updateOne(
    { _id: sec._id },
    {
      $set: {
        totp: { secretEnc: pending.secretEnc, keyVersion: pending.keyVersion, createdAt: now },
        totpPending: null,
        totpEnabledAt: now,
        lastTotpStep: step,
        recoveryCodes: hashes.map((hash) => ({ hash, usedAt: null })),
        recoveryCodesAt: now,
      },
    },
  );
  if (session?._id) await Session.updateOne({ _id: session._id }, { $set: { mfaVerifiedAt: now, reauthAt: now } });
  await recordEvent({ subjectUser: user._id, type: wasEnabled ? 'mfa_reconfigured' : 'mfa_enabled', actor: userActor(user) });
  await raiseAlert({
    type: 'mfa_enabled',
    severity: 'security',
    actor: user,
    message: wasEnabled
      ? `أعيد إعداد التحقق بخطوتين على حساب ${actorLabel(user)} (تطبيق جديد وأكواد استرجاع جديدة).`
      : `تم تفعيل التحقق بخطوتين على حساب ${actorLabel(user)}.`,
  });
  return { recoveryCodes: codes };
}

export async function regenerateRecoveryCodes(user) {
  const sec = await getSecurity(user._id);
  if (!isMfaEnabled(sec)) throw badRequest('فعّل التحقق بخطوتين أولًا', 'MFA_NOT_ENABLED');
  const { codes, hashes } = generateRecoveryCodes();
  await AccountSecurity.updateOne(
    { _id: sec._id },
    { $set: { recoveryCodes: hashes.map((hash) => ({ hash, usedAt: null })), recoveryCodesAt: new Date() } },
  );
  await recordEvent({ subjectUser: user._id, type: 'mfa_recovery_codes_regenerated', actor: userActor(user) });
  await raiseAlert({
    type: 'recovery_codes_regenerated',
    severity: 'security',
    actor: user,
    message: `أُنشئت أكواد استرجاع جديدة لحساب ${actorLabel(user)}، والأكواد القديمة لم تعد تعمل.`,
  });
  return { recoveryCodes: codes };
}

// ---------------- Step-up (identity check before a sensitive action) ----------------

/** How a user proves identity again: TOTP for an admin with 2FA, else the password. */
export async function stepUpMethod(user) {
  if (user.role === 'admin' && isMfaEnabled(await getSecurity(user._id))) return 'totp';
  return 'password';
}

export const STEP_UP_ACTIONS = Object.freeze([SECURITY_ACTION, ...Object.keys(DANGEROUS)]);

/**
 * POST /auth/step-up. On success: reauthAt = now (10-minute rule) and, for
 * a dangerous action that always needs it, a one-shot grant for that action
 * valid 60 seconds on this session only.
 */
export async function performStepUp(user, session, { action, code, password }) {
  if (!STEP_UP_ACTIONS.includes(action)) throw badRequest('إجراء غير معروف');
  const failKey = `stepup:${session._id}`;
  const method = await stepUpMethod(user);
  let ok;
  if (method === 'totp') {
    const sec = await getSecurity(user._id);
    const r = await acceptTotp(sec, code);
    ok = r.ok;
    if (!ok && r.reason === 'CODE_REUSED') {
      throw unauthorized('هذا الكود استُخدم للتو. انتظر الكود التالي في التطبيق (حتى 30 ثانية).', 'MFA_CODE_REUSED');
    }
    if (!ok && r.reason === 'KEY_UNAVAILABLE') throw serviceUnavailable(NO_KEY_MESSAGE, 'MFA_KEY_UNAVAILABLE');
  } else {
    const withHash = await User.findById(user._id).select('+passwordHash');
    ok = await verifyPassword(withHash.passwordHash, password || '');
  }
  if (!ok) {
    const fails = await bumpCounter(failKey, STEP_UP_WINDOW_MS);
    if (fails >= STEP_UP_MAX_FAILS) {
      // Too many wrong answers on this session: sign it out.
      await Session.deleteOne({ _id: session._id });
      await raiseAlert({
        type: 'step_up_failed',
        severity: user.role === 'admin' ? 'security' : 'normal',
        actor: user,
        message: `${STEP_UP_MAX_FAILS} محاولات تأكيد هوية خاطئة من ${actorLabel(user)}، فأُنهيت جلسته.`,
      });
      throw unauthorized('محاولات خاطئة كثيرة. سجّل الدخول من جديد.', 'UNAUTHENTICATED');
    }
    throw unauthorized(method === 'totp' ? WRONG_CODE_MESSAGE : 'كلمة المرور غير صحيحة', 'STEP_UP_INVALID');
  }
  await clearCounter(failKey, STEP_UP_WINDOW_MS);
  const now = new Date();
  const set = { reauthAt: now };
  if (DANGEROUS[action]?.stepUpAlways) set.stepUp = { action, at: now };
  await Session.updateOne({ _id: session._id }, { $set: set });
  return { ok: true, method };
}

export function stepUpRequired(action, mode, method) {
  return new AppError(
    403,
    'STEP_UP_REQUIRED',
    method === 'totp' ? 'أدخل كود التحقق من التطبيق لتأكيد هذا الإجراء' : 'أدخل كلمة المرور لتأكيد هذا الإجراء',
    { action, mode, method },
  );
}

/**
 * Check the step-up of this session (as loaded for this request).
 * mode "always": a fresh one-shot grant for exactly this action (60 s);
 *   the caller consumes it once the action succeeded (consumeStepUp), so a
 *   rejected request (e.g. a wrong confirmation word) does not waste it.
 * mode "recent": any identity check in the last 10 minutes.
 */
export async function checkStepUp(user, session, action, mode) {
  if (!session?._id) throw unauthorized();
  const now = Date.now();
  const fresh = (at, ms) => at && now - new Date(at).getTime() < ms;
  if (mode === 'always' && session.stepUp?.action === action && fresh(session.stepUp.at, STEP_UP_ALWAYS_MS)) return;
  if (mode !== 'always' && fresh(session.reauthAt, REAUTH_RECENT_MS)) return;
  throw stepUpRequired(action, mode, await stepUpMethod(user));
}

export async function consumeStepUp(session, action) {
  if (!session?._id) return;
  await Session.updateOne({ _id: session._id, 'stepUp.action': action }, { $unset: { stepUp: 1 } });
}

// ---------------- Personal email of the owner ----------------

function emailCodeHash(userId, address, code) {
  return sha256(`solita-email:${userId}:${address}:${code}`);
}

export async function startEmailLink(user, address) {
  if (!mailConfigured()) {
    throw serviceUnavailable('خدمة الإيميل غير مضبوطة على الخادم (GMAIL_SMTP_USER وGMAIL_SMTP_APP_PASSWORD في فيرسل).', 'MAIL_NOT_CONFIGURED');
  }
  const sec = await ensureSecurity(user._id);
  const now = new Date();
  if (sec.emailPending?.sentAt && now - sec.emailPending.sentAt < EMAIL_RESEND_MS) {
    throw new AppError(429, 'RATE_LIMITED', 'انتظر دقيقة قبل طلب كود جديد.');
  }
  const recent = (sec.emailSends || []).filter((d) => now - d < 24 * 60 * 60 * 1000);
  if (recent.length >= EMAIL_SENDS_PER_DAY) {
    throw new AppError(429, 'RATE_LIMITED', 'وصلت للحد اليومي لإرسال أكواد الإيميل. حاول غدًا.');
  }
  const code = generateEmailCode();
  const result = await sendMail({
    to: address,
    subject: 'كود ربط الإيميل بنظام سوليتا',
    text: `كود ربط هذا الإيميل بحساب الأدمن في نظام سوليتا: ${code}\n\nالكود صالح 15 دقيقة. إن لم تطلبه فتجاهل هذه الرسالة.`,
  });
  if (!result.ok) {
    throw new AppError(502, 'MAIL_SEND_FAILED', 'تعذر إرسال الإيميل. تأكد من إعدادات Gmail في فيرسل ومن صحة العنوان.');
  }
  await AccountSecurity.updateOne(
    { _id: sec._id },
    {
      $set: {
        emailPending: { address, codeHash: emailCodeHash(user._id, address, code), expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS), attempts: 0, sentAt: now },
        emailSends: [...recent, now],
      },
    },
  );
  return { sentTo: address };
}

export async function confirmEmailLink(user, code) {
  const sec = await getSecurity(user._id);
  const pending = sec?.emailPending;
  if (!pending || pending.expiresAt < new Date()) throw badRequest('انتهت صلاحية الكود. اطلب كودًا جديدًا.', 'EMAIL_CODE_EXPIRED');
  const value = String(code || '').replace(/\s+/g, '');
  const expected = Buffer.from(pending.codeHash);
  const actual = Buffer.from(emailCodeHash(user._id, pending.address, value));
  if (!/^\d{6}$/.test(value) || !crypto.timingSafeEqual(expected, actual)) {
    const attempts = (pending.attempts || 0) + 1;
    if (attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      await AccountSecurity.updateOne({ _id: sec._id }, { $set: { emailPending: null } });
      throw badRequest('أكواد خاطئة كثيرة. اطلب كودًا جديدًا.', 'EMAIL_CODE_EXPIRED');
    }
    await AccountSecurity.updateOne({ _id: sec._id }, { $set: { 'emailPending.attempts': attempts } });
    throw badRequest('الكود غير صحيح', 'EMAIL_CODE_INVALID');
  }
  const previous = sec.emailVerifiedAt ? sec.email : null;
  await AccountSecurity.updateOne(
    { _id: sec._id },
    { $set: { email: pending.address, emailVerifiedAt: new Date(), emailPending: null } },
  );
  await recordEvent({ subjectUser: user._id, type: 'security_email_linked', actor: userActor(user), next: { email: pending.address } });
  if (previous && previous !== pending.address) {
    await sendMail({
      to: previous,
      subject: 'تغيّر إيميل التنبيهات في نظام سوليتا',
      text: `رُبط إيميل جديد بحساب الأدمن في نظام سوليتا، ولن تصل التنبيهات إلى هذا العنوان بعد الآن.\nإن لم تكن أنت، استخدم سكريبت الاسترجاع فورًا.`,
    });
  }
  await raiseAlert({
    type: 'security_email_linked',
    severity: 'security',
    actor: user,
    message: `رُبط الإيميل ${pending.address} بحساب ${actorLabel(user)} لاستقبال التنبيهات.`,
  });
  return { address: pending.address };
}

export async function sendTestEmail(user) {
  const sec = await getSecurity(user._id);
  if (!sec?.emailVerifiedAt) throw badRequest('اربط إيميلك أولًا', 'EMAIL_NOT_LINKED');
  const count = await bumpCounter(`mailtest:${user._id}`, 60 * 60 * 1000);
  if (count > 3) throw new AppError(429, 'RATE_LIMITED', 'حد الإيميلات التجريبية 3 في الساعة.');
  const result = await sendMail({
    to: sec.email,
    subject: 'إيميل تجريبي من نظام سوليتا',
    text: 'وصلك هذا الإيميل، فالتنبيهات تعمل. لا حاجة لأي إجراء.',
  });
  if (!result.ok) throw new AppError(502, 'MAIL_SEND_FAILED', 'تعذر إرسال الإيميل. راجع إعدادات Gmail في فيرسل.');
  return { sentTo: sec.email };
}

