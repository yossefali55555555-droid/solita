import crypto from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountSecurity, PreAuth, SecurityAlert, Session, User } from '../src/models/index.js';
import { resetConfig } from '../src/config/env.js';
import { currentStep, decryptSecret, encryptSecret, totpForStep } from '../src/services/mfaCrypto.js';
import { raiseAlert, sendDailyDigest } from '../src/services/alertService.js';
import { setMailTransport } from '../src/services/mailService.js';
import { resetAdminMfa, transferAdmin } from '../src/services/adminRecoveryService.js';
import { hashPassword } from '../src/services/passwordService.js';
import { PASSWORD, adminUser, client, createUser, getTestApp, loginAs, stepUp } from './helpers.js';

// Phase 3: a real 32-byte key for the 2FA secret (test only).
process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
resetConfig();

const sent = [];
afterEach(() => {
  sent.length = 0;
  setMailTransport(null);
});
function captureMail() {
  setMailTransport({ sendMail: async (m) => sent.push(m) });
}

/** A code the authenticator would show now (offset in 30 s steps). */
const codeNow = (secret, offset = 0) => totpForStep(secret, currentStep() + offset);
/** A 6-digit code that is surely wrong right now. */
function wrongCode(secret) {
  const valid = new Set([-1, 0, 1].map((d) => codeNow(secret, d)));
  for (let i = 0; ; i += 1) {
    const c = String(i).padStart(6, '0');
    if (!valid.has(c)) return c;
  }
}
/** Let the next code of the current step be accepted again (replay guard reset). */
const clearReplayGuard = (userId) => AccountSecurity.updateOne({ user: userId }, { $set: { lastTotpStep: null } });

async function enableMfa(admin) {
  const api = await loginAs(admin);
  const setup = await api.post('/api/auth/security/2fa/setup');
  expect(setup.status).toBe(200);
  const confirm = await api.post('/api/auth/security/2fa/confirm', { code: codeNow(setup.body.secret) });
  expect(confirm.status).toBe(200);
  return { api, secret: setup.body.secret, codes: confirm.body.recoveryCodes };
}

/** Stage one only: returns the client holding the pre-auth cookie. */
async function startLogin(user, ip) {
  const api = await client();
  const csrf = (await api.agent.get('/api/auth/csrf')).body.csrfToken;
  const req = api.agent.post('/api/auth/login');
  if (ip) req.set('X-Forwarded-For', ip);
  const res = await req.set('x-csrf-token', csrf).send({ identifier: user.phone, password: PASSWORD });
  api.setToken(csrf);
  return { api, res };
}

describe('TOTP and encryption building blocks', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
    expect(totpForStep(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpForStep(secret, Math.floor(1111111109 / 30))).toBe('081804');
  });

  it('encrypts the secret with AES-256-GCM and refuses another key version', () => {
    const { enc } = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(enc).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(enc)).toBe('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(enc.replace(/^v1\./, 'v2.'))).toBeNull();
    expect(decryptSecret(`${enc.slice(0, -2)}AA`)).toBeNull();
  });
});

describe('admin 2FA', () => {
  it('changes nothing at sign-in until the setup is confirmed (no lock-out)', async () => {
    const admin = await adminUser();
    const api = await loginAs(admin);
    expect((await api.get('/api/auth/me')).body.user.security).toMatchObject({ mfaEnabled: false, emailLinked: false });
    // A started but unconfirmed setup still signs in with the password only.
    expect((await api.post('/api/auth/security/2fa/setup')).status).toBe(200);
    const again = await loginAs(admin);
    expect((await again.get('/api/auth/me')).status).toBe(200);
  });

  it('setup → confirm → every sign-in needs a code; replayed codes are refused', async () => {
    const admin = await adminUser();
    const { secret, codes } = await enableMfa(admin);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    const sec = await AccountSecurity.findOne({ user: admin._id }).lean();
    expect(JSON.stringify(sec)).not.toContain(secret);
    expect(JSON.stringify(sec)).not.toContain(codes[0]);

    const { api, res } = await startLogin(admin);
    expect(res.body).toEqual({ mfaRequired: true, expiresAt: expect.any(String) });
    expect((await api.get('/api/auth/me')).status).toBe(401);
    // The confirmation used the current step: the same code is refused.
    const replay = await api.post('/api/auth/2fa/verify', { code: codeNow(secret) });
    expect(replay.body.error.code).toBe('MFA_CODE_REUSED');
    const ok = await api.post('/api/auth/2fa/verify', { code: codeNow(secret, 1) });
    expect(ok.status).toBe(200);
    expect(ok.body.user.security.mfaEnabled).toBe(true);
    expect((await api.get('/api/auth/me')).status).toBe(200);
    expect(await PreAuth.countDocuments()).toBe(0);
    expect(await SecurityAlert.exists({ type: 'mfa_enabled', severity: 'security' })).toBeTruthy();
  });

  it('five wrong codes burn the pre-auth record and alert the owner', async () => {
    const admin = await adminUser();
    const { secret } = await enableMfa(admin);
    await clearReplayGuard(admin._id);
    const { api } = await startLogin(admin);
    for (let i = 0; i < 4; i += 1) {
      expect((await api.post('/api/auth/2fa/verify', { code: wrongCode(secret) })).body.error.code).toBe('MFA_INVALID_CODE');
    }
    expect((await api.post('/api/auth/2fa/verify', { code: wrongCode(secret) })).body.error.code).toBe('MFA_SESSION_EXPIRED');
    expect((await api.post('/api/auth/2fa/verify', { code: codeNow(secret) })).body.error.code).toBe('MFA_SESSION_EXPIRED');
    expect(await SecurityAlert.exists({ type: 'mfa_login_blocked', severity: 'security' })).toBeTruthy();
    const merged = await SecurityAlert.findOne({ type: 'mfa_failed' }).lean();
    expect(merged.count).toBe(4);
  });

  it('a recovery code signs in once, in any letter case, and alerts', async () => {
    const admin = await adminUser();
    const { codes } = await enableMfa(admin);
    const first = await startLogin(admin);
    const ok = await first.api.post('/api/auth/2fa/verify', { code: codes[0].toLowerCase().replaceAll('-', '') });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ usedRecovery: true, recoveryLeft: 9 });
    const second = await startLogin(admin);
    expect((await second.api.post('/api/auth/2fa/verify', { code: codes[0] })).status).toBe(401);
    expect(await SecurityAlert.exists({ type: 'recovery_code_used' })).toBeTruthy();
  });

  it('regenerating recovery codes invalidates the old ones', async () => {
    const admin = await adminUser();
    const { api, codes } = await enableMfa(admin);
    const res = await api.post('/api/auth/security/recovery-codes');
    expect(res.body.recoveryCodes).toHaveLength(10);
    const { api: next } = await startLogin(admin);
    expect((await next.post('/api/auth/2fa/verify', { code: codes[1] })).status).toBe(401);
    expect((await next.post('/api/auth/2fa/verify', { code: res.body.recoveryCodes[1] })).status).toBe(200);
  });

  it('the admin lock-out is per account + IP, so knowing the phone number cannot lock the owner out', async () => {
    const admin = await adminUser();
    const agent = request.agent(getTestApp());
    const csrf = (await agent.get('/api/auth/csrf')).body.csrfToken;
    const attempt = (ip, password) =>
      agent.post('/api/auth/login').set('X-Forwarded-For', ip).set('x-csrf-token', csrf).send({ identifier: admin.phone, password });
    for (let i = 0; i < 8; i += 1) expect((await attempt('10.0.0.1', 'WrongPass9999')).status).toBe(401);
    expect((await attempt('10.0.0.1', PASSWORD)).body.error.code).toBe('ACCOUNT_LOCKED');
    expect((await attempt('10.0.0.2', PASSWORD)).status).toBe(200);
    const stored = await User.findById(admin._id).select('+lockedUntil').lean();
    expect(stored.lockedUntil).toBeUndefined();
    expect(await SecurityAlert.exists({ type: 'login_locked', severity: 'security' })).toBeTruthy();
    expect(await SecurityAlert.exists({ type: 'admin_password_failures' })).toBeTruthy();
  });
});

describe('step-up before sensitive actions', () => {
  it('without 2FA: the password, one shot per dangerous action', async () => {
    const admin = await adminUser();
    const api = await loginAs(admin);
    const need = await api.post('/api/admin/orders/clear', { confirm: 'مسح' });
    expect(need.status).toBe(403);
    expect(need.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { action: 'clearOrders', mode: 'always', method: 'password' } });
    expect((await api.post('/api/auth/step-up', { action: 'clearOrders', password: 'WrongPass9999' })).body.error.code).toBe('STEP_UP_INVALID');
    await stepUp(api, 'clearOrders');
    // A rejected request (wrong confirmation word) does not use the grant up.
    expect((await api.post('/api/admin/orders/clear', { confirm: 'x' })).status).toBe(400);
    expect((await api.post('/api/admin/orders/clear', { confirm: 'مسح' })).status).toBe(200);
    expect((await api.post('/api/admin/orders/clear', { confirm: 'مسح' })).body.error.code).toBe('STEP_UP_REQUIRED');
    // A grant is for one action only.
    await stepUp(api, 'resetCash');
    expect((await api.post('/api/admin/orders/clear', { confirm: 'مسح' })).body.error.code).toBe('STEP_UP_REQUIRED');
  });

  it('with 2FA: an authenticator code, and the 10-minute rule for the rest', async () => {
    const admin = await adminUser();
    const { api, secret } = await enableMfa(admin);
    await clearReplayGuard(admin._id);
    expect((await api.post('/api/auth/step-up', { action: 'clearOrders', password: PASSWORD })).body.error.code).toBe('STEP_UP_INVALID');
    expect((await api.post('/api/auth/step-up', { action: 'clearOrders', code: codeNow(secret) })).status).toBe(200);
    expect((await api.post('/api/admin/orders/clear', { confirm: 'مسح' })).status).toBe(200);

    await Session.updateMany({ user: admin._id }, { $set: { reauthAt: new Date(Date.now() - 11 * 60 * 1000) } });
    const setup = await api.post('/api/auth/security/2fa/setup');
    expect(setup.body.error).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { mode: 'recent', method: 'totp' } });
    expect((await api.post('/api/auth/step-up', { action: 'security', code: codeNow(secret, 1) })).status).toBe(200);
    expect((await api.post('/api/auth/security/2fa/setup')).status).toBe(200);
  });

  it('too many wrong step-up answers sign the session out', async () => {
    const admin = await adminUser();
    const api = await loginAs(admin);
    for (let i = 0; i < 4; i += 1) await api.post('/api/auth/step-up', { action: 'security', password: 'WrongPass9999' });
    expect((await api.post('/api/auth/step-up', { action: 'security', password: 'WrongPass9999' })).status).toBe(401);
    expect((await api.get('/api/auth/me')).status).toBe(401);
  });
});

describe('owner email and alerts', () => {
  it('links the email with a 6-digit code, then security alerts email at once', async () => {
    captureMail();
    const admin = await adminUser();
    const api = await loginAs(admin);
    expect((await api.post('/api/auth/security/email', { email: 'Owner@Example.com' })).status).toBe(200);
    expect(sent[0].to).toBe('owner@example.com');
    const code = sent[0].text.match(/\d{6}/)[0];
    expect((await api.post('/api/auth/security/email', { email: 'owner@example.com' })).status).toBe(429); // 1 a minute
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await api.post('/api/auth/security/email/verify', { code: wrong })).status).toBe(400);
    expect((await api.post('/api/auth/security/email/verify', { code })).status).toBe(200);
    expect((await api.get('/api/auth/security')).body.email.address).toBe('owner@example.com');
    // The link itself is a security event → immediate email to the new address.
    expect(sent.at(-1)).toMatchObject({ to: 'owner@example.com', subject: 'تنبيه أمني من نظام سوليتا' });
    expect((await api.post('/api/auth/security/email/test')).status).toBe(200);
  });

  it('without mail settings the email link reports it instead of failing silently', async () => {
    const api = await loginAs(await adminUser());
    const res = await api.post('/api/auth/security/email', { email: 'owner@example.com' });
    expect(res.body.error.code).toBe('MAIL_NOT_CONFIGURED');
  });

  it('merges repeats and sends one end-of-day digest (nothing when nothing is new)', async () => {
    captureMail();
    const admin = await adminUser();
    await AccountSecurity.create({ user: admin._id, email: 'owner@example.com', emailVerifiedAt: new Date() });
    await raiseAlert({ type: 'staff_coupons', message: 'x عدّل الكوبونات', actor: admin });
    await raiseAlert({ type: 'staff_coupons', message: 'x عدّل الكوبونات', actor: admin });
    expect(await SecurityAlert.countDocuments()).toBe(1);
    expect((await SecurityAlert.findOne().lean()).count).toBe(2);
    expect(sent).toHaveLength(0); // normal alerts wait for the digest
    expect(await sendDailyDigest()).toMatchObject({ sent: true, count: 1 });
    expect(sent[0].text).toContain('(×2)');
    expect(await sendDailyDigest()).toMatchObject({ sent: false, reason: 'NOTHING_NEW' });
    const cron = await request(getTestApp()).get('/api/cron/digest').set('Authorization', 'Bearer test-cron-secret');
    expect(cron.body).toMatchObject({ sent: false, reason: 'NOTHING_NEW' });
  });

  it('alerts on moderator money actions and refused dangerous attempts, not on the admin', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const admin = await adminUser();
    const adminApi = await loginAs(admin);
    expect((await adminApi.post('/api/admin/finance/expenses', { date: today, amount: '10', category: 'ads' })).status).toBe(201);
    expect(await SecurityAlert.countDocuments()).toBe(0);

    const mod = await createUser('moderator', { permissions: { sections: { finance: 'edit', orders: 'edit' }, dangerous: [], fields: [] } });
    const modApi = await loginAs(mod);
    expect((await modApi.post('/api/admin/finance/expenses', { date: today, amount: '10', category: 'ads' })).status).toBe(201);
    expect((await modApi.post('/api/admin/orders/clear', { confirm: 'مسح' })).status).toBe(403);
    const types = (await SecurityAlert.find().lean()).map((a) => a.type).sort();
    expect(types).toEqual(['staff_denied_dangerous', 'staff_money']);
  });

  it('the security page and alerts are administrator only', async () => {
    const mod = await createUser('moderator', { permissions: { sections: { orders: 'edit' }, dangerous: [], fields: [] } });
    const modApi = await loginAs(mod);
    expect((await modApi.get('/api/auth/security')).status).toBe(403);
    expect((await modApi.get('/api/auth/security/alerts')).status).toBe(403);
    const anon = await client();
    expect((await anon.post('/api/auth/step-up', { action: 'security', password: PASSWORD })).status).toBe(401);
  });
});

describe('local recovery script (service)', () => {
  it('reset 2FA: clears the secret and codes, signs out, password-only sign-in works', async () => {
    const admin = await adminUser();
    await enableMfa(admin);
    const result = await resetAdminMfa();
    expect(result).toMatchObject({ hadMfa: true });
    expect(await Session.countDocuments({ user: admin._id })).toBe(0);
    const sec = await AccountSecurity.findOne({ user: admin._id }).lean();
    expect(sec.totp).toBeNull();
    expect(sec.recoveryCodes).toHaveLength(0);
    const api = await loginAs(admin);
    expect((await api.get('/api/auth/me')).body.user.security.mfaEnabled).toBe(false);
    expect(await SecurityAlert.exists({ type: 'admin_mfa_reset_cli' })).toBeTruthy();
  });

  it('transfer admin: one transaction, never zero or two admins; couriers refused', async () => {
    const admin = await adminUser();
    await enableMfa(admin);
    const mod = await createUser('moderator');
    const courier = await createUser('courier');
    await expect(transferAdmin({ targetPhone: courier.phone })).rejects.toThrow(/Courier/);
    await expect(transferAdmin({ targetPhone: '01099999999' })).rejects.toThrow(/--create-target/);

    await transferAdmin({ targetPhone: mod.phone });
    expect(await User.countDocuments({ role: 'admin' })).toBe(1);
    expect((await User.findById(mod._id).lean()).role).toBe('admin');
    const old = await User.findById(admin._id).lean();
    expect(old).toMatchObject({ role: 'moderator', status: 'disabled', isActive: false });
    expect(await Session.countDocuments({ user: admin._id })).toBe(0);
    expect(await AccountSecurity.countDocuments({ user: admin._id })).toBe(0);

    await transferAdmin({ targetPhone: '01099999999', create: { name: 'مالك جديد', passwordHash: await hashPassword(PASSWORD) } });
    expect(await User.countDocuments({ role: 'admin' })).toBe(1);
    expect((await User.findOne({ role: 'admin' }).lean()).phone).toBe('01099999999');
  });
});
