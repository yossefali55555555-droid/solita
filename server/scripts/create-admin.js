#!/usr/bin/env node
/**
 * npm run admin:create                 interactive (password typed hidden)
 * npm run admin:create -- --reset-password   reset the password of an existing admin
 *
 * Recovery (moderators phase 3, owner's computer only, no HTTP endpoint):
 * npm run admin:reset-2fa              clear the admin's 2FA + recovery codes, sign out everywhere
 * npm run admin:transfer               make another account the administrator (one transaction)
 * npm run admin:transfer -- --create-target   ...creating that account when it does not exist
 *   Non-interactive: RECOVERY_CONFIRM=yes, TARGET_PHONE, TARGET_NAME, TARGET_PASSWORD
 *
 * Non-interactive alternative (e.g. CI), all validated:
 *   ADMIN_NAME, ADMIN_PHONE, ADMIN_EMAIL (optional), ADMIN_PASSWORD
 *
 * Rules:
 *  - The password is hashed with Argon2id and never printed.
 *  - An existing courier account is NEVER promoted to administrator.
 *  - An existing admin is left untouched unless --reset-password is given.
 *  - Only one administrator may exist (moderators phase 1): creating a second one is refused.
 */
import '../src/config/loadEnv.js';
import readline from 'node:readline';
import { z } from 'zod';
import { ConfigError, getConfig } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { initDatabase } from '../src/db/initDatabase.js';
import { User } from '../src/models/index.js';
import { hashPassword } from '../src/services/passwordService.js';
import { recordEvent, SYSTEM_ACTOR } from '../src/services/auditService.js';
import { egyptianMobile, password as passwordSchema } from '../src/validators/common.js';
import { resetAdminMfa, transferAdmin } from '../src/services/adminRecoveryService.js';

const resetPassword = process.argv.includes('--reset-password');
const reset2fa = process.argv.includes('--reset-2fa');
const transfer = process.argv.includes('--transfer-admin');
const createTarget = process.argv.includes('--create-target');

const inputSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
  phone: egyptianMobile,
  email: z.union([z.literal(''), z.email()]).optional().transform((v) => (v ? v.toLowerCase() : undefined)),
  password: passwordSchema,
});

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl.output;
    rl._writeToOutput = (chunk) => {
      if (chunk.includes(question)) output.write(chunk);
      else output.write('*'.repeat(Math.min(chunk.length, 1)));
    };
    rl.question(question, (answer) => {
      rl.close();
      output.write('\n');
      resolve(answer);
    });
  });
}

async function collectInput() {
  const fromEnv = process.env.ADMIN_PHONE || process.env.ADMIN_PASSWORD;
  if (fromEnv) {
    return {
      name: process.env.ADMIN_NAME || '',
      phone: process.env.ADMIN_PHONE || '',
      email: process.env.ADMIN_EMAIL || '',
      password: process.env.ADMIN_PASSWORD || '',
    };
  }
  if (!process.stdin.isTTY) {
    throw new Error('No terminal available. Run interactively or set ADMIN_NAME, ADMIN_PHONE and ADMIN_PASSWORD.');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const name = resetPassword ? 'unused' : await ask(rl, 'Administrator name: ');
  const phone = await ask(rl, 'Mobile number (01xxxxxxxxx): ');
  const email = resetPassword ? '' : await ask(rl, 'Email (optional): ');
  rl.close();
  const password = await askHidden('Password (min 10 chars, letters and digits): ');
  const confirm = await askHidden('Confirm password: ');
  if (password !== confirm) throw new Error('Passwords do not match.');
  return { name, phone, email, password };
}

/** Which database this run will change (host only, never the password). */
function databaseLabel(uri) {
  try {
    const u = new URL(uri);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return 'unknown host';
  }
}

async function confirmRecovery(word, summary) {
  console.log(summary);
  if (process.env.RECOVERY_CONFIRM === 'yes') return;
  if (!process.stdin.isTTY) throw new Error('No terminal available. Set RECOVERY_CONFIRM=yes to run without a prompt.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await ask(rl, `Type ${word} to continue: `);
  rl.close();
  if (answer !== word) throw new Error('Cancelled. Nothing was changed.');
}

async function runReset2fa(config) {
  await confirmRecovery(
    'RESET',
    [
      '',
      `Reset the administrator's 2FA on database ${databaseLabel(config.mongodbUri)}:`,
      ' - the authenticator secret and all recovery codes are deleted',
      ' - every session of the admin is signed out',
      ' - after this the admin signs in with the password only; set 2FA up again at once',
      '',
    ].join('\n'),
  );
  await connectDb();
  const result = await resetAdminMfa();
  console.log(
    `Done. 2FA of ${result.admin.name} (${result.admin.phone}) was ${result.hadMfa ? 'reset' : 'already off'}; ` +
      `${result.sessionsRevoked} session(s) signed out. Sign in and open «الأمان والتنبيهات» to set it up again.`,
  );
}

async function runTransfer(config) {
  let targetPhone = process.env.TARGET_PHONE || '';
  let name = process.env.TARGET_NAME || '';
  let password = process.env.TARGET_PASSWORD || '';
  if (!targetPhone) {
    if (!process.stdin.isTTY) throw new Error('No terminal available. Set TARGET_PHONE.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    targetPhone = await ask(rl, 'Phone of the account that becomes administrator (01xxxxxxxxx): ');
    if (createTarget) name = await ask(rl, 'Name (only used if the account is created): ');
    rl.close();
    if (createTarget) password = await askHidden('Password for a new account (min 10 chars, letters and digits): ');
  }
  const phone = egyptianMobile.safeParse(targetPhone);
  if (!phone.success) throw new Error('Invalid phone number.');
  let create = null;
  if (createTarget) {
    const parsed = inputSchema.pick({ name: true, password: true }).safeParse({ name, password });
    if (!parsed.success) throw new Error(`Invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    create = { name: parsed.data.name, passwordHash: await hashPassword(parsed.data.password) };
  }
  await confirmRecovery(
    'TRANSFER',
    [
      '',
      `Transfer the administrator role on database ${databaseLabel(config.mongodbUri)} to ${phone.data}:`,
      ' - the current admin becomes a disabled moderator with no permissions',
      ' - both accounts are signed out everywhere and start without 2FA',
      '',
    ].join('\n'),
  );
  await connectDb();
  const { from, to } = await transferAdmin({ targetPhone: phone.data, create });
  console.log(`Done. Administrator is now ${to.name} (${to.phone}); ${from.name} (${from.phone}) is a disabled moderator.`);
}

async function main() {
  const config = getConfig();
  if (config.mockMode) throw new Error('admin:create must run against a real MongoDB (MOCK_MODE is enabled).');
  if (reset2fa) return runReset2fa(config);
  if (transfer) return runTransfer(config);

  const raw = await collectInput();
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid input:\n - ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n - ')}`);
  }
  const input = parsed.data;

  await connectDb();
  await initDatabase();

  const existing = await User.findOne({ phone: input.phone });
  if (existing && existing.role !== 'admin') {
    throw new Error('This phone number belongs to a courier or moderator account. Such accounts are never promoted to administrator. Use a different number.');
  }
  if (existing) {
    if (!resetPassword) {
      console.log('An administrator with this phone number already exists. Nothing was changed.');
      console.log('To set a new password run: npm run admin:create -- --reset-password');
      return;
    }
    existing.passwordHash = await hashPassword(input.password);
    existing.passwordChangedAt = new Date();
    existing.isActive = true;
    await existing.save();
    await recordEvent({ subjectUser: existing._id, type: 'admin_password_reset_cli', actor: SYSTEM_ACTOR });
    console.log(`Password updated for administrator ${existing.name} (${existing.phone}). Existing sessions are now invalid.`);
    return;
  }
  if (resetPassword) throw new Error('No administrator with this phone number exists.');

  const otherAdmin = await User.findOne({ role: 'admin' }).select('name').lean();
  if (otherAdmin) {
    throw new Error(`An administrator already exists (${otherAdmin.name}). Only one administrator is allowed. To reset its password run: npm run admin:create -- --reset-password`);
  }
  if (input.email && (await User.exists({ email: input.email }))) {
    throw new Error('This email is already used by another account.');
  }
  const admin = await User.create({
    name: input.name,
    phone: input.phone,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    role: 'admin',
    isActive: true,
  });
  await recordEvent({ subjectUser: admin._id, type: 'admin_created_cli', actor: SYSTEM_ACTOR, next: { name: admin.name } });
  console.log(`Administrator created: ${admin.name} (${admin.phone}).`);
}

main()
  .catch((err) => {
    if (err instanceof ConfigError) console.error(err.message);
    else console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb().catch(() => {}));
