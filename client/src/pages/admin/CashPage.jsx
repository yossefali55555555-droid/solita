import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Card, DefinitionList, Field, Modal, PageHeader, Pagination, StatCard } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { RemittanceStatusBadge } from '../../components/StatusBadges.jsx';
import { Timeline } from '../../components/Timeline.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { REMITTANCE_STATUS_LABELS } from '../../utils/labels.js';
import { formatDateTime, formatMoney, isValidMoneyInput, minorToInput, toAsciiDigits } from '../../utils/format.js';

function MoneyInput({ id, value, onChange }) {
  return (
    <input
      id={id}
      className="input"
      dir="ltr"
      inputMode="decimal"
      placeholder="0.00"
      value={value}
      onChange={(e) => onChange(toAsciiDigits(e.target.value).replace(/[^\d.]/g, ''))}
    />
  );
}

function CreateRemittanceModal({ open, onClose, onCreated, couriers }) {
  const toast = useToast();
  const [courierId, setCourierId] = useState('');
  const [selected, setSelected] = useState([]);
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const eligible = useAsync(
    () => (courierId ? api.get('/admin/cash/eligible-orders', { courier: courierId }) : Promise.resolve({ items: [] })),
    [courierId, open],
  );
  const items = eligible.data?.items || [];
  const expected = items.filter((o) => selected.includes(o._id)).reduce((acc, o) => acc + o.cod.expectedAmount, 0);

  const reset = () => {
    setCourierId('');
    setSelected([]);
    setAmount('');
    setNotes('');
    setError('');
  };

  const [create, creating] = useAction(async () => {
    setError('');
    if (!selected.length) return setError('اختر طلباً واحداً على الأقل');
    if (!isValidMoneyInput(amount)) return setError('أدخل المبلغ المستلم فعلياً (حتى رقمين عشريين)');
    try {
      await api.post('/admin/cash/remittances', { courierId, orderIds: selected, handedOverAmount: amount, notes: notes || undefined });
      toast.success('تم تسجيل استلام النقدية');
      reset();
      onCreated();
    } catch (err) {
      setError(err.message);
    }
  });

  return (
    <Modal
      open={open}
      size="lg"
      title="تسجيل استلام نقدية من مندوب"
      onClose={() => { reset(); onClose(); }}
      footer={
        <>
          <Button variant="secondary" onClick={() => { reset(); onClose(); }} disabled={creating}>إلغاء</Button>
          <Button loading={creating} onClick={create}>تسجيل الاستلام</Button>
        </>
      }
    >
      <Field label="المندوب" required>
        {(id) => (
          <select id={id} className="input" value={courierId} onChange={(e) => { setCourierId(e.target.value); setSelected([]); }}>
            <option value="">اختر المندوب...</option>
            {couriers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (موقوف)'}</option>)}
          </select>
        )}
      </Field>
      {courierId && (
        eligible.loading ? <LoadingState /> : !items.length ? (
          <EmptyState title="لا توجد طلبات مُسلّمة غير مسوّاة لهذا المندوب" />
        ) : (
          <fieldset className="checklist">
            <legend>الطلبات المُسلّمة (الدفع عند الاستلام)</legend>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={selected.length === items.length}
                onChange={(e) => setSelected(e.target.checked ? items.map((o) => o._id) : [])}
              />
              <span>تحديد الكل</span>
            </label>
            {items.map((o) => (
              <label key={o._id} className="checkbox">
                <input
                  type="checkbox"
                  checked={selected.includes(o._id)}
                  onChange={(e) => setSelected((s) => (e.target.checked ? [...s, o._id] : s.filter((x) => x !== o._id)))}
                />
                <span className="mono">{o.easyOrdersId}</span>
                <span>{o.customer?.name}</span>
                <span className="muted">{formatMoney(o.cod.expectedAmount)}</span>
                {o.cod.declaredAmount !== null && o.cod.declaredAmount !== undefined && o.cod.declaredAmount !== o.cod.expectedAmount && (
                  <span className="text-danger small">أعلن المندوب: {formatMoney(o.cod.declaredAmount)}</span>
                )}
              </label>
            ))}
          </fieldset>
        )
      )}
      <p><strong>المبلغ المتوقع:</strong> {formatMoney(expected)}</p>
      <Field label="المبلغ المستلم فعلياً (ج.م)" required>
        {(id) => <MoneyInput id={id} value={amount} onChange={setAmount} />}
      </Field>
      <Field label="ملاحظات">
        {(id) => <textarea id={id} className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}
      </Field>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Modal>
  );
}

function RemittanceModal({ remittanceId, onClose, onChanged }) {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(
    () => (remittanceId ? api.get(`/admin/cash/remittances/${remittanceId}`) : Promise.resolve(null)),
    [remittanceId],
  );
  const events = useAsync(
    () => (remittanceId ? api.get(`/admin/cash/remittances/${remittanceId}/events`) : Promise.resolve(null)),
    [remittanceId],
  );
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState('');
  const r = data?.remittance;

  const act = async (path, body, message) => {
    setFormError('');
    try {
      await api.post(`/admin/cash/remittances/${remittanceId}/${path}`, body);
      toast.success(message);
      setAmount('');
      setReason('');
      reload({ silent: true });
      events.reload({ silent: true });
      onChanged();
    } catch (err) {
      setFormError(err.details?.[0]?.message || err.message);
    }
  };
  const [run, running] = useAction(act);

  return (
    <Modal open={Boolean(remittanceId)} title="تفاصيل التسوية النقدية" size="lg" onClose={onClose}>
      {loading && !data ? <LoadingState /> : error ? <ErrorState error={error} onRetry={reload} /> : r && (
        <>
          <DefinitionList
            items={[
              ['المندوب', r.courier?.name],
              ['الحالة', <RemittanceStatusBadge status={r.status} />],
              ['المبلغ المتوقع', formatMoney(r.expectedAmount)],
              ['المبلغ المعلن من المندوب', formatMoney(r.declaredAmount)],
              ['المبلغ المستلم فعلياً', formatMoney(r.handedOverAmount)],
              ['المبلغ المتحقق منه', formatMoney(r.verifiedAmount)],
              ['الفرق', r.difference === null ? '—' : <span className={r.difference ? 'text-danger' : ''}>{formatMoney(r.difference)}</span>],
              ['أنشأه', `${r.createdBy?.name || ''} — ${formatDateTime(r.createdAt)}`],
              r.receivedBy && ['استلمه', `${r.receivedBy.name} — ${formatDateTime(r.receivedAt)}`],
              r.verifiedBy && ['تحقق منه', `${r.verifiedBy.name} — ${formatDateTime(r.reconciledAt)}`],
              r.notes && ['ملاحظات', r.notes],
            ]}
          />
          <h3 className="section-title">الطلبات ({r.orders.length})</h3>
          <ul className="simple-list">
            {r.orders.map((o) => (
              <li key={o._id}>
                <Link className="link mono" to={`/admin/orders/${o._id}`}>{o.easyOrdersId}</Link> — {o.customer?.name} — {formatMoney(o.cod?.expectedAmount)}
              </li>
            ))}
          </ul>

          {r.status === 'declared' && (
            <div className="inline-form">
              <Field label="المبلغ المستلم فعلياً (ج.م)">
                {(id) => <MoneyInput id={id} value={amount} onChange={setAmount} />}
              </Field>
              <Button loading={running} onClick={() => run('receive', { handedOverAmount: amount }, 'تم تسجيل الاستلام')}>تسجيل الاستلام</Button>
            </div>
          )}
          {['received', 'discrepancy'].includes(r.status) && (
            <div className="inline-form">
              <Field label="المبلغ المتحقق منه (ج.م)" hint={r.handedOverAmount !== null ? `المستلم: ${minorToInput(r.handedOverAmount)}` : undefined}>
                {(id) => <MoneyInput id={id} value={amount} onChange={setAmount} />}
              </Field>
              <Button loading={running} onClick={() => run('verify', { verifiedAmount: amount }, 'تم التحقق من التسوية')}>
                {r.status === 'discrepancy' ? 'تصحيح التحقق' : 'تحقق وتسوية'}
              </Button>
            </div>
          )}
          {['declared', 'received'].includes(r.status) && (
            <div className="inline-form">
              <Field label="سبب إلغاء التسوية">
                {(id) => <input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} />}
              </Field>
              <Button variant="danger" loading={running} onClick={() => run('cancel', { reason }, 'تم إلغاء التسوية وإرجاع الطلبات')}>إلغاء التسوية</Button>
            </div>
          )}
          {formError && <p className="form-error" role="alert">{formError}</p>}

          <h3 className="section-title">سجل التغييرات</h3>
          {events.data ? <Timeline events={events.data.items} /> : <LoadingState />}
        </>
      )}
    </Modal>
  );
}

export function CashPage() {
  const [params, setParams] = useSearchParams();
  const courier = params.get('courier') || '';
  const status = params.get('status') || '';
  const page = Number(params.get('page') || 1);
  const overview = useAsync(() => api.get('/admin/cash/overview'), []);
  const list = useAsync(() => api.get('/admin/cash/remittances', { courier, status, page, limit: 20 }), [courier, status, page]);
  const couriers = useAsync(() => api.get('/admin/couriers-brief'), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState(null);

  const update = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };
  const refresh = () => {
    overview.reload({ silent: true });
    list.reload({ silent: true });
  };
  const o = overview.data;

  return (
    <>
      <PageHeader
        title="النقدية والتسويات"
        subtitle="تسليم الطلب لا يعني استلام النقدية؛ يتم تسجيل الاستلام والتحقق منه هنا"
        actions={<Button onClick={() => setCreateOpen(true)}>تسجيل استلام نقدية</Button>}
      />
      {overview.loading && !o ? <LoadingState /> : overview.error ? <ErrorState error={overview.error} onRetry={overview.reload} /> : (
        <>
          <div className="stats-grid">
            <StatCard label="المتوقع من التسليمات المعتمدة" value={formatMoney(o.expectedDelivered)} />
            <StatCard label="المعلن من المندوبين" value={formatMoney(o.declared)} tone="info" />
            <StatCard label="المستلم فعلياً" value={formatMoney(o.handedOver)} tone="info" />
            <StatCard label="المتحقق منه" value={formatMoney(o.verified)} tone="success" />
            <StatCard label="الفروقات" value={formatMoney(o.discrepancy)} tone={o.discrepancy ? 'danger' : 'neutral'} />
            <StatCard label="المتبقي دون تسوية" value={formatMoney(o.outstanding)} tone="warning" />
          </div>
          <Card title="نقدية لم تُسلّم بعد (حسب المندوب)">
            {!o.perCourier.length ? <EmptyState title="لا توجد نقدية معلقة لدى المندوبين" /> : (
              <ul className="simple-list">
                {o.perCourier.map((p) => (
                  <li key={p.courier._id} className="row-between">
                    <Link className="link" to={`/admin/couriers/${p.courier._id}`}>{p.courier.name}</Link>
                    <span>{p.count} طلب — <strong>{formatMoney(p.expected)}</strong></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      <Card title="سجل التسويات" padded={false}>
        <div className="filters filters--inset">
          <select className="input" aria-label="المندوب" value={courier} onChange={(e) => update('courier', e.target.value)}>
            <option value="">كل المندوبين</option>
            {couriers.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : ' (موقوف)'}</option>)}
          </select>
          <select className="input" aria-label="الحالة" value={status} onChange={(e) => update('status', e.target.value)}>
            <option value="">كل الحالات</option>
            {Object.entries(REMITTANCE_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {list.loading && !list.data ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data.items.length ? (
          <EmptyState title="لا توجد تسويات" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>التاريخ</th><th>المندوب</th><th>الطلبات</th><th>المتوقع</th><th>المستلم</th><th>المتحقق</th><th>الفرق</th><th>الحالة</th><th /></tr></thead>
              <tbody>
                {list.data.items.map((r) => (
                  <tr key={r._id}>
                    <td className="nowrap muted">{formatDateTime(r.createdAt)}</td>
                    <td>{r.courier?.name}</td>
                    <td>{r.orders.length}</td>
                    <td className="nowrap">{formatMoney(r.expectedAmount)}</td>
                    <td className="nowrap">{formatMoney(r.handedOverAmount)}</td>
                    <td className="nowrap">{formatMoney(r.verifiedAmount)}</td>
                    <td className={`nowrap ${r.difference ? 'text-danger' : ''}`}>{r.difference === null ? '—' : formatMoney(r.difference)}</td>
                    <td><RemittanceStatusBadge status={r.status} /></td>
                    <td><Button size="sm" variant="secondary" onClick={() => setOpenId(r._id)}>تفاصيل</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination pagination={list.data?.pagination} onPage={(p) => update('page', String(p))} />
      </Card>

      <CreateRemittanceModal
        open={createOpen}
        couriers={couriers.data?.items || []}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { setCreateOpen(false); refresh(); }}
      />
      <RemittanceModal remittanceId={openId} onClose={() => setOpenId(null)} onChanged={refresh} />
    </>
  );
}
