import { z } from 'zod';
import {
  DELIVERY_STATUSES,
  FAILURE_REASONS,
  REMITTANCE_STATUSES,
  REVIEW_STATUSES,
} from '../constants/statuses.js';
import { egyptianMobile, isoDate, moneyInput, objectId, pageQuery, password, trimmed } from './common.js';

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
  from: isoDate.optional(),
  to: isoDate.optional(),
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
});

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
  ...pageQuery,
});

export const eligibleOrdersQuery = z.object({ courier: objectId });
