#!/usr/bin/env node
/**
 * npm run mfa:keygen
 * Prints a new random 32-byte key for MFA_ENCRYPTION_KEY (admin 2FA).
 * Runs offline; the key is printed only in YOUR terminal. Paste it into
 * Vercel (Settings → Environment Variables, Production) and keep a copy in
 * a safe place outside the computer (a password manager or paper).
 * Losing the key means the 2FA secret can no longer be read: sign in with a
 * recovery code, or run `npm run admin:reset-2fa`.
 */
import crypto from 'node:crypto';

console.log('\nMFA_ENCRYPTION_KEY=');
console.log(crypto.randomBytes(32).toString('base64'));
console.log('\nKeep a copy outside this computer. Never send it in a chat or an email.\n');
