import { Link, useParams } from 'react-router-dom';
import { Card, DefinitionList, PageHeader, StatCard } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { DeliveryStatusBadge, SourceStatusBadge } from '../../components/StatusBadges.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { FAILURE_REASON_LABELS, label } from '../../utils/labels.js';
import { formatDate, formatDateTime, formatMoney, formatNumber, orderNumber } from '../../utils/format.js';

export function CustomerDetailPage() {
  const { key } = useParams();
  const { data, error, loading, reload } = useAsync(() => api.get(`/admin/customers/${encodeURIComponent(key)}`), [key]);

  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const { customer: c, orders } = data;

  return (
    <>
      <PageHeader title={c.name || 'عميل'} subtitle={c.phone} back="/admin/customers" />
      <div className="stats-grid">
        <StatCard label="عدد الطلبات" value={formatNumber(c.ordersCount)} />
        <StatCard label="تم التسليم" value={formatNumber(c.delivered)} tone="success" />
        <StatCard label="مرتجع" value={formatNumber(c.returned)} tone={c.returned ? 'warning' : 'neutral'} />
        <StatCard label="محاولات فاشلة حالياً" value={formatNumber(c.failed)} tone={c.failed ? 'danger' : 'neutral'} />
        <StatCard label="ملغي" value={formatNumber(c.cancelled)} />
        <StatCard label="إجمالي المُسلَّم" value={formatMoney(c.totalDelivered)} tone="success" />
      </div>
      <Card title="بيانات العميل">
        <DefinitionList
          items={[
            ['الاسم', c.name],
            ['الهاتف', <span key="p" dir="ltr" className="mono">{c.phone}</span>],
            ['المحافظة', c.government],
            ['العنوان', c.address],
            ['إجمالي كل الطلبات', formatMoney(c.totalOrdered)],
            ['أول طلب', formatDate(c.firstOrderAt)],
            ['آخر طلب', formatDate(c.lastOrderAt)],
          ]}
        />
      </Card>
      <Card title="سجل الطلبات" padded={false}>
        {!orders.length ? (
          <EmptyState title="لا توجد طلبات" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>رقم الطلب</th>
                  <th>المنتجات</th>
                  <th>الإجمالي</th>
                  <th>الحالات</th>
                  <th>المندوب</th>
                  <th>ملاحظات</th>
                  <th>التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const lastAttempt = o.deliveryAttempts?.at(-1);
                  return (
                    <tr key={o._id}>
                      <td>
                        <Link className="link mono" to={`/admin/orders/${o._id}`}>
                          {orderNumber(o)}
                        </Link>
                      </td>
                      <td className="small">{(o.items || []).map((i) => `${i.name} × ${i.quantity}`).join('، ') || '—'}</td>
                      <td className="nowrap">{formatMoney(o.totalAmount, o.currency)}</td>
                      <td>
                        <div className="badge-stack">
                          <DeliveryStatusBadge status={o.deliveryStatus} />
                          <SourceStatusBadge status={o.sourceStatus} />
                        </div>
                      </td>
                      <td>{o.assignedTo?.name || '—'}</td>
                      <td className="small">
                        {o.deliveryStatus === 'returned' && o.returnInfo?.reason
                          ? o.returnInfo.reason
                          : lastAttempt && ['failed', 'returned'].includes(o.deliveryStatus)
                            ? `${label(FAILURE_REASON_LABELS, lastAttempt.reason)}${lastAttempt.note ? ` — ${lastAttempt.note}` : ''}`
                            : '—'}
                      </td>
                      <td className="nowrap muted">{formatDateTime(o.sourceCreatedAt || o.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
