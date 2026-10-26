/**
 * Application error with a stable machine-readable code and a user-facing
 * (Arabic) message. Only AppError messages are ever returned to clients;
 * unexpected errors are reported as a generic 500.
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = 'طلب غير صالح', code = 'BAD_REQUEST', details) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'يجب تسجيل الدخول أولاً', code = 'UNAUTHENTICATED') =>
  new AppError(401, code, message);
export const forbidden = (message = 'غير مسموح لك بتنفيذ هذا الإجراء', code = 'FORBIDDEN') =>
  new AppError(403, code, message);
export const notFound = (message = 'العنصر غير موجود', code = 'NOT_FOUND') =>
  new AppError(404, code, message);
export const conflict = (message = 'تعارض في حالة البيانات، يرجى التحديث والمحاولة مرة أخرى', code = 'CONFLICT', details) =>
  new AppError(409, code, message, details);
export const unprocessable = (message, code = 'INVALID_STATE', details) =>
  new AppError(422, code, message, details);
export const serviceUnavailable = (message = 'الخدمة غير متاحة حالياً', code = 'SERVICE_UNAVAILABLE') =>
  new AppError(503, code, message);

export function isDuplicateKeyError(err) {
  return Boolean(err && (err.code === 11000 || err.code === 11001));
}
