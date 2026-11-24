/**
 * Permission catalog for staff accounts (single source of truth).
 *
 * - The administrator has every permission implicitly; nothing is stored.
 * - A moderator holds `permissions` on the User document:
 *     sections:  { orders: 'view' | 'edit', ... }   missing key = no access
 *     dangerous: ['changeOrderStatus', ...]          keys from DANGEROUS
 *     fields:    [{ key: 'customerPhone', until: Date | null }]  until = temporary grant
 * - Couriers never hold permissions (they only use /api/courier).
 *
 * Keys are English (code); labels are Arabic (UI). Unknown keys are rejected
 * by the model and by the validators.
 */

export const LEVELS = Object.freeze(['view', 'edit']);
export const LEVEL_LABELS = Object.freeze({ none: 'بدون', view: 'مشاهدة', edit: 'تعديل' });
const LEVEL_RANK = Object.freeze({ none: 0, view: 1, edit: 2 });

/** Admin sections (sidebar pages). Order = display order. */
export const SECTIONS = Object.freeze({
  dashboard: { label: 'لوحة المتابعة' },
  orders: { label: 'الطلبات' },
  couriers: { label: 'المناديب' },
  reviews: { label: 'مراجعة التسليم' },
  warehouse: { label: 'الملصقات والمرتجعات' },
  customers: { label: 'العملاء' },
  cash: { label: 'الخزنة', lockedByDefault: true },
  finance: { label: 'الماليات', lockedByDefault: true },
  storefront: { label: 'سلوك المتجر' },
  missedOrders: { label: 'الطلبات الفائتة' },
  coupons: { label: 'الكوبونات' },
  founders: { label: 'أوائل سوليتا' },
  siteSettings: { label: 'إعدادات الموقع' },
  sync: { label: 'المزامنة والتكامل' },
});
export const SECTION_KEYS = Object.freeze(Object.keys(SECTIONS));

/**
 * Dangerous actions: a separate grant on top of "edit" on their section.
 * stepUpAlways = always needs a fresh identity confirmation (phase 3).
 */
export const DANGEROUS = Object.freeze({
  resetCash: { label: 'تصفير الخزنة', section: 'cash', stepUpAlways: true },
  resetFinance: { label: 'تصفير الماليات', section: 'finance', stepUpAlways: true },
  clearOrders: { label: 'مسح الطلبات', section: 'orders', stepUpAlways: true },
  deleteExpense: { label: 'حذف المصروفات', section: 'finance' },
  changeOrderStatus: { label: 'تغيير حالة الطلب', section: 'orders' },
  resetCourierPassword: { label: 'إعادة تعيين كلمة سر مندوب', section: 'couriers', stepUpAlways: true },
  markTest: { label: 'تعليم طلب كتجريبي', section: 'orders' },
});
export const DANGEROUS_KEYS = Object.freeze(Object.keys(DANGEROUS));

/** Field grants (data visibility). customerPhone may be granted temporarily. */
export const FIELDS = Object.freeze({
  customerPhone: { label: 'رؤية رقم العميل وأزرار واتساب', temporary: true },
  moneyFigures: { label: 'الأرقام المالية (التكلفة والربح وبيانات الشركاء)' },
  export: { label: 'التصدير إلى إكسل' },
});
export const FIELD_KEYS = Object.freeze(Object.keys(FIELDS));
/** Reserved for later (partner data is not in this system yet). Not grantable. */
export const RESERVED_FIELD_KEYS = Object.freeze(['partners']);

/** Temporary grant presets offered by the UI (phase 4). */
export const TEMPORARY_GRANT_PRESETS = Object.freeze({
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
});

/** Capabilities that are never grantable: administrator only. */
export const ADMIN_ONLY_CAPABILITIES = Object.freeze({
  accounts: 'إدارة الحسابات',
  templates: 'إدارة قوالب الصلاحيات',
  activityLog: 'سجل النشاط',
  sessions: 'الجلسات',
  twoFactor: 'التحقق بخطوتين',
  whatsappTemplates: 'تعديل نصوص واتساب الجاهزة',
  initDb: 'تهيئة قاعدة البيانات',
});

/** Initial permission templates (SPEC table b). Copied onto an account when created. */
export const DEFAULT_TEMPLATES = Object.freeze([
  {
    name: 'خدمة العملاء',
    sections: { orders: 'edit', customers: 'view', storefront: 'edit', missedOrders: 'edit', coupons: 'edit', founders: 'view', dashboard: 'view' },
    dangerous: ['changeOrderStatus'],
    fields: ['customerPhone'],
  },
  {
    name: 'مرتجعات ومخزن',
    sections: { orders: 'view', warehouse: 'edit', reviews: 'view', dashboard: 'view' },
    dangerous: [],
    fields: ['customerPhone'],
  },
  {
    name: 'متابعة المناديب',
    sections: { orders: 'edit', couriers: 'edit', reviews: 'edit', dashboard: 'view' },
    dangerous: [],
    fields: [],
  },
  {
    name: 'محاسب',
    sections: { finance: 'edit', cash: 'view', dashboard: 'view' },
    dangerous: [],
    fields: ['moneyFigures'],
  },
  {
    name: 'مشاهدة فقط',
    sections: { dashboard: 'view', orders: 'view' },
    dangerous: [],
    fields: [],
  },
]);

export function levelAtLeast(have, need) {
  return (LEVEL_RANK[have || 'none'] ?? 0) >= (LEVEL_RANK[need] ?? Infinity);
}
