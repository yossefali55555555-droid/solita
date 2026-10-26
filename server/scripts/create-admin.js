#!/usr/bin/env node
/**
 * npm run admin:create                 interactive (password typed hidden)
 * npm run admin:create -- --reset-password   reset the password of an existing admin
 *
 * Non-interactive alternative (e.g. CI), all validated:
 *   ADMIN_NAME, ADMIN_PHONE, ADMIN_EMAIL (optional), ADMIN_PASSWORD
 *
 * Rules:
 *  - The password is hashed with Argon2id and never printed.
 *  - An existing courier account is NEVER promoted to administrator.
 *  - An existing admin is left untouched unless --reset-password is given.
 */
import readline from 'node:readline';
import { z } from 'zod';
import { ConfigError, getConfig } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/db/connect.js';
import { initDatabase } from '../src/db/initDatabase.js';
import { User } from '../src/models/index.js';
import { hashPassword } from '../src/services/passwordService.js';
import { recordEvent, SYSTEM_ACTOR } from '../src/services/auditService.js';
import { egyptianMobile, password as passwordSchema } from '../src/validators/common.js';

const resetPassword = process.argv.includes('--reset-password');

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

async function main() {
  const config = getConfig();
  if (config.mockMode) throw new Error('admin:create must run against a real MongoDB (MOCK_MODE is enabled).');

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
    throw new Error('This phone number belongs to a courier account. Couriers are never promoted to administrators. Use a different number.');
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
