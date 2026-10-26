import { z } from 'zod';
import { toMinor } from '../utils/money.js';
import { EGYPT_MOBILE_REGEX, normalizePhone } from '../utils/phone.js';
import { PASSWORD_MIN_LENGTH } from '../services/passwordService.js';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'معرّف غير صالح');

export const idParams = z.object({ id: objectId });

export const pageQuery = {
  page: z.coerce.number().int().min(1).max(100000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
};

export const trimmed = (max) => z.string().trim().max(max);

export const egyptianMobile = z
  .string()
  .trim()
  .max(30)
  .transform(normalizePhone)
  .refine((v) => EGYPT_MOBILE_REGEX.test(v), 'رقم الهاتف يجب أن يكون رقم موبايل مصري صحيح (01xxxxxxxxx)');

export const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `كلمة المرور يجب ألا تقل عن ${PASSWORD_MIN_LENGTH} أحرف`)
  .max(200, 'كلمة المرور طويلة جداً')
  .refine((v) => /[A-Za-z؀-ۿ]/.test(v) && /\d/.test(v), 'كلمة المرور يجب أن تحتوي على حروف وأرقام');

/** Money input in EGP (number or decimal string, max 2 decimals) → integer piasters. */
export const moneyInput = z
  .union([z.number(), z.string().trim()])
  .refine((v) => /^\d{1,9}(\.\d{1,2})?$/.test(String(v)), 'المبلغ غير صحيح (حتى رقمين عشريين)')
  .transform((v) => toMinor(v));

export const isoDate = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'تاريخ غير صالح')
  .transform((v) => new Date(v));
