import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Card, PageHeader, Pagination } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { DeliveryStatusBadge, DemoBadge, SourceStatusBadge } from '../../components/StatusBadges.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDateTime, formatMoney, orderNumber } from '../../utils/format.js';
import { PrintPortal } from '../../features/labels/LabelSheets.jsx';

const TABS = [
  { value: 'pending', label: 'لم تُطبع', count: 'pending' },
  { value: 'reprint', label: 'تحتاج إعادة طباعة', count: 'reprint' },
  { value: 'printed', label: 'طُبعت سابقًا' },
];

export function LabelsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'pending';
  const page = params.get('page') || '1';
  const [selected, setSelected] = useState(() => new Set());
  const [printLabels, setPrintLabels] = useState(null);
  const { data, error, loading, reload } = useAsync(() => api.get('/admin/labels', { tab, page, limit: 50 }), [tab, page]);

  // Print once the sheets are in the DOM, then drop them.
  useEffect(() => {
    if (!printLabels) return undefined;
    const done = () => setPrintLabels(null);
    window.addEventListener('afterprint', done, { once: true });
    const t = setTimeout(() => window.print(), 300);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [printLabels]);

  const [print, printing] = useAction(async () => {
    try {
      const res = await api.post('/admin/labels/print', { orderIds: [...selected] });
      const parcels = res.labels.reduce((n, l) => n + l.parcels.length, 0);
      toast.success(`تم تجهيز ${parcels} ملصق — اختر الطابعة`);
      setPrintLabels(res.labels);
      setSelected(new Set());
      reload({ silent: true });
    } catch (err) {
      const more = err.details?.length > 1 ? ` (و${err.details.length - 1} طلبات أخرى)` : '';
      toast.error(`${err.message}${more}`);
    }
  });

  const items = data?.items || [];
  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else if (next.size < 40) next.add(id);
      return next;
    });
  const allSelected = items.length > 0 && items.slice(0, 40).every((o) => selected.has(o._id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.slice(0, 40).map((o) => o._id)));

  return (
    <>
      <PageHeader
        title="طباعة البوليصة"
        subtitle="ملصق لكل جزمة (4 ملصقات في ورقة A4) وعليه QR يمسحه المندوب عند الاستلام وعند العميل، ويُمسح عند رجوع المرتجع للمخزن."
        actions={
          <Button onClick={print} loading={printing} disabled={!selected.size}>
            طباعة {selected.size ? `(${selected.size})` : ''}
          </Button>
        }
      />
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            className={`tab ${tab === t.value ? 'tab--active' : ''}`}
            onClick={() => {
              setSelected(new Set());
              setParams({ tab: t.value });
            }}
          >
            {t.label}
            {t.count && data?.counts?.[t.count] ? <span className="tab__count">{data.counts[t.count]}</span> : null}
          </button>
        ))}
      </div>
      <Card padded={false}>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !items.length ? (
          <EmptyState title={tab === 'reprint' ? 'لا توجد طلبات تحتاج إعادة طباعة' : tab === 'printed' ? 'لم تُطبع أي بوليصة بعد' : 'كل الطلبات مطبوعة'} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="تحديد الكل" />
                  </th>
                  <th>الطلب</th>
                  <th>العميل</th>
                  <th>الطرود</th>
                  <th>المطلوب تحصيله</th>
                  <th>المندوب</th>
                  <th>الحالات</th>
                  <th>{tab === 'printed' ? 'آخر طباعة' : tab === 'reprint' ? 'السبب' : 'التاريخ'}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o._id} className={selected.has(o._id) ? 'is-selected' : ''}>
                    <td>
                      <input type="checkbox" checked={selected.has(o._id)} onChange={() => toggle(o._id)} aria-label={`تحديد ${orderNumber(o)}`} />
                    </td>
                    <td className="mono">
                      <Link className="link" to={`/admin/orders/${o._id}`}>{orderNumber(o)}</Link> <DemoBadge show={o.isDemo} />
                    </td>
                    <td>
                      <div>{o.customer?.name}</div>
                      <div className="muted small">{o.customer?.government}</div>
                    </td>
                    <td>{o.parcelCount}</td>
                    <td>{o.cod?.isCod ? formatMoney(o.cod.expectedAmount) : 'مدفوع'}</td>
                    <td>{o.assignedTo?.name || <span className="muted">—</span>}</td>
                    <td>
                      <div className="badge-stack">
                        <DeliveryStatusBadge status={o.deliveryStatus} />
                        <SourceStatusBadge status={o.sourceStatus} />
                      </div>
                    </td>
                    <td className="small">
                      {tab === 'printed'
                        ? `${formatDateTime(o.labels?.printedAt)}${o.labels?.printCount > 1 ? ` · ${o.labels.printCount} مرات` : ''}`
                        : tab === 'reprint'
                          ? o.labels?.reprintReason
                          : formatDateTime(o.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {data?.pagination && <Pagination pagination={data.pagination} onPage={(p) => {
            setSelected(new Set());
            setParams({ tab, page: String(p) });
          }} />}
      <PrintPortal labels={printLabels} />
    </>
  );
}
