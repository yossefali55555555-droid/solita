/**
 * Staff activity log vocabulary (SPEC (ز)).
 *
 * Every row is one short Arabic sentence written when the action happens
 * (neutral verbal noun, so it works for any gender), plus structured fields.
 * Severity decides how long a row is kept (TTL on `expiresAt`).
 */

export const SEVERITIES = Object.freeze(['normal', 'danger', 'security']);
export const SEVERITY_LABELS = Object.freeze({ normal: 'عادي', danger: 'خطر', security: 'أمني' });

/** Days a row is kept. Ordinary rows 90 days, dangerous and security rows a year. */
export const RETENTION_DAYS = Object.freeze({ normal: 90, danger: 365, security: 365 });

/** Bump when the wording of sentences changes (stored on each row). */
export const SENTENCE_VERSION = 1;

/** Groups used by the activity page filter (the prefix of the action key). */
export const ACTIVITY_GROUPS = Object.freeze({
  auth: 'الدخول وكلمة السر',
  account: 'إدارة الحسابات',
  order: 'الطلبات',
  courier: 'المناديب',
  delivery: 'التسليم والمرتجعات',
  cash: 'الخزنة',
  finance: 'الماليات',
  coupon: 'الكوبونات',
  whatsapp: 'واتساب',
  storefront: 'المتجر والطلبات الفائتة',
  settings: 'الإعدادات',
  export: 'التصدير',
  sync: 'المزامنة',
  other: 'أخرى',
});

export const ACTIVITY_TARGET_TYPES = Object.freeze(['order', 'customer', 'courier', 'user', 'coupon', 'expense', 'remittance', 'cart', 'missed', 'founder', 'template', 'setting', 'review', 'other']);

export const DELIVERY_STATUS_AR = Object.freeze({
  new: 'جديد',
  assigned: 'مُسند',
  out_for_delivery: 'قيد الشحن',
  pending_delivery_review: 'بانتظار المراجعة',
  delivered: 'تم التسليم',
  failed: 'فشل التسليم',
  cancelled: 'ملغي',
  returned: 'مرتجع',
});

export const ACCOUNT_STATUS_AR = Object.freeze({ active: 'مفعّل', invited: 'مدعو', disabled: 'موقوف' });

export const SECTION_LEVEL_AR = Object.freeze({ none: 'بدون', view: 'مشاهدة', edit: 'تعديل' });
