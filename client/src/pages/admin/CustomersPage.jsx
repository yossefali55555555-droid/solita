import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Card, PageHeader, Pagination } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { useAsync, useDebouncedValue } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDate, formatMoney, formatNumber } from '../../utils/format.js';

const SORTS = [
  { value: 'recent', label: 'الأحدث طلباً' },
  { value: 'orders', label: 'الأكثر طلبات' },
  { value: 'spent', label: 'الأعلى مبيعات' },
  { value: 'returns', label: 'الأكثر مرتجعات' },
];

export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') || '');
  const q = useDebouncedValue(search.trim());
  const sort = params.get('sort') || 'recent';
  const page = params.get('page') || '1';
  const { data, error, loading, reload } = useAsync(
    () => api.get('/admin/customers', { q, sort, page, limit: 20 }),
    [q, sort, page],
  );

  const update = (next) => setParams({ ...(q ? { q } : {}), sort, ...next });

  return (
    <>
      <PageHeader title="العملاء" subtitle="كل عملاء المتجر مجمّعين برقم الهاتف مع سجل طلباتهم" />
      <Card>
        <div className="filters">
          <input
            className="input filters__search"
            type="search"
            placeholder="بحث بالاسم أو رقم الهاتف"
            aria-label="بحث"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (params.get('page')) setParams({ sort });
            }}
          />
          <select className="input" aria-label="الترتيب" value={sort} onChange={(e) => update({ sort: e.target.value })}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </Card>
      <Card padded={false}>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data.items.length ? (
          <EmptyState title="لا يوجد عملاء مطابقون" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>العميل</th>
                  <th>المحافظة</th>
                  <th>عدد الطلبات</th>
                  <th>تم التسليم</th>
                  <th>مرتجع / فشل</th>
                  <th>إجمالي المُسلَّم</th>
                  <th>آخر طلب</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.key}>
                    <td>
                      <Link className="link" to={`/admin/customers/${encodeURIComponent(c.key)}`}>
                        {c.name || '—'}
                      </Link>
                      <div className="muted mono small" dir="ltr">{c.phone}</div>
                    </td>
                    <td>{c.government || '—'}</td>
                    <td>{formatNumber(c.ordersCount)}</td>
                    <td>{formatNumber(c.delivered)}</td>
                    <td>
                      {c.returned + c.failed > 0 ? (
                        <Badge tone="danger">{formatNumber(c.returned + c.failed)}</Badge>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td className="nowrap">{formatMoney(c.totalDelivered)}</td>
                    <td className="nowrap muted">{formatDate(c.lastOrderAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination pagination={data?.pagination} onPage={(p) => update({ page: String(p) })} />
      </Card>
    </>
  );
}
