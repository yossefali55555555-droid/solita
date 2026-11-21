import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, PageHeader } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDate, formatNumber, orderNumber } from '../../utils/format.js';

/**
 * «الكوبونات»: every discount code is tied to one customer phone. The code is
 * valid for 365 days from the day it was given. The storefront asks the system
 * before accepting a code; any other phone sees "this code has a problem".
 * Orders that still arrive with someone else's code are flagged below.
 */
const REASONS = {
  wrong_phone: 'من رقم غير المخصص له',
  unassigned: 'كود لم يُخصص لأحد',
  already_used: 'كود مستخدم من قبل',
  expired: 'كود منتهي',
};

function statusOf(c) {
  if (!c.phoneNormalized) return ['muted', 'متاح'];
  if (c.uses > 0) return ['info', 'مستخدم'];
  if (c.expiresAt && new Date(c.expiresAt) < new Date()) return ['danger', 'منتهي'];
  if (c.sentAt) return ['success', 'اتبعت للعميل'];
  return ['warning', 'مخصص ولم يُرسل'];
}

export function CouponsPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.get('/admin/coupons'), []);
  const [codes, setCodes] = useState('');
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState({ id: null, phone: '', name: '' });
  const s = data?.summary;

  const run = async (fn, ok) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    run(async () => {
      const list = codes.split(/[\s,،]+/).filter(Boolean);
      const res = await api.post('/admin/coupons', { codes: list });
      setCodes('');
      toast.success(`اتضاف ${res.added} كود${res.skipped ? ` (${res.skipped} موجود قبل كده)` : ''}`);
    });

  return (
    <>
      <PageHeader
        title="الكوبونات"
        subtitle="كل كود خصم مربوط برقم عميل واحد وصالح 365 يوم من يوم التخصيص. الموقع بيسأل النظام قبل ما يقبل أي كود، ولو الرقم مش بتاع صاحب الكود بيظهر للعميل «هذا الكود به مشكلة ولا يمكن استخدامه». أنشئ الكود في EasyOrders بنفس النسبة ثم أضفه هنا، والتخصيص بيتم تلقائيًا بعد موافقة التسليم، أو من زرار الطلب."
      />
      {s ? (
        <Card>
          <div className="badge-row">
            <Badge tone="neutral">الإجمالي {formatNumber(s.total)}</Badge>
            <Badge tone={s.pool ? 'info' : 'danger'}>متاح للتخصيص {formatNumber(s.pool)}</Badge>
            <Badge tone="neutral">مخصص {formatNumber(s.assigned)}</Badge>
            <Badge tone="success">اتبعت {formatNumber(s.sent)}</Badge>
            <Badge tone="info">مستخدم {formatNumber(s.used)}</Badge>
            {s.flagged ? <Badge tone="danger">طلبات غير مطابقة {formatNumber(s.flagged)}</Badge> : null}
          </div>
          {s.pool <= 3 ? <p className="muted small">الأكواد المتاحة قربت تخلص. أضف أكواد جديدة بعد ما تنشئها في EasyOrders.</p> : null}
        </Card>
      ) : null}

      <Card title="إضافة أكواد">
        <textarea
          className="input"
          rows={3}
          dir="ltr"
          placeholder="ST30-A7K2, ST30-B6R5 ... (افصل بمسافة أو فاصلة)"
          value={codes}
          onChange={(e) => setCodes(e.target.value)}
        />
        <Button loading={busy} disabled={!codes.trim()} onClick={add}>
          إضافة
        </Button>
      </Card>

      {data?.flagged?.length ? (
        <Card title="طلبات وصلت بكود غير مطابق">
          <ul className="simple-list">
            {data.flagged.map((o) => (
              <li key={o._id}>
                <Link to={`/admin/orders/${o._id}`} className="link mono">
                  {orderNumber(o)}
                </Link>{' '}
                · {o.customer?.name || '—'} · <span dir="ltr">{String(o.couponCode).toUpperCase()}</span>{' '}
                <Badge tone="danger">{REASONS[o.couponFlag?.reason] || 'غير مطابق'}</Badge>
              </li>
            ))}
          </ul>
          <p className="muted small">الطلب اتسجل في EasyOrders بالخصم. راجعه قبل التجهيز، وعدّل المبلغ أو ألغِ الطلب لو لزم.</p>
        </Card>
      ) : null}

      <Card padded={false}>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data.items.length ? (
          <EmptyState title="لا توجد أكواد بعد" description="أضف الأكواد اللي أنشأتها في EasyOrders من الأعلى." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>الكود</th>
                  <th>العميل</th>
                  <th>التخصيص</th>
                  <th>الصلاحية</th>
                  <th>الحالة</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => {
                  const [tone, label] = statusOf(c);
                  return (
                    <tr key={c._id}>
                      <td className="mono nowrap" dir="ltr">
                        {c.code.toUpperCase()}
                      </td>
                      <td>
                        {c.phoneNormalized ? (
                          <>
                            {c.customerName || <span className="muted">—</span>}
                            <div className="muted mono small" dir="ltr">
                              {c.phoneNormalized}
                            </div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="nowrap muted">
                        {c.assignedAt ? formatDate(c.assignedAt) : '—'}
                        {c.order?.easyOrdersShortId || c.order?.easyOrdersId ? <div className="small">طلب {orderNumber(c.order)}</div> : null}
                      </td>
                      <td className="nowrap muted">{c.expiresAt ? `حتى ${formatDate(c.expiresAt)}` : '—'}</td>
                      <td>
                        <Badge tone={tone}>{label}</Badge>
                        {c.sentAt ? <div className="muted small">{formatDate(c.sentAt)}{c.sentBy?.name ? ` · ${c.sentBy.name}` : ''}</div> : null}
                        {c.uses > 0 ? <div className="muted small">استُخدم {formatNumber(c.uses)} مرة</div> : null}
                      </td>
                      <td>
                        {!c.phoneNormalized ? (
                          manual.id === c._id ? (
                            <div className="badge-row">
                              <input className="input" dir="ltr" placeholder="01xxxxxxxxx" value={manual.phone} onChange={(e) => setManual({ ...manual, phone: e.target.value })} />
                              <input className="input" placeholder="الاسم" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} />
                              <Button
                                size="sm"
                                loading={busy}
                                onClick={() =>
                                  run(async () => {
                                    await api.post(`/admin/coupons/${c._id}/assign`, { phone: manual.phone, name: manual.name });
                                    setManual({ id: null, phone: '', name: '' });
                                  }, 'تم التخصيص')
                                }
                              >
                                تخصيص
                              </Button>
                            </div>
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => setManual({ id: c._id, phone: '', name: '' })}>
                              تخصيص يدوي
                            </Button>
                          )
                        ) : c.uses === 0 ? (
                          <Button size="sm" variant="ghost" loading={busy} onClick={() => run(() => api.post(`/admin/coupons/${c._id}/release`), 'تم إلغاء التخصيص')}>
                            إلغاء التخصيص
                          </Button>
                        ) : null}
                      </td>
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
