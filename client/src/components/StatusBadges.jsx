import { Badge } from './ui.jsx';
import {
  DELIVERY_STATUS_LABELS,
  DELIVERY_TONES,
  ORDER_SYNC_LABELS,
  REMITTANCE_STATUS_LABELS,
  REMITTANCE_TONES,
  REVIEW_STATUS_LABELS,
  REVIEW_SYNC_LABELS,
  REVIEW_TONES,
  SOURCE_STATUS_LABELS,
  SOURCE_TONES,
  SYNC_OP_LABELS,
  SYNC_TONES,
  label,
} from '../utils/labels.js';

// Each badge carries a visible prefix so the four status kinds are never confused.

export function SourceStatusBadge({ status, compact = false }) {
  return (
    <Badge tone={SOURCE_TONES[status] || 'neutral'} title={`حالة EasyOrders: ${status || '—'}`}>
      {!compact && <span className="badge__kind">EasyOrders:</span>} {label(SOURCE_STATUS_LABELS, status)}
    </Badge>
  );
}

export function DeliveryStatusBadge({ status, compact = false }) {
  return (
    <Badge tone={DELIVERY_TONES[status] || 'neutral'} title="حالة التوصيل الداخلية">
      {!compact && <span className="badge__kind">التوصيل:</span>} {label(DELIVERY_STATUS_LABELS, status)}
    </Badge>
  );
}

export function ReviewStatusBadge({ status }) {
  return (
    <Badge tone={REVIEW_TONES[status] || 'neutral'} title="حالة مراجعة المشرف">
      <span className="badge__kind">المراجعة:</span> {label(REVIEW_STATUS_LABELS, status)}
    </Badge>
  );
}

export function ReviewSyncBadge({ status }) {
  return (
    <Badge tone={SYNC_TONES[status] || 'neutral'} title="مزامنة التسليم مع EasyOrders">
      <span className="badge__kind">المزامنة:</span> {label(REVIEW_SYNC_LABELS, status)}
    </Badge>
  );
}

export function OrderSyncBadge({ state }) {
  return (
    <Badge tone={SYNC_TONES[state] || 'neutral'} title="حالة المزامنة مع EasyOrders">
      <span className="badge__kind">المزامنة:</span> {label(ORDER_SYNC_LABELS, state || 'none')}
    </Badge>
  );
}

export function SyncOperationBadge({ state }) {
  return <Badge tone={SYNC_TONES[state] || 'neutral'}>{label(SYNC_OP_LABELS, state)}</Badge>;
}

export function RemittanceStatusBadge({ status }) {
  return <Badge tone={REMITTANCE_TONES[status] || 'neutral'}>{label(REMITTANCE_STATUS_LABELS, status)}</Badge>;
}

export function DemoBadge({ show }) {
  return show ? <Badge tone="demo">بيانات تجريبية</Badge> : null;
}
