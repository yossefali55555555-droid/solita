import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Card, PageHeader, Pagination } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { DeliveryStatusBadge, DemoBadge, OrderSyncBadge, SourceStatusBadge } from '../../components/StatusBadges.jsx';
import { ConfirmReturnModal } from '../../components/ConfirmReturnModal.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { FAILURE_REASON_LABELS, label } from '../../utils/labels.js';
import { formatDateTime, formatMoney, orderNumber } from '../../utils/format.js';

const TABS = [
  { value: 'pending', label: 'بانتظار المراجعة' },
  { value: 'returned', label: 'مرتجعات معتمدة' },
];

export function ReturnsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'pending';
  const page = params.get('page') || '1';
  const [selected, setSelected] = useState(null);
  const { data, error, loading, reload } = useAsync(
    () => api.get('/admin/returns', { status, page, limit: 20 }),
    [status, page],
  );

  return (
    <>
      <PageHeader
        title="مراجعة الرفض والمرتجعات"
        subtitle="الطلبات التي لم يتمكن المندوب من تسليمها (رفض الاستلام، لم يدفع، لم يرد...). عند اعتماد المرتجع تتحدث حالة EasyOrders تلقائياً."
      />
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={status === t.value}
            className={`tab ${status === t.value ? 'tab--active' : ''}`}
            onClick={() => setParams({ status: t.value })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Card padded={false}>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data.items.length ? (
          <EmptyState title={status === 'pending' ? 'لا توجد طلبات مرفوضة بانتظار المراجعة' : 'لا توجد مرتجعات'} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>الطلب</th>
                  <th>العميل</th>
                  <th>المبلغ</th>
                  <th>المندوب</th>
                  <th>السبب</th>
                  <th>الوقت</th>
                  <th>الحالات</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((o) => (
                  <tr key={o._id}>
                    <td className="mono">
                      <Link className="link" to={`/admin/orders/${o._id}`}>
                        {orderNumber(o)}
                      </Link>{' '}
                      <DemoBadge show={o.isDemo} />
                    </td>
                    <td>
                      <div>{o.customer?.name}</div>
                      <div className="muted mono small" dir="ltr">{o.customer?.phone}</div>
                    </td>
                    <td className="nowrap">{formatMoney(o.totalAmount, o.currency)}</td>
                    <td>{o.lastAttempt?.courier?.name || o.assignedTo?.name || '—'}</td>
                    <td>
                      {status === 'returned' ? (
                        <>
                          <div>{o.returnInfo?.reason || '—'}</div>
                          <div className="muted small">اعتمده: {o.returnInfo?.by?.name || '—'}</div>
                        </>
                      ) : (
                        <>
                          <div>{label(FAILURE_REASON_LABELS, o.lastAttempt?.reason)}</div>
                          {o.lastAttempt?.note && <div className="muted small">{o.lastAttempt.note}</div>}
                        </>
                      )}
                    </td>
                    <td className="nowrap muted">
                      {formatDateTime(status === 'returned' ? o.returnInfo?.at : o.lastAttempt?.at || o.updatedAt)}
                    </td>
                    <td>
                      <div className="badge-stack">
                        <DeliveryStatusBadge status={o.deliveryStatus} />
                        <SourceStatusBadge status={o.sourceStatus} />
                        {o.sync?.state && o.sync.state !== 'none' && <OrderSyncBadge state={o.sync.state} />}
                      </div>
                    </td>
                    <td>
                      {status === 'pending' ? (
                        <div className="action-list">
                          <Button size="sm" variant="danger" onClick={() => setSelected(o)}>
                            تأكيد المرتجع
                          </Button>
                          <Link className="btn btn--secondary btn--sm" to={`/admin/orders/${o._id}`}>
                            إعادة المحاولة
                          </Link>
                        </div>
                      ) : (
                        <Link className="btn btn--secondary btn--sm" to={`/admin/orders/${o._id}`}>
                          عرض
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination pagination={data?.pagination} onPage={(p) => setParams({ status, page: String(p) })} />
      </Card>
      {selected && (
        <ConfirmReturnModal
          order={selected}
          lastAttempt={selected.lastAttempt}
          onClose={() => setSelected(null)}
          onDone={() => {
            setSelected(null);
            reload({ silent: true });
          }}
        />
      )}
    </>
  );
}
