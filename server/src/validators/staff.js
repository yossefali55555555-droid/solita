import { z } from 'zod';
import { ACTIVITY_GROUPS, SEVERITIES } from '../constants/activity.js';
import { DANGEROUS_KEYS, FIELD_KEYS, LEVELS, SECTION_KEYS } from '../constants/permissions.js';
import { egyptianMobile, objectId, pageQuery, password, trimmed } from './common.js';

/** Permission set as the editor sends it; the service normalizes and checks the rules (dangerous needs edit, etc.). */
export const permissionsInput = z.strictObject({
  sections: z.partialRecord(z.enum(SECTION_KEYS), z.enum([...LEVELS, 'none'])).default({}),
  dangerous: z.array(z.enum(DANGEROUS_KEYS)).default([]),
  fields: z
    .array(z.strictObject({ key: z.enum(FIELD_KEYS), until: z.union([z.null(), z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'تاريخ غير صالح')]).optional() }))
    .default([]),
});

export const createStaffBody = z
  .strictObject({
    name: trimmed(120).min(2, 'الاسم مطلوب'),
    phone: egyptianMobile,
    mode: z.enum(['password', 'invite']).default('password'),
    password: password.optional(),
    templateName: trimmed(80).optional(),
    permissions: permissionsInput.optional(),
  })
  .refine((v) => v.mode === 'password' || !v.password, { message: 'لا كلمة سر مع لينك الدعوة', path: ['password'] });

export const updateStaffBody = z
  .strictObject({
    name: trimmed(120).min(2).optional(),
    phone: egyptianMobile.optional(),
    permissions: permissionsInput.optional(),
    templateName: trimmed(80).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'لا توجد بيانات للتحديث');

export const staffStatusBody = z.strictObject({ status: z.enum(['active', 'disabled']) });
export const staffPasswordBody = z.strictObject({ newPassword: password.optional() });
export const staffFieldParams = z.object({ id: objectId, key: z.enum(FIELD_KEYS) });
export const staffSessionParams = z.object({ id: objectId, sessionId: objectId });
export const grantFieldBody = z.strictObject({
  duration: z.enum(['hour', 'day', 'week', 'custom']),
  until: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'تاريخ غير صالح').optional(),
});

export const templateBody = z.strictObject({
  name: trimmed(80).min(2, 'اسم القالب مطلوب'),
  description: trimmed(300).optional(),
  sections: z.partialRecord(z.enum(SECTION_KEYS), z.enum([...LEVELS, 'none'])).default({}),
  dangerous: z.array(z.enum(DANGEROUS_KEYS)).default([]),
  fields: z.array(z.enum(FIELD_KEYS)).default([]),
});
export const applyTemplateBody = z.strictObject({ accountIds: z.array(objectId).max(100).optional() });

export const activityQuery = z.object({
  actor: objectId.optional(),
  role: z.enum(['admin', 'moderator', 'courier']).optional(),
  group: z.enum(Object.keys(ACTIVITY_GROUPS)).optional(),
  severity: z.enum(SEVERITIES).optional(),
  from: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'تاريخ غير صالح').optional(),
  to: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'تاريخ غير صالح').optional(),
  q: trimmed(80).optional(),
  ...pageQuery,
});

export const inviteAcceptBody = z.strictObject({ token: z.string().min(20).max(200), password });

export const waClickBody = z.strictObject({
  kind: z.enum(['order', 'confirm', 'coupon', 'cart', 'missed', 'founder']),
  id: objectId,
  text: z.string().max(3000).default(''),
});

const waText = (n) => z.string().trim().min(1, 'النص مطلوب').max(n);
export const waTemplatesBody = z.strictObject({
  cartWhatsappTemplate: waText(1000),
  couponWhatsappTemplate: waText(1500),
  confirmWhatsappTemplate: waText(1500),
});
