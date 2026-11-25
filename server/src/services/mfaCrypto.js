import crypto from 'node:crypto';
import { getConfig } from '../config/env.js';
import { sha256 } from '../utils/sanitize.js';

/**
 * Building blocks for the administrator's 2FA (moderators phase 3, SPEC (هـ)):
 *  - TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30 s steps), checked with ±1 step.
 *  - AES-256-GCM encryption of the TOTP secret with a versioned key that
 *    lives only in an environment variable (MFA_ENCRYPTION_KEY).
 *  - One-time recovery codes, stored as SHA-256 hashes only.
 * No external dependency: node:crypto only.
 */

export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
export const ISSUER = 'Solita';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random TOTP secret (160 bits), base32. */
export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / TOTP_PERIOD_S);
}

export function totpForStep(secretBase32, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(bin).padStart(TOTP_DIGITS, '0');
}

/**
 * The matching time step for `code` within ±1 step of now, or null.
 * The caller rejects a step that is not newer than the last accepted one.
 */
export function matchTotp(secretBase32, code, now = Date.now()) {
  const value = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(value)) return null;
  const step = currentStep(now);
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d += 1) {
    const candidate = totpForStep(secretBase32, step + d);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(value))) return step + d;
  }
  return null;
}

export function otpauthUri(secretBase32, accountLabel) {
  const label = encodeURIComponent(`${ISSUER}:${accountLabel}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer: ISSUER, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_S) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------- Encryption of the secret ----------------

export function mfaKeyStatus() {
  const { key, keyVersion, keyProblem } = getConfig().mfa;
  return { available: Boolean(key), keyVersion, problem: keyProblem };
}

/** "v<version>.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encryptSecret(plain) {
  const { key, keyVersion } = getConfig().mfa;
  if (!key) throw new Error('MFA_ENCRYPTION_KEY is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`solita-totp-v${keyVersion}`));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: `v${keyVersion}.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`, keyVersion };
}

/** The plain secret, or null when the key is missing, wrong or rotated. */
export function decryptSecret(enc) {
  const { key, keyVersion } = getConfig().mfa;
  if (!key || typeof enc !== 'string') return null;
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== `v${keyVersion}` || !iv || !tag || !ct) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`solita-totp-v${keyVersion}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------- Recovery codes ----------------

export const RECOVERY_CODE_COUNT = 10;
// 16 symbols from a 32-letter alphabet without 0/O/1/I = 80 bits each.
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function looksLikeRecoveryCode(code) {
  return normalizeRecoveryCode(code).length === 16;
}

export function hashRecoveryCode(code) {
  return sha256(`solita-recovery:${normalizeRecoveryCode(code)}`);
}

/** { codes: ['ABCD-EFGH-JKLM-NPQR', ...] (shown once), hashes: [...] (stored) } */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = crypto.randomBytes(16);
    let raw = '';
    for (const b of bytes) raw += RC_ALPHABET[b & 31];
    codes.push(raw.match(/.{4}/g).join('-'));
  }
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

/** 6-digit email verification code. */
export function generateEmailCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}
