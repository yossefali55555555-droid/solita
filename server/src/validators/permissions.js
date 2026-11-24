import { z } from 'zod';
import { DANGEROUS_KEYS, FIELD_KEYS, LEVELS, SECTION_KEYS } from '../constants/permissions.js';

/**
 * Input schemas for staff accounts (used by the account API in phase 4).
 * Layer 2 of the one-admin rule: the role field only ever accepts
 * "moderator", so no request can create or promote an administrator.
 * All objects are strict: unknown keys are rejected, never ignored.
 */

export const staffRoleInput = z.literal('moderator', { error: 'الدور غير مسموح' });

const sectionsInput = z
  .strictObject(Object.fromEntries(SECTION_KEYS.map((k) => [k, z.enum(['none', ...LEVELS]).optional()])))
  .transform((v) => Object.fromEntries(Object.entries(v).filter(([, level]) => level && level !== 'none')));

const fieldGrantInput = z.strictObject({
  key: z.enum(FIELD_KEYS),
  until: z.coerce.date().nullable().optional().default(null),
});

export const permissionsInput = z.strictObject({
  sections: sectionsInput.default({}),
  dangerous: z.array(z.enum(DANGEROUS_KEYS)).max(DANGEROUS_KEYS.length).default([])
    .transform((v) => [...new Set(v)]),
  fields: z.array(fieldGrantInput).max(FIELD_KEYS.length).default([])
    .refine((v) => new Set(v.map((g) => g.key)).size === v.length, 'تصريح مكرر'),
});
