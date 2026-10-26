import argon2 from 'argon2';

// OWASP-recommended Argon2id parameters (m=19 MiB, t=2, p=1) or stronger.
const OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});

export const PASSWORD_MIN_LENGTH = 10;

export async function hashPassword(plain) {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash, plain) {
  if (!hash || typeof plain !== 'string') return false;
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// Used to spend comparable time when the account does not exist.
let dummyHashPromise = null;
export async function verifyAgainstDummy(plain) {
  dummyHashPromise ||= argon2.hash('solita-dummy-password-for-timing', OPTIONS);
  await verifyPassword(await dummyHashPromise, plain);
  return false;
}
