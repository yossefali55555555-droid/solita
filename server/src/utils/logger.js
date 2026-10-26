import { sanitizeMetadata } from './sanitize.js';

/**
 * Minimal structured logger. Metadata is always sanitized so secrets,
 * passwords and tokens never reach the logs. Silent during tests unless
 * LOG_IN_TESTS=true.
 */
const silent = () => process.env.NODE_ENV === 'test' && process.env.LOG_IN_TESTS !== 'true';

function write(level, message, meta) {
  if (silent()) return;
  const line = { level, time: new Date().toISOString(), message };
  if (meta !== undefined) line.meta = sanitizeMetadata(meta);
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const logger = {
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
