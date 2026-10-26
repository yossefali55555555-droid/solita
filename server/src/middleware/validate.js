import { badRequest } from '../utils/errors.js';

/**
 * Validate request parts with Zod schemas. Parsed (and stripped) values are
 * placed on req.valid; controllers only read from req.valid, which prevents
 * mass assignment of fields that are not explicitly declared.
 */
export function validate({ body, query, params } = {}) {
  return (req, _res, next) => {
    const valid = {};
    const issues = [];
    for (const [part, schema] of Object.entries({ body, query, params })) {
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (result.success) valid[part] = result.data;
      else {
        for (const issue of result.error.issues) {
          issues.push({ location: part, path: issue.path.join('.'), message: issue.message });
        }
      }
    }
    if (issues.length) return next(badRequest('البيانات المرسلة غير صحيحة', 'VALIDATION_ERROR', issues));
    req.valid = valid;
    next();
  };
}
