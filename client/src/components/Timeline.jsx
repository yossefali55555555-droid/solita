import {
  DELIVERY_STATUS_LABELS,
  EVENT_LABELS,
  REMITTANCE_STATUS_LABELS,
  REVIEW_STATUS_LABELS,
  SOURCE_STATUS_LABELS,
  label,
} from '../utils/labels.js';
import { formatDateTime } from '../utils/format.js';
import { EmptyState } from './States.jsx';

const ACTOR_LABELS = { easyorders: 'EasyOrders', system: 'النظام' };

const VALUE_LABELS = {
  deliveryStatus: DELIVERY_STATUS_LABELS,
  sourceStatus: SOURCE_STATUS_LABELS,
  targetStatus: SOURCE_STATUS_LABELS,
  reviewStatus: REVIEW_STATUS_LABELS,
  status: REMITTANCE_STATUS_LABELS,
};

function describeChange(event) {
  const parts = [];
  const prev = event.previous || {};
  const next = event.next || {};
  for (const [key, map] of Object.entries(VALUE_LABELS)) {
    if (next[key] === undefined && prev[key] === undefined) continue;
    const from = prev[key] ? label(map, prev[key]) : null;
    const to = next[key] ? label(map, next[key]) : '—';
    parts.push(from ? `${from} ← ${to}` : to);
  }
  if (next.courierName) parts.push(`المندوب: ${next.courierName}`);
  return parts.join(' · ');
}

/** Audit timeline. All text is rendered as React text nodes (escaped). */
export function Timeline({ events }) {
  if (!events?.length) return <EmptyState title="لا توجد أحداث مسجلة" />;
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e._id} className="timeline__item">
          <div className="timeline__dot" aria-hidden="true" />
          <div className="timeline__content">
            <div className="timeline__head">
              <strong>{label(EVENT_LABELS, e.type)}</strong>
              <time className="muted">{formatDateTime(e.createdAt)}</time>
            </div>
            <div className="timeline__meta muted">
              {e.actor?.kind === 'user' ? `${e.actor.name || ''} (${e.actor.role === 'admin' ? 'مشرف' : 'مندوب'})` : ACTOR_LABELS[e.actor?.kind] || ''}
              {describeChange(e) && <span> · {describeChange(e)}</span>}
            </div>
            {e.reason && <p className="timeline__reason">{e.reason}</p>}
            {e.syncOutcome && <p className="timeline__sync muted">نتيجة المزامنة: {e.syncOutcome}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
