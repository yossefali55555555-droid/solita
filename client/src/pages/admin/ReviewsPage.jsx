import { Link, useSearchParams } from 'react-router-dom';
import { Card, PageHeader, Pagination } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import {
  DeliveryStatusBadge,
  DemoBadge,
  ReviewStatusBadge,
  ReviewSyncBadge,
  SourceStatusBadge,
} from '../../components/StatusBadges.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDateTime, formatMoney } from '../../utils/format.js';

const TABS = [
  { value: 'pending', label: 'بانتظار المراجعة' },
  { value: 'approved', label: 'تمت الموافقة' },
  { value: 'rejected', label: 'مرفوضة' },
];

export function ReviewsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'pending';
  const page = params.get('page') || '1';
  const { data, error, loading, reload } = useAsync(
    () => api.get('/admin/delivery-reviews', { status, page, limit: 20 }),
    [status, page],
  );

  return (
    <>
      <PageHeader
        title="طلبات التسليم بانتظار المراجعة"
        subtitle="لا تتحول حالة الطلب في EasyOrders إلى 'تم التسليم' إلا بعد موافقة المشرف"
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
          <EmptyState title={status === 'pending' ? 'لا توجد تقارير تسليم بانتظار المراجعة' : 'لا توجد سجلات'} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>الطلب</th>
                  <th>العميل والعنوان</th>
                  <th>المبلغ</th>
                  <th>المندوب</th>
                  <th>وقت الإرسال</th>
                  <th>الحالات</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r._id}>
                    <td className="mono">
                      {r.order?.easyOrdersId} <DemoBadge show={r.order?.isDemo} />
                    </td>
                    <td>
                      <div>{r.order?.customer?.name}</div>
                      <div className="muted small">{r.order?.customer?.government} — {r.order?.customer?.address}</div>
                    </td>
                    <td className="nowrap">
                      <div>{formatMoney(r.order?.totalAmount)}</div>
                      {r.collectedAmount !== null && <div className="muted small">المحصّل: {formatMoney(r.collectedAmount)}</div>}
                    </td>
                    <td>{r.courier?.name}</td>
                    <td className="nowrap muted">{formatDateTime(r.submittedAt)}</td>
                    <td>
                      <div className="badge-stack">
                        <ReviewStatusBadge status={r.status} />
                        <SourceStatusBadge status={r.order?.sourceStatus} />
                        <DeliveryStatusBadge status={r.order?.deliveryStatus} />
                        {r.status === 'approved' && <ReviewSyncBadge status={r.syncStatus} />}
                      </div>
                    </td>
                    <td>
                      <Link className="btn btn--primary btn--sm" to={`/admin/reviews/${r._id}`}>
                        {r.status === 'pending' ? 'مراجعة' : 'عرض'}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination pagination={data?.pagination} onPage={(p) => setParams({ status, page: String(p) })} />
      </Card>
    </>
  );
}
