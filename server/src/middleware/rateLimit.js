import { rateLimit } from 'express-rate-limit';
import { RateLimitCounter } from '../models/index.js';

/**
 * express-rate-limit store backed by MongoDB, so limits hold across
 * serverless instances (an in-memory store would reset on every cold start
 * and is not shared between concurrent instances).
 */
export class MongoRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  key(k) {
    return `${this.prefix}:${k}`;
  }

  async get(key) {
    const doc = await RateLimitCounter.findOne({ key: this.key(key), resetAt: { $gt: new Date() } }).lean();
    return doc ? { totalHits: doc.count, resetTime: doc.resetAt } : undefined;
  }

  async increment(key) {
    const now = new Date();
    const id = this.key(key);
    // Reset an expired window first, then increment atomically.
    await RateLimitCounter.updateOne(
      { key: id, resetAt: { $lte: now } },
      { $set: { count: 0, resetAt: new Date(now.getTime() + this.windowMs) } },
    );
    try {
      const doc = await RateLimitCounter.findOneAndUpdate(
        { key: id },
        { $inc: { count: 1 }, $setOnInsert: { resetAt: new Date(now.getTime() + this.windowMs) } },
        { upsert: true, returnDocument: 'after' },
      ).lean();
      return { totalHits: doc.count, resetTime: doc.resetAt };
    } catch (err) {
      if (err?.code === 11000) return this.increment(key); // concurrent upsert race
      throw err;
    }
  }

  async decrement(key) {
    await RateLimitCounter.updateOne({ key: this.key(key), count: { $gt: 0 } }, { $inc: { count: -1 } });
  }

  async resetKey(key) {
    await RateLimitCounter.deleteOne({ key: this.key(key) });
  }
}

const tooMany = (message) => ({ error: { code: 'RATE_LIMITED', message } });

export function loginRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    store: new MongoRateLimitStore('login'),
    message: tooMany('محاولات تسجيل دخول كثيرة. انتظر 15 دقيقة ثم حاول مرة أخرى.'),
    passOnStoreError: false,
  });
}

export function webhookRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: new MongoRateLimitStore('webhook'),
    message: tooMany('Too many requests'),
    passOnStoreError: true,
  });
}

export function apiRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: new MongoRateLimitStore('api'),
    message: tooMany('طلبات كثيرة جداً، حاول بعد قليل.'),
    passOnStoreError: true,
  });
}
