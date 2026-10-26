import { OrderEvent } from '../models/index.js';
import { sanitizeMetadata } from '../utils/sanitize.js';

export const SYSTEM_ACTOR = Object.freeze({ kind: 'system' });
export const EASYORDERS_ACTOR = Object.freeze({ kind: 'easyorders' });

export function userActor(user) {
  return { kind: 'user', user: user._id, role: user.role, name: user.name };
}

/** Append an audit event. Metadata and values are sanitized before storage. */
export async function recordEvent({
  order = null,
  remittance = null,
  subjectUser = null,
  type,
  actor,
  previous,
  next,
  reason,
  syncOutcome,
  metadata,
}) {
  return OrderEvent.create({
    order,
    remittance,
    subjectUser,
    type,
    actor,
    previous: previous === undefined ? undefined : sanitizeMetadata(previous),
    next: next === undefined ? undefined : sanitizeMetadata(next),
    reason,
    syncOutcome,
    metadata: metadata === undefined ? undefined : sanitizeMetadata(metadata),
  });
}

export async function listOrderEvents(orderId, { limit = 200 } = {}) {
  return OrderEvent.find({ order: orderId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(limit, 500))
    .lean();
}
