import { z } from 'zod';
import {
  DELIVERY_STATUSES,
  EXPENSE_CATEGORIES,
  FAILURE_REASONS,
  RETURN_SYNC_STATUSES,
  REMITTANCE_STATUSES,
  REVIEW_STATUSES,
} from '../constants/statuses.js';
import { egyptianMobile, isoDate, moneyInput, objectId, pageQuery, password, trimmed } from './common.js';

// Text of a scanned parcel QR code; parsed and checked by labelService.
const parcelCodeInput = z.string().trim().min(1, 'امسح كود الطرد').max(200);

// ---------- Auth ----------
export const loginBody = z.object({
  identifier: z.string().trim().min(3, 'أدخل رقم الهاتف').max(200),
  password: z.string().min(1, 'أدخل كلمة المرور').max(200),
});

export const changePasswordBody = z
  .object({ currentPassword: z.string().min(1).max(200), newPassword: password })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'كلمة المرور الجديدة يجب أن تختلف عن الحالية',
    path: ['newPassword'],
  });

// ---------- Couriers (admin) ----------
const optionalEmail = z
  .union([z.literal(''), z.email('بريد إلكتروني غير صالح').max(200)])
  .optional()
  .transform((v) => (v ? v.toLowerCase() : undefined));

export const createCourierBody = z.strictObject({
  name: trimmed(120).min(2, 'الاسم مطلوب'),
  phone: egyptianMobile,
  email: optionalEmail,
  password,
});

export const updateCourierBody = z
  .strictObject({
    name: trimmed(120).min(2).optional(),
    phone: egyptianMobile.optional(),
    email: optionalEmail.or(z.null()),
  })
  .refine((v) => Object.keys(v).length > 0, 'لا توجد بيانات للتحديث');

export const courierActiveBody = z.strictObject({ isActive: z.boolean() });

export const resetPasswordBody = z.strictObject({ newPassword: password });

export const listCouriersQuery = z.object({
  q: trimmed(100).optional(),
  active: z.enum(['true', 'false']).optional(),
  ...pageQuery,
});

// ---------- Orders (admin) ----------
export const listOrdersQuery = z.object({
  q: trimmed(100).optional(),
  sourceStatus: trimmed(60).optional(),
  deliveryStatus: z.enum(DELIVERY_STATUSES).optional(),
  courier: z.union([objectId, z.literal('unassigned')]).optional(),
  syncState: z.enum(['none', 'pending', 'synced', 'failed']).optional(),
  // Orders waiting for data confirmation (EasyOrders status `pending`).
  unconfirmed: z.enum(['true']).optional(),
  couponFlagged: z.enum(['true']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  // Orders cleared from the dashboard: hidden by default.
  cleared: z.enum(['hide', 'include', 'only']).optional(),
  // Admin-marked test orders: hidden by default.
  test: z.enum(['include', 'only']).optional(),
  ...pageQuery,
});

export const assignmentBody = z.strictObject({
  courierId: objectId.nullable(),
  note: trimmed(500).optional(),
});

export const adminStatusBody = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('cancelled'),
    reason: trimmed(1000).min(3, 'سبب الإلغاء مطلوب'),
    syncToEasyOrders: z.boolean().default(false),
  }),
  z.strictObject({
    status: z.literal('new'),
    reason: trimmed(1000).min(3, 'سبب إعادة الفتح مطلوب'),
  }),
]);

export const noteBody = z.strictObject({
  text: trimmed(1000).min(1, 'اكتب الملاحظة'),
  type: z.enum(['public', 'private']),
});

export const testFlagBody = z.strictObject({ isTest: z.boolean() });

export const bulkOrdersBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('mark_test'), ids: z.array(objectId).min(1).max(100) }),
  z.strictObject({ action: z.literal('unmark_test'), ids: z.array(objectId).min(1).max(100) }),
  z.strictObject({ action: z.literal('hide'), ids: z.array(objectId).min(1).max(100) }),
  z.strictObject({ action: z.literal('unassign'), ids: z.array(objectId).min(1).max(100) }),
  z.strictObject({ action: z.literal('assign'), ids: z.array(objectId).min(1).max(100), courierId: objectId }),
  z.strictObject({
    action: z.literal('cancel'),
    ids: z.array(objectId).min(1).max(100),
    reason: trimmed(1000).min(3, 'سبب الإلغاء مطلوب'),
    syncToEasyOrders: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal('reopen'),
    ids: z.array(objectId).min(1).max(100),
    reason: trimmed(1000).min(3, 'سبب إعادة الفتح مطلوب'),
  }),
]);

// ---------- Delivery reviews (admin) ----------
export const listReviewsQuery = z.object({
  status: z.enum(REVIEW_STATUSES).optional(),
  courier: objectId.optional(),
  ...pageQuery,
});

export const rejectReviewBody = z.strictObject({
  reason: trimmed(1000).min(3, 'سبب الرفض مطلوب'),
});

// ---------- Sync (admin) ----------
export const listSyncFailuresQuery = z.object({ ...pageQuery });

// ---------- Courier ----------
export const courierOrdersQuery = z.object({
  scope: z.enum(['active', 'review', 'completed', 'all']).default('active'),
  ...pageQuery,
});

export const courierStatusBody = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('out_for_delivery') }),
  z
    .strictObject({
      status: z.literal('failed'),
      reason: z.enum(FAILURE_REASONS, { message: 'اختر سبب فشل التسليم' }),
      note: trimmed(1000).optional(),
      parcelCode: parcelCodeInput.optional(),
    })
    .refine((v) => v.reason !== 'other' || (v.note && v.note.length >= 3), {
      message: 'اكتب توضيحاً عند اختيار "سبب آخر"',
      path: ['note'],
    }),
]);

export const deliveryReportBody = z.strictObject({
  collectedAmount: moneyInput.optional(),
  note: trimmed(1000).optional(),
  proofReference: trimmed(300).optional(),
  parcelCode: parcelCodeInput.optional(),
});

// ---------- Labels and parcel scans ----------
export const labelQueueQuery = z.object({
  tab: z.enum(['pending', 'reprint', 'printed']).default('pending'),
  ...pageQuery,
});

export const printLabelsBody = z.strictObject({
  orderIds: z.array(objectId).min(1, 'اختر طلباً واحداً على الأقل').max(40, 'الحد الأقصى 40 طلباً في المرة الواحدة'),
});

export const getLabelsQuery = z.object({
  ids: z
    .string()
    .trim()
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(objectId).min(1).max(40)),
});

export const scanBody = z.strictObject({ code: parcelCodeInput });

// ---------- Cash ----------
export const courierDeclareRemittanceBody = z.strictObject({
  orderIds: z.array(objectId).min(1, 'اختر طلباً واحداً على الأقل').max(200),
  declaredAmount: moneyInput,
  notes: trimmed(2000).optional(),
});

export const adminCreateRemittanceBody = z.strictObject({
  courierId: objectId,
  orderIds: z.array(objectId).min(1, 'اختر طلباً واحداً على الأقل').max(200),
  handedOverAmount: moneyInput,
  notes: trimmed(2000).optional(),
});

export const receiveRemittanceBody = z.strictObject({
  handedOverAmount: moneyInput,
  notes: trimmed(2000).optional(),
});

export const verifyRemittanceBody = z.strictObject({
  verifiedAmount: moneyInput,
  notes: trimmed(2000).optional(),
});

export const cancelRemittanceBody = z.strictObject({
  reason: trimmed(1000).min(3, 'سبب الإلغاء مطلوب'),
});

export const listRemittancesQuery = z.object({
  status: z.enum(REMITTANCE_STATUSES).optional(),
  courier: objectId.optional(),
  // Remittances from before the cash reset are hidden unless asked for.
  beforeReset: z.enum(['true', 'false']).optional(),
  ...pageQuery,
});

// Typing the confirmation word protects these dashboard-wide actions from a misclick.
export const clearOrdersBody = z.strictObject({ confirm: z.literal('مسح', { error: 'اكتب كلمة "مسح" للتأكيد' }) });
export const cashResetBody = z.strictObject({ confirm: z.literal('تصفير', { error: 'اكتب كلمة "تصفير" للتأكيد' }) });

export const eligibleOrdersQuery = z.object({ courier: objectId });

// ---------- EasyOrders pull sync (admin) ----------
// Either the numeric order number (short_id) or the EasyOrders order id.
export const importOrderBody = z
  .strictObject({
    shortId: z.coerce.number().int('رقم الطلب يجب أن يكون رقماً صحيحاً').positive('رقم الطلب غير صالح').max(1e12).optional(),
    orderId: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9-]+$/, 'معرّف الطلب غير صالح').optional(),
  })
  .refine((v) => Boolean(v.shortId) !== Boolean(v.orderId), { message: 'أدخل رقم الطلب', path: ['shortId'] });

// ---------- Returns review (admin) ----------
export const listReturnsQuery = z.object({
  status: z.enum(['pending', 'returned']).default('pending'),
  ...pageQuery,
});

export const confirmReturnBody = z.strictObject({
  reason: trimmed(1000).optional(),
  easyOrdersStatus: z.enum([...RETURN_SYNC_STATUSES, 'none']).default('returning_from_delivery'),
});

// ---------- Customers (admin) ----------
export const listCustomersQuery = z.object({
  q: trimmed(100).optional(),
  sort: z.enum(['recent', 'orders', 'spent', 'returns']).default('recent'),
  ...pageQuery,
});

// Meta Ads file (customer list or offline purchases). Dates are ISO strings from the page.
export const metaExportQuery = z.object({
  mode: z.enum(['customers', 'orders']).default('customers'),
  from: isoDate.optional(),
  to: isoDate.optional(),
  minOrders: z.coerce.number().int().min(1).max(100).default(1),
  includeReturned: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  hash: z.enum(['none', 'sha256']).default('none'),
});

// Opaque key (c_…) from the customer list; a raw key (the phone) is accepted only for viewers who may see numbers.
export const customerKeyParams = z.object({ key: z.string().trim().min(1).max(700) });

// ---------- Expenses & profit (admin) ----------
// A calendar day (YYYY-MM-DD), stored at 12:00 UTC so it never shifts a day.
const calendarDay = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'التاريخ غير صالح')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T12:00:00Z`)), 'التاريخ غير صالح')
  .transform((v) => new Date(`${v}T12:00:00Z`));

const expenseFields = {
  date: calendarDay,
  amount: moneyInput.refine((v) => v > 0, 'المبلغ يجب أن يكون أكبر من صفر'),
  category: z.enum(EXPENSE_CATEGORIES, { message: 'اختر نوع المصروف' }),
  description: trimmed(1000).optional(),
  invoiceNumber: trimmed(100).optional(),
  vendor: trimmed(200).optional(),
};

export const createExpenseBody = z
  .strictObject(expenseFields)
  .refine((v) => v.category !== 'other' || (v.description && v.description.length >= 2), {
    message: 'اكتب وصفاً للمصروف عند اختيار "أخرى"',
    path: ['description'],
  });

export const updateExpenseBody = z
  .strictObject({
    date: expenseFields.date.optional(),
    amount: expenseFields.amount.optional(),
    category: expenseFields.category.optional(),
    description: expenseFields.description,
    invoiceNumber: expenseFields.invoiceNumber,
    vendor: expenseFields.vendor,
  })
  .refine((v) => Object.keys(v).length > 0, 'لا توجد بيانات للتحديث');

export const deleteExpenseBody = z.strictObject({ reason: trimmed(500).optional() });

export const listExpensesQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  // Invoices entered before the profit reset are hidden unless asked for.
  beforeReset: z.enum(['true', 'false']).optional(),
  ...pageQuery,
});

export const financeResetBody = z.strictObject({ confirm: z.literal('تصفير', { error: 'اكتب كلمة "تصفير" للتأكيد' }) });

export const profitQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

// ---------------- Admin security (moderators phase 3) ----------------
const codeField = z.string().trim().min(6, 'أدخل الكود').max(40);
export const mfaCodeBody = z.object({ code: codeField });
export const stepUpBody = z
  .object({
    action: z.string().trim().min(1).max(60),
    code: z.string().trim().max(40).optional(),
    password: z.string().max(200).optional(),
  })
  .refine((v) => v.code || v.password, { message: 'أدخل الكود أو كلمة المرور', path: ['code'] });
export const securityEmailBody = z.object({
  email: z.email('أدخل إيميلًا صحيحًا').max(200).transform((v) => v.trim().toLowerCase()),
});
