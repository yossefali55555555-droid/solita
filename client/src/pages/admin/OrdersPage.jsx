import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, PageHeader, Pagination } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { DeliveryStatusBadge, DemoBadge, OrderSyncBadge, SourceStatusBadge } from '../../components/StatusBadges.jsx';
import { useAsync, useDebouncedValue } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { DELIVERY_STATUS_LABELS, SOURCE_STATUS_LABELS } from '../../utils/labels.js';
import { formatDateTime, formatMoney } from '../../utils/format.js';

const FILTER_KEYS = ['q', 'sourceStatus', 'deliveryStatus', 'courier', 'syncState', 'from', 'to', 'page'];

export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || '']));
  const [search, setSearch] = useState(filters.q);
  const debouncedSearch = useDebouncedValue(search);

  const query = {
    ...filters,
    q: debouncedSearch,
    from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : '',
    to: filters.to ? new Date(`${filters.to}T23:59:59`).toISOString() : '',
    limit: 20,
  };
  const key = JSON.stringify(query);
  const { data, error, loading, reload } = useAsync(() => api.get('/admin/orders', query), [key]);
  const couriers = useAsync(() => api.get('/admin/couriers-brief'), []);

  const update = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader title="الطلبات" subtitle="طلبات المتجر المستوردة من EasyOrders" />
      <Card>
        <div className="filters">
          <input
            className="input filters__search"
            type="search"
            placeholder="بحث برقم الطلب أو اسم العميل أو الهاتف"
            aria-label="بحث"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              update('q', e.target.value);
            }}
          />
          <select className="input" aria-label="حالة EasyOrders" value={filters.sourceStatus} onChange={(e) => update('sourceStatus', e.target.value)}>
            <option value="">كل حالات EasyOrders</option>
            {Object.entries(SOURCE_STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <select className="input" aria-label="حالة التوصيل" value={filters.deliveryStatus} onChange={(e) => update('deliveryStatus', e.target.value)}>
            <option value="">كل حالات التوصيل</option>
            {Object.entries(DELIVERY_STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <select className="input" aria-label="المندوب" value={filters.courier} onChange={(e) => update('courier', e.target.value)}>
            <option value="">كل المندوبين</option>
            <option value="unassigned">غير معيّن</option>
            {couriers.data?.items.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (موقوف)'}</option>
            ))}
          </select>
          <select className="input" aria-label="المزامنة" value={filters.syncState} onChange={(e) => update('syncState', e.target.value)}>
            <option value="">كل حالات المزامنة</option>
            <option value="pending">جاري المزامنة</option>
            <option value="failed">فشلت المزامنة</option>
            <option value="synced">متزامن</option>
          </select>
          <label className="filters__date">
            <span>من</span>
            <input className="input" type="date" value={filters.from} onChange={(e) => update('from', e.target.value)} />
          </label>
          <label className="filters__date">
            <span>إلى</span>
            <input className="input" type="date" value={filters.to} onChange={(e) => update('to', e.target.value)} />
          </label>
        </div>
      </Card>

      <Card padded={false}>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data.items.length ? (
          <EmptyState title="لا توجد طلبات مطابقة" description="جرّب تغيير معايير البحث أو الفلاتر." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>رقم الطلب</th>
                  <th>العميل</th>
                  <th>المحافظة</th>
                  <th>الإجمالي</th>
                  <th>الحالات</th>
                  <th>المندوب</th>
                  <th>التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((o) => (
                  <tr key={o._id}>
                    <td>
                      <Link to={`/admin/orders/${o._id}`} className="link mono">
                        {o.easyOrdersId}
                      </Link>
                      <DemoBadge show={o.isDemo} />
                    </td>
                    <td>
                      <div>{o.customer?.name || '—'}</div>
                      <div className="muted mono" dir="ltr">{o.customer?.phone}</div>
                    </td>
                    <td>{o.customer?.government || '—'}</td>
                    <td className="nowrap">{formatMoney(o.totalAmount, o.currency)}</td>
                    <td>
                      <div className="badge-stack">
                        <SourceStatusBadge status={o.sourceStatus} />
                        <DeliveryStatusBadge status={o.deliveryStatus} />
                        {o.sync?.state && o.sync.state !== 'none' && <OrderSyncBadge state={o.sync.state} />}
                      </div>
                    </td>
                    <td>{o.assignedTo?.name || <span className="muted">غير معيّن</span>}</td>
                    <td className="nowrap muted">{formatDateTime(o.sourceCreatedAt || o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination pagination={data?.pagination} onPage={(p) => update('page', String(p))} />
      </Card>
    </>
  );
}
