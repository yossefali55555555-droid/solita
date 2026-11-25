import { useState } from 'react';
import { usePermissions } from '../../features/auth/permissions.js';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, PageHeader } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDate, formatDateTime, formatNumber, orderNumber } from '../../utils/format.js';

/**
 * «الكوبونات»: every customer-bound code is tied to one phone and valid for
 * 365 days from the day it was sent to the customer, on any number of orders.
 * The storefront asks the system before accepting a code; any other phone sees
 * "this code has a problem". Settings that EasyOrders owns (percentage, usage
 * limit, active) are edited here and applied to EasyOrders by the sync
 * bookmarklet; until then they show as "waiting for sync".
 */
const REASONS = {
  wrong_phone: 'رقم غير رقم صاحب الكود',
  unassigned: 'كود لم يُخصص لأحد',
  expired: 'كود منتهي',
  bad_phone: 'رقم غير صالح',
};

function statusOf(c) {
  if (c.bound === false) return ['muted', 'مش مربوط بعملاء'];
  if (!c.assigned) return ['muted', 'متاح'];
  if (c.sentAt && c.expiresAt && new Date(c.expiresAt) < new Date()) return ['danger', 'منتهي'];
  if (c.sentAt) return ['success', 'اتبعت للعميل'];
  return ['warning', 'مخصص ولم يُرسل'];
}

function limitLabel(n) {
  return n === 0 ? 'بدون حد' : `${formatNumber(n)} مرة`;
}

function EditSettings({ coupon, onDone, run, busy }) {
  const s = coupon.settings;
  const [form, setForm] = useState({
    value: s ? String(s.value) : '',
    usageLimit: s ? String(s.usageLimit) : '',
    isActive: s ? Boolean(s.isActive) : true,
    bound: coupon.bound !== false,
  });
  const save = () =>
    run(async () => {
      const body = { bound: form.bound };
      if (s) {
        body.value = Number(form.value);
        body.usageLimit = Number(form.usageLimit);
        body.isActive = form.isActive;
      }
      await api.patch(`/admin/coupons/${coupon._id}/settings`, body);
      onDone();
    }, 'تم الحفظ');

  return (
    <div className="badge-stack">
      {s ? (
        <>
          <label className="checkbox">
            نسبة الخصم %
            <input className="input" type="number" min="0" max="100" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          </label>
          <label className="checkbox">
            حد الاستخدام (0 = بدون حد)
            <input className="input" type="number" min="0" value={form.usageLimit} onChange={(e) => setForm({ ...form, usageLimit: e.target.value })} />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            مفعّل
          </label>
        </>
      ) : (
        <p className="muted small">لسه مفيش بيانات من EasyOrders للكود ده. استورد أو اعمل مزامنة.</p>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={form.bound} onChange={(e) => setForm({ ...form, bound: e.target.checked })} />
        مربوط بالعملاء (كل كود لعميل واحد)
      </label>
      <div className="badge-row">
        <Button size="sm" loading={busy} onClick={save}>
          حفظ
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          إلغاء
        </Button>
      </div>
    </div>
  );
}

function parseImport(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data?.coupons;
  if (!Array.isArray(list) || !list.length) throw new Error('الملف لازم يكون قايمة كوبونات');
  return list;
}

export function CouponsPage() {
  const toast = useToast();
  const perms = usePermissions();
  const { data, error, loading, reload } = useAsync(() => api.get('/admin/coupons'), []);
  const attempts = useAsync(() => api.get('/admin/coupons/attempts'), []);
  const [codes, setCodes] = useState('');
  const [importText, setImportText] = useState('');
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState({ id: null, phone: '', name: '' });
  const [dates, setDates] = useState({ id: null });
  const [editing, setEditing] = useState(null);
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
      const res = await api.post('/admin/coupons', { codes: codes.split(/[\s,،]+/).filter(Boolean) });
      setCodes('');
      toast.success(`اتضاف ${res.added} كود${res.skipped ? ` (${res.skipped} موجود قبل كده)` : ''}`);
    });

  const importCoupons = () =>
    run(async () => {
      const res = await api.post('/admin/coupons/import', { coupons: parseImport(importText) });
      setImportText('');
      toast.success(`استيراد تم: ${res.created} جديد، ${res.updated} اتحدّث`);
    });

  return (
    <>
      <PageHeader
        title="الكوبونات"
        subtitle="كل كود خصم مربوط برقم عميل واحد، وصالح 365 يوم من يوم ما اتبعت للعميل، وبيتستخدم أكتر من مرة خلال المدة دي. الموقع بيسأل النظام قبل ما يقبل أي كود، ولو الرقم مش بتاع صاحب الكود بيظهر للعميل «هذا الكود به مشكلة ولا يمكن استخدامه». التخصيص بيتم تلقائيًا بعد موافقة التسليم أو من زرار الطلب."
      />
      {s ? (
        <Card>
          <div className="badge-row">
            <Badge tone="neutral">الإجمالي {formatNumber(s.total)}</Badge>
            <Badge tone="neutral">مربوط بعملاء {formatNumber(s.bound)}</Badge>
            <Badge tone={s.pool ? 'info' : 'danger'}>متاح للتخصيص {formatNumber(s.pool)}</Badge>
            <Badge tone="neutral">مخصص {formatNumber(s.assigned)}</Badge>
            <Badge tone="success">اتبعت {formatNumber(s.sent)}</Badge>
            <Badge tone="info">استُخدم {formatNumber(s.used)}</Badge>
            {s.flagged ? <Badge tone="danger">طلبات غير مطابقة {formatNumber(s.flagged)}</Badge> : null}
            {s.pendingSync ? <Badge tone="warning">بانتظار المزامنة {formatNumber(s.pendingSync)}</Badge> : null}
          </div>
          <p className="muted small">
            آخر مزامنة مع EasyOrders: {s.lastSyncAt ? formatDateTime(s.lastSyncAt) : 'لم تتم بعد'}. المزامنة بتتم من زرار في لوحة EasyOrders (شوف ملف tools/coupon-sync.html).
          </p>
          {s.bound > 0 && s.pool <= 3 ? <p className="muted small">الأكواد المتاحة قربت تخلص. أنشئ أكواد جديدة في EasyOrders واعمل مزامنة.</p> : null}
        </Card>
      ) : null}

      <Card title="محاولات استخدام غير ناجحة">
        {attempts.data?.items?.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>الوقت</th>
                  <th>الكود</th>
                  <th>الرقم اللي كتبه</th>
                  <th>صاحب الكود</th>
                  <th>السبب</th>
                  <th>بيانات الزائر</th>
                </tr>
              </thead>
              <tbody>
                {attempts.data.items.map((a) => (
                  <tr key={a._id}>
                    <td className="nowrap muted">{formatDateTime(a.createdAt)}</td>
                    <td className="mono" dir="ltr">
                      {a.code.toUpperCase()}
                    </td>
                    <td dir="ltr" className="mono">
                      {a.phoneTyped || '—'}
                      {a.name ? <div className="muted small">{a.name}</div> : null}
                    </td>
                    <td>
                      {a.ownerName || '—'}
                      {a.ownerPhone ? (
                        <div className="muted small mono" dir="ltr">
                          {a.ownerPhone}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <Badge tone="danger">{REASONS[a.reason] || a.reason}</Badge>
                      <div className="muted small">{a.stage === 'submit' ? 'عند تأكيد الطلب' : 'عند تطبيق الكود'}</div>
                    </td>
                    <td>
                      {a.visitorContact ? (
                        <>
                          {a.visitorContact.name || '—'}
                          <div className="muted small mono" dir="ltr">
                            {a.visitorContact.phone || ''}
                          </div>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">لسه محدش حاول يستخدم كود مش بتاعه. أي محاولة هتظهر هنا وهتجيلك إشعار.</p>
        )}
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

      <Card title="استيراد كوبونات EasyOrders">
        <p className="muted small">
          الصق قايمة الكوبونات (JSON) اللي طلعت من زرار المزامنة أو من الملف الجاهز. بيستورد كل الإعدادات كاملة، والأكواد اللي بتبدأ بـ ST30- بتتربط بالعملاء تلقائيًا، والباقي (زي كود داخلي أو تجريبي) بيفضل لـ EasyOrders لحد ما تربطه.
        </p>
        <textarea className="input" rows={3} dir="ltr" placeholder='[{"code":"ST30-A7K2", ...}]' value={importText} onChange={(e) => setImportText(e.target.value)} />
        <Button loading={busy} disabled={!importText.trim()} onClick={importCoupons}>
          استيراد
        </Button>
      </Card>

      <Card title="إضافة أكواد (بالاسم بس)">
        <textarea className="input" rows={2} dir="ltr" placeholder="ST30-A7K2, ST30-B6R5 ... (افصل بمسافة أو فاصلة)" value={codes} onChange={(e) => setCodes(e.target.value)} />
        <Button loading={busy} disabled={!codes.trim()} onClick={add}>
          إضافة
        </Button>
      </Card>

      <Card padded={false}>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data.items.length ? (
          <EmptyState title="لا توجد أكواد بعد" description="استورد الكوبونات من EasyOrders من الأعلى." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>الكود</th>
                  <th>العميل</th>
                  <th>الصلاحية</th>
                  <th>إعدادات EasyOrders</th>
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
                        {c.assigned ? (
                          <>
                            {c.customerName || <span className="muted">—</span>}
                            {c.phoneNormalized && (
                              <div className="muted mono small" dir="ltr">
                                {c.phoneNormalized}
                              </div>
                            )}
                            {c.order?.easyOrdersShortId || c.order?.easyOrdersId ? <div className="muted small">طلب {orderNumber(c.order)}</div> : null}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="nowrap muted">
                        {c.sentAt && c.expiresAt ? (
                          <>
                            {formatDate(c.sentAt)}
                            <div className="small">حتى {formatDate(c.expiresAt)}</div>
                          </>
                        ) : c.phoneNormalized ? (
                          <span className="small">تبدأ لما الكود يتبعت</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {editing === c._id ? (
                          <EditSettings
                            coupon={c}
                            run={run}
                            busy={busy}
                            onDone={() => {
                              setEditing(null);
                              reload({ silent: true });
                            }}
                          />
                        ) : c.settings ? (
                          <>
                            {formatNumber(c.settings.value)}
                            {c.settings.valueType === 'percentage' ? '%' : ''} · {limitLabel(c.settings.usageLimit)}
                            <div className="small">
                              <Badge tone={c.settings.isActive ? 'success' : 'muted'}>{c.settings.isActive ? 'مفعّل' : 'موقوف'}</Badge>{' '}
                              {c.pendingEo ? <Badge tone="warning">بانتظار المزامنة</Badge> : null}
                            </div>
                          </>
                        ) : (
                          <span className="muted small">غير مستورد</span>
                        )}
                      </td>
                      <td>
                        <Badge tone={tone}>{label}</Badge>
                        {c.sentAt ? <div className="muted small">{formatDate(c.sentAt)}{c.sentBy?.name ? ` · ${c.sentBy.name}` : ''}</div> : null}
                        {c.uses > 0 ? <div className="muted small">استُخدم {formatNumber(c.uses)} مرة</div> : null}
                      </td>
                      <td>
                        <div className="badge-stack">
                          {editing !== c._id ? (
                            <Button size="sm" variant="ghost" onClick={() => setEditing(c._id)}>
                              تعديل
                            </Button>
                          ) : null}
                          {c.bound !== false && !c.assigned && perms.field('customerPhone') ? (
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
                          ) : null}
                          {c.assigned ? (
                            dates.id === c._id ? (
                              <div className="badge-stack">
                                <label className="checkbox">
                                  بداية الصلاحية (يوم الإرسال)
                                  <input className="input" type="date" value={dates.sentAt} onChange={(e) => setDates({ ...dates, sentAt: e.target.value })} />
                                </label>
                                <label className="checkbox">
                                  آخر يوم صالح
                                  <input className="input" type="date" value={dates.expiresAt} onChange={(e) => setDates({ ...dates, expiresAt: e.target.value })} />
                                </label>
                                <div className="badge-row">
                                  <Button
                                    size="sm"
                                    loading={busy}
                                    onClick={() =>
                                      run(async () => {
                                        const body = {};
                                        if (dates.sentAt !== dates.origSent) body.sentAt = dates.sentAt ? `${dates.sentAt}T12:00:00.000Z` : null;
                                        if (dates.expiresAt && dates.expiresAt !== dates.origEnd) body.expiresAt = `${dates.expiresAt}T12:00:00.000Z`;
                                        if (!Object.keys(body).length) throw new Error('مفيش تاريخ اتغيّر');
                                        await api.patch(`/admin/coupons/${c._id}/dates`, body);
                                        setDates({ id: null });
                                      }, 'تم تعديل التواريخ')
                                    }
                                  >
                                    حفظ
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => setDates({ id: null })}>
                                    إلغاء
                                  </Button>
                                </div>
                                <p className="muted small">لو غيّرت البداية بس، النهاية بتتحسب 365 يوم بعدها. ولو مسحت البداية يبقى الكود «لم يُرسل».</p>
                              </div>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  const sentAt = c.sentAt ? c.sentAt.slice(0, 10) : '';
                                  const expiresAt = c.expiresAt ? c.expiresAt.slice(0, 10) : '';
                                  setDates({ id: c._id, sentAt, expiresAt, origSent: sentAt, origEnd: expiresAt });
                                }}
                              >
                                تعديل التواريخ
                              </Button>
                            )
                          ) : null}
                          {c.assigned ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={busy}
                              onClick={() => {
                                if (c.sentAt && !window.confirm('الكود ده اتبعت للعميل. تلغي تخصيصه؟ تقدر ترجّعه بزرار «تراجع».')) return;
                                run(() => api.post(`/admin/coupons/${c._id}/release`), 'تم إلغاء التخصيص');
                              }}
                            >
                              إلغاء التخصيص
                            </Button>
                          ) : null}
                          {c.lastChange ? (
                            <Button size="sm" variant="secondary" loading={busy} onClick={() => run(() => api.post(`/admin/coupons/${c._id}/undo`), 'تم التراجع')}>
                              تراجع عن: {c.lastChange.label}
                            </Button>
                          ) : null}
                        </div>
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
