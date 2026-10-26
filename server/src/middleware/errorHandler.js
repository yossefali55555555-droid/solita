import mongoose from 'mongoose';
import { AppError, isDuplicateKeyError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
 
export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'المسار غير موجود' } });
}
 
/**
 * Centralized error handler. Only AppError messages reach the client; any
 * other error is logged (sanitized) and reported as a generic failure so
 * internal details and database errors never leak.
 */
export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;
 
  if (err instanceof AppError) {
    const body = { error: { code: err.code, message: err.message } };
    if (err.details) body.error.details = err.details;
    return res.status(err.status).json(body);
  }
 
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'حجم الطلب كبير جداً' } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'صيغة البيانات غير صحيحة' } });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ error: { code: 'INVALID_ID', message: 'معرّف غير صالح' } });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'البيانات المرسلة غير صحيحة' } });
  }
  if (isDuplicateKeyError(err)) {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'هذا السجل موجود بالفعل' } });
  }
  if (isDatabaseUnavailable(err)) {
    logger.error('Database unavailable', { path: req.path, name: err.name, error: err.message });
    return res.status(503).json({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'تعذر الاتصال بقاعدة البيانات. راجع MONGODB_URI و Network Access في Atlas (التفاصيل في نافذة الخادم).',
      },
    });
  }
 
  logger.error('Unhandled error', { path: req.path, method: req.method, error: err?.message, name: err?.name });
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'حدث خطأ غير متوقع' } });
}
 
export function isDatabaseUnavailable(err) {
  const name = err?.name || '';
  return (
    name === 'MongoServerSelectionError' ||
    name === 'MongooseServerSelectionError' ||
    // Wrong Atlas username/password (code 18 = AuthenticationFailed).
    err?.code === 18 ||
    name === 'MongoNetworkError' ||
    name === 'MongoNotConnectedError' ||
    name === 'MongoNetworkTimeoutError' ||
    /buffering timed out|MONGODB_URI is not configured|querySrv|bad auth|Authentication failed/.test(err?.message || '')
  );
}
 