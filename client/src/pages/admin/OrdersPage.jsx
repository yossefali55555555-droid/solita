import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, ConfirmDialog, Field, PageHeader, Pagination } from '../../components/ui.jsx';
import { ConfirmWordModal } from '../../components/ConfirmWordModal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { EasyOrdersSync } from '../../components/EasyOrdersSync.jsx';
import { DeliveryStatusBadge, DemoBadge, OrderSyncBadge, SourceStatusBadge } from '../../components/StatusBadges.jsx';
import { useAction, useAsync, useDebouncedValue } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { DELIVERY_STATUS_LABELS, SOURCE_STATUS_LABELS } from '../../utils/labels.js';
import { formatDateTime, formatMoney, orderNumber } from '../../utils/format.js';
import { OrderWhatsAppButtons } from '../../features/whatsapp/OrderWhatsAppButtons.jsx';

const FILTER_KEYS = ['q', 'sourceStatus', 'deliveryStatus', 'courier', 'syncState', 'cleared', 'test', 'unconfirmed', 'couponFlagged', 'from', 'to', 'page'];

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
  const settings = useAsync(() => api.get('/admin/site-settings'), []);
  const templates = settings.data?.settings?.admin
    ? { coupon: settings.data.settings.admin.couponWhatsappTemplate, confirm: settings.data.settings.admin.confirmWhatsappTemplate }
    : null;
  const unconfirmedCount = useAsync(() => api.get('/admin/orders', { unconfirmed: 'true', limit: 1 }), []);
  const cleared = useAsync(() => api.get('/admin/orders/cleared/count'), []);
  const toast = useToast();
  const [clearOpen, setClearOpen] = useState(false);


  const refresh = () => {
    reload({ silent: true });
    cleared.reload({ silent: true });
    unconfirmedCount.reload({ silent: true });
  };
  const clearOrders = async (confirm) => {
    const res = await api.post('/admin/orders/clear', { confirm });
    setClearOpen(false);
    toast.success(`تم مسح ${res.cleared} طلب من اللوحة (ما زالت محفوظة في قاعدة البيانات)`);
    refresh();
  };
  const [restore, restoring] = useAction(async () => {
    try {
      const res = await api.post('/admin/orders/restore-cleared');
      toast.success(`تم استرجاع ${res.restored} طلب إلى اللوحة`);
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  });
  const clearedCount = cleared.data?.count || 0;

  // ---- multi-select + bulk actions ----
  const [selected, setSelected] = useState(() => new Set());
  const [bulk, setBulk] = useState(null); // { action, courierId?, reason?, syncToEasyOrders? }
  const [bulkError, setBulkError] = useState('');
  const pageIds = (data?.items || []).map((o) => o._id);
  const allOnPage = pageIds.length > 0 && pageIds.every((i) => selected.has(i));
  const toggleOne = (oid) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(oid)) next.delete(oid);
      else next.add(oid);
      return next;
    });
  const togglePage = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPage) pageIds.forEach((i) => next.delete(i));
      else pageIds.forEach((i) => next.add(i));
      return next;
    });
  const BULK_LABELS = {
    assign: 'تعيين لمندوب',
    unassign: 'سحب التعيين',
    cancel: 'إلغاء الطلبات',
    reopen: 'إعادة فتح الطلبات',
    mark_test: 'تحديد كطلبات تجريبية',
    unmark_test: 'إلغاء علامة التجريبي',
    hide: 'مسح من اللوحة',
  };
  const [runBulk, runningBulk] = useAction(async () => {
    setBulkError('');
    const body = { action: bulk.action, ids: [...selected] };
    if (bulk.action === 'assign') body.courierId = bulk.courierId;
    if (bulk.action === 'cancel') {
      body.reason = bulk.reason || '';
      body.syncToEasyOrders = Boolean(bulk.syncToEasyOrders);
    }
    if (bulk.action === 'reopen') body.reason = bulk.reason || '';
    try {
      const res = await api.post('/admin/orders/bulk', body);
      if (res.failed.length) {
        toast.info(`تم تنفيذ ${res.done} طلب، وتعذر ${res.failed.length}: ${res.failed[0].message}`);
        setSelected(new Set(res.failed.map((x) => x.id)));
      } else {
        toast.success(`تم تنفيذ العملية على ${res.done} طلب`);
        setSelected(new Set());
      }
      setBulk(null);
      refresh();
    } catch (err) {
      setBulkError(err.details?.[0]?.message || err.message);
    }
  });
  const bulkNeedsReason = bulk && ['cancel', 'reopen'].includes(bulk.action);
  const bulkReady = bulk && (bulk.action !== 'assign' || bulk.courierId) && (!bulkNeedsReason || (bulk.reason || '').trim().length >= 3);

  const update = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="الطلبات"
        subtitle="طلبات المتجر المستوردة من EasyOrders"
        actions={
          <>
            <EasyOrdersSync onChange={() => reload({ silent: true })} />
            <Button variant="danger" onClick={() => setClearOpen(true)}>مسح الطلبات من اللوحة</Button>
          </>
        }
      />
      {clearedCount > 0 && (
        <div className="alert alert--info row-between">
          <span>يوجد {clearedCount} طلب ممسوح من اللوحة ومحفوظ في قاعدة البيانات.</span>
          <span className="page-header__actions">
            <Button size="sm" variant="secondary" onClick={() => update('cleared', filters.cleared === 'only' ? '' : 'only')}>
              {filters.cleared === 'only' ? 'إخفاء الطلبات الممسوحة' : 'عرض الطلبات الممسوحة'}
            </Button>
            <Button size="sm" variant="secondary" loading={restoring} onClick={restore}>استرجاع كل الطلبات الممسوحة</Button>
          </span>
        </div>
      )}
      <ConfirmWordModal
        open={clearOpen}
        title="مسح الطلبات من اللوحة"
        word="مسح"
        confirmLabel="مسح الطلبات"
        onClose={() => setClearOpen(false)}
        onConfirm={clearOrders}
      >
        <p>سيتم إخفاء كل الطلبات الموجودة حالياً من صفحة الطلبات والصفحة الرئيسية.</p>
        <p><strong>لن يتم حذف أي طلب من قاعدة البيانات</strong>، ويمكنك عرضها أو استرجاعها في أي وقت. الطلبات الجديدة من EasyOrders ستظهر بشكل طبيعي، وصفحات المندوبين والنقدية لا تتأثر.</p>
      </ConfirmWordModal>
      <div className="tabs" role="tablist">
        <Button variant={!filters.unconfirmed && !filters.couponFlagged ? 'primary' : 'secondary'} onClick={() => setParams({}, { replace: true })}>
          كل الطلبات
        </Button>
        <Button variant={filters.unconfirmed ? 'primary' : 'secondary'} onClick={() => setParams({ unconfirmed: 'true' }, { replace: true })}>
          غير مؤكدة (قيد المراجعة){unconfirmedCount.data ? ` · ${unconfirmedCount.data.pagination?.total ?? 0}` : ''}
        </Button>
        <Button variant={filters.couponFlagged ? 'primary' : 'secondary'} onClick={() => setParams({ couponFlagged: 'true' }, { replace: true })}>
          كوبون غير مطابق
        </Button>
      </div>
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
          <select className="input" aria-label="الطلبات الممسوحة" value={filters.cleared} onChange={(e) => update('cleared', e.target.value)}>
            <option value="">بدون الطلبات الممسوحة</option>
            <option value="include">مع الطلبات الممسوحة</option>
            <option value="only">الطلبات الممسوحة فقط</option>
          </select>
          <select className="input" aria-label="الطلبات التجريبية" value={filters.test} onChange={(e) => update('test', e.target.value)}>
            <option value="">بدون الطلبات التجريبية</option>
            <option value="include">مع الطلبات التجريبية</option>
            <option value="only">التجريبية فقط</option>
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

      {selected.size > 0 && (
        <div className="alert alert--info row-between" role="region" aria-label="إجراءات جماعية">
          <span>
            <strong>{selected.size}</strong> طلب محدد
          </span>
          <span className="page-header__actions">
            {Object.entries(BULK_LABELS).map(([action, text]) => (
              <Button
                key={action}
                size="sm"
                variant={action === 'cancel' || action === 'hide' ? 'danger' : 'secondary'}
                onClick={() => { setBulkError(''); setBulk({ action }); }}
              >
                {text}
              </Button>
            ))}
            <Button size="sm" variant="secondary" onClick={() => setSelected(new Set())}>إلغاء التحديد</Button>
          </span>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(bulk)}
        title={bulk ? `${BULK_LABELS[bulk.action]} (${selected.size} طلب)` : ''}
        confirmLabel="تنفيذ"
        tone={bulk && (bulk.action === 'cancel' || bulk.action === 'hide') ? 'danger' : 'primary'}
        loading={runningBulk}
        onClose={() => setBulk(null)}
        onConfirm={() => bulkReady && runBulk()}
      >
        {bulk?.action === 'assign' && (
          <Field label="المندوب" required>
            <select className="input" value={bulk.courierId || ''} onChange={(e) => setBulk({ ...bulk, courierId: e.target.value })}>
              <option value="">اختر المندوب</option>
              {couriers.data?.items.filter((c) => c.isActive).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        )}
        {bulkNeedsReason && (
          <Field label={bulk.action === 'cancel' ? 'سبب الإلغاء' : 'سبب إعادة الفتح'} required>
            <textarea className="input" rows={3} value={bulk.reason || ''} onChange={(e) => setBulk({ ...bulk, reason: e.target.value })} />
          </Field>
        )}
        {bulk?.action === 'cancel' && (
          <label className="checkbox">
            <input type="checkbox" checked={Boolean(bulk.syncToEasyOrders)} onChange={(e) => setBulk({ ...bulk, syncToEasyOrders: e.target.checked })} />
            <span>إلغاء الطلبات في EasyOrders أيضًا</span>
          </label>
        )}
        {bulk?.action === 'mark_test' && <p>لن تدخل هذه الطلبات في أي أرقام (مبيعات، نقدية، أرباح، كوبونات، عملاء) ولن تظهر في القوائم. يمكنك استرجاعها بفلتر «التجريبية فقط».</p>}
        {bulk?.action === 'hide' && <p>سيتم إخفاء الطلبات المحددة من اللوحة فقط، وتبقى محفوظة في قاعدة البيانات.</p>}
        {bulkError && <div className="alert alert--danger" role="alert">{bulkError}</div>}
      </ConfirmDialog>

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
                  <th>
                    <input type="checkbox" aria-label="تحديد كل الطلبات في الصفحة" checked={allOnPage} onChange={togglePage} />
                  </th>
                  <th>رقم الطلب</th>
                  <th>العميل</th>
                  <th>المحافظة</th>
                  <th>الإجمالي</th>
                  <th>الحالات</th>
                  <th>المندوب</th>
                  <th>التاريخ</th>
                  <th>واتساب</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((o) => (
                  <tr key={o._id} className={selected.has(o._id) ? 'is-selected' : ''}>
                    <td>
                      <input type="checkbox" aria-label={`تحديد الطلب ${orderNumber(o)}`} checked={selected.has(o._id)} onChange={() => toggleOne(o._id)} />
                    </td>
                    <td>
                      <Link to={`/admin/orders/${o._id}`} className="link mono">
                        {orderNumber(o)}
                      </Link>
                      <DemoBadge show={o.isDemo} />
                      {o.isTest && <Badge tone="warning" title="طلب تجريبي: لا يدخل في أي أرقام">تجريبي</Badge>}
                      {o.dashboardHiddenAt && <Badge tone="neutral" title="ممسوح من اللوحة ومحفوظ في قاعدة البيانات">ممسوح</Badge>}
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
                    <td>
                      <OrderWhatsAppButtons order={o} templates={templates} onChanged={refresh} />
                    </td>
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
