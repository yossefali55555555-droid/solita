import { Link, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { DeliveryStatusBadge, DemoBadge } from '../../components/StatusBadges.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatMoney } from '../../utils/format.js';

const TABS = [
  { value: 'active', label: 'للتوصيل' },
  { value: 'review', label: 'بانتظار المراجعة' },
  { value: 'completed', label: 'منتهية' },
];

export function CourierOrdersPage() {
  const [params, setParams] = useSearchParams();
  const scope = params.get('scope') || 'active';
  const { data, error, loading, reload } = useAsync(() => api.get('/courier/orders', { scope }), [scope]);

  return (
    <>
      <div className="seg" role="tablist" aria-label="تصنيف الطلبات">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={scope === t.value}
            className={`seg__btn ${scope === t.value ? 'is-active' : ''}`}
            onClick={() => setParams({ scope: t.value }, { replace: true })}
          >
            {t.label}
            {data?.counts?.[t.value] ? <span className="seg__count">{data.counts[t.value]}</span> : null}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <LoadingState />
      ) : error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data.items.length ? (
        <EmptyState
          title={scope === 'active' ? 'لا توجد طلبات للتوصيل حالياً' : 'لا توجد طلبات'}
          description={scope === 'active' ? 'سيظهر هنا أي طلب يعيّنه لك المشرف.' : undefined}
        />
      ) : (
        <ul className="order-cards">
          {data.items.map((o) => (
            <li key={o._id}>
              <Link to={`/courier/orders/${o._id}`} className="order-card">
                <div className="order-card__top">
                  <span className="mono order-card__id">#{o.easyOrdersId}</span>
                  <DeliveryStatusBadge status={o.deliveryStatus} compact />
                </div>
                <div className="order-card__name">{o.customer?.name}</div>
                <div className="order-card__addr">
                  {o.customer?.government} — {o.customer?.address}
                </div>
                <div className="order-card__bottom">
                  <strong>{formatMoney(o.totalAmount)}</strong>
                  <span className="muted">{o.cod?.isCod ? 'تحصيل نقدي' : o.paymentMethod}</span>
                  <DemoBadge show={o.isDemo} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
