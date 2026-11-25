import { MongoRateLimitStore } from '../middleware/rateLimit.js';

/**
 * Small windowed counters on the shared RateLimitCounter collection (works
 * across serverless instances). Used for the admin lockout per account + IP
 * and the 2FA / step-up / email limits.
 */
const stores = new Map();
function store(windowMs) {
  if (!stores.has(windowMs)) {
    const s = new MongoRateLimitStore('sec');
    s.init({ windowMs });
    stores.set(windowMs, s);
  }
  return stores.get(windowMs);
}

/** Add one; returns the count in the current window. */
export async function bumpCounter(key, windowMs) {
  return (await store(windowMs).increment(key)).totalHits;
}

export async function readCounter(key, windowMs) {
  return (await store(windowMs).get(key))?.totalHits || 0;
}

export async function clearCounter(key, windowMs) {
  await store(windowMs).resetKey(key);
}
