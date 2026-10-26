import crypto from 'node:crypto';

const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|hash/i;
const MAX_STRING = 500;
const MAX_DEPTH = 5;
const MAX_KEYS = 50;

/**
 * Produce a copy of arbitrary metadata that is safe to persist in the audit
 * trail or return in error details: sensitive keys are redacted, strings are
 * truncated and nesting/size is bounded. Keys starting with "$" are dropped.
 */
export function sanitizeMetadata(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value;
  if (typeof value === 'object' && typeof value.toHexString === 'function') return value.toHexString();
  if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((v) => sanitizeMetadata(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
      if (key.startsWith('$')) continue;
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeMetadata(value[key], depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Short, safe description of an error for storage (no stack, no secrets). */
export function sanitizeError(err) {
  if (!err) return null;
  const message = String(err.message || err).replace(/Api-Key[^,\s]*/gi, '[redacted]');
  return message.length > MAX_STRING ? `${message.slice(0, MAX_STRING)}…` : message;
}

/** Deterministic JSON (sorted keys) used for payload hashing. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
    .join(',')}}`;
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Constant-time string comparison (hashes first so lengths never leak). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
