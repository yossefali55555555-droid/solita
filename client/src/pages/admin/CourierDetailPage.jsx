import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Button, Card, ConfirmDialog, DefinitionList, Field, Modal, PageHeader, StatCard } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { DeliveryStatusBadge, ReviewStatusBadge, SourceStatusBadge } from '../../components/StatusBadges.jsx';
import { Timeline } from '../../components/Timeline.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDateTime, formatMoney, toAsciiDigits } from '../../utils/format.js';

export function CourierDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.get(`/admin/couriers/${id}`), [id]);
  const events = useAsync(() => api.get(`/admin/couriers/${id}/events`), [id]);
  const [editOpen, setEditOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [toggleOpen, setToggleOpen] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});

  const refresh = () => {
    reload({ silent: true });
    events.reload({ silent: true });
  };
  const fieldErrors = (err) =>
    err.details ? Object.fromEntries(err.details.map((d) => [d.path, d.message])) : { form: err.message };

  const [save, saving] = useAction(async () => {
    setErrors({});
    try {
      await api.patch(`/admin/couriers/${id}`, { name: form.name, phone: toAsciiDigits(form.phone), email: form.email || null });
      toast.success('تم حفظ البيانات');
      setEditOpen(false);
      refresh();
    } catch (err) {
      setErrors(fieldErrors(err));
    }
  });

  const [resetPassword, resetting] = useAction(async () => {
    setErrors({});
    try {
      await api.post(`/admin/couriers/${id}/password`, { newPassword: password });
      toast.success('تم تعيين كلمة مرور مؤقتة وتسجيل خروج المندوب من كل الأجهزة');
      setPwOpen(false);
      setPassword('');
      refresh();
    } catch (err) {
      setErrors(fieldErrors(err));
    }
  });

  const [toggle, toggling] = useAction(async () => {
    try {
      const res = await api.patch(`/admin/couriers/${id}/active`, { isActive: !data.courier.isActive });
      toast.success(res.courier.isActive ? 'تم تفعيل الحساب' : 'تم إيقاف الحساب وتسجيل خروجه');
      if (!res.courier.isActive && res.openOrders > 0) {
        toast.info(`لدى المندوب ${res.openOrders} طلب مفتوح. أعد تعيينها لمندوب آخر.`);
      }
      setToggleOpen(false);
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  });

  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const { courier, activeOrders, recentReviews, cash } = data;

  return (
    <>
      <PageHeader
        back="/admin/couriers"
        title={courier.name}
        subtitle={courier.isActive ? 'حساب مفعل' : 'حساب موقوف'}
        actions={
          <>
            <Button variant="secondary" onClick={() => { setErrors({}); setForm({ name: courier.name, phone: courier.phone, email: courier.email || '' }); setEditOpen(true); }}>تعديل</Button>
            <Button variant="secondary" onClick={() => { setErrors({}); setPwOpen(true); }}>إعادة تعيين كلمة المرور</Button>
            <Button variant={courier.isActive ? 'danger' : 'primary'} onClick={() => setToggleOpen(true)}>
              {courier.isActive ? 'إيقاف الحساب' : 'تفعيل الحساب'}
            </Button>
          </>
        }
      />

      <div className="grid-2">
        <Card title="البيانات">
          <DefinitionList
            items={[
              ['الهاتف', <span className="mono" dir="ltr">{courier.phone}</span>],
              ['البريد', courier.email],
              ['الحالة', courier.isActive ? <Badge tone="success">مفعل</Badge> : <Badge tone="muted">موقوف</Badge>],
              ['آخر دخول', formatDateTime(courier.lastLoginAt)],
              courier.mustChangePassword && ['كلمة المرور', 'مؤقتة — يجب تغييرها عند الدخول'],
            ]}
          />
        </Card>
        <Card title="النقدية">
          <div className="stats-grid stats-grid--compact">
            <StatCard label="مع المندوب (غير مُسلّم)" value={formatMoney(cash.unremittedExpected)} tone="warning" />
            <StatCard label="بانتظار التحقق" value={formatMoney(cash.awaitingVerification)} tone="info" />
            <StatCard label="تم التحقق منه" value={formatMoney(cash.verified)} tone="success" />
            <StatCard label="فروقات" value={formatMoney(cash.discrepancy)} tone={cash.discrepancy ? 'danger' : 'neutral'} />
          </div>
          <Link className="link" to={`/admin/cash?courier=${courier.id}`}>عرض التسويات</Link>
        </Card>
      </div>

      <Card title={`الطلبات الحالية (${activeOrders.length})`}>
        {!activeOrders.length ? (
          <EmptyState title="لا توجد طلبات مفتوحة" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>الطلب</th><th>العميل</th><th>الإجمالي</th><th>الحالات</th><th>وقت التعيين</th></tr></thead>
              <tbody>
                {activeOrders.map((o) => (
                  <tr key={o._id}>
                    <td><Link className="link mono" to={`/admin/orders/${o._id}`}>{o.easyOrdersId}</Link></td>
                    <td>{o.customer?.name} <span className="muted small">{o.customer?.government}</span></td>
                    <td className="nowrap">{formatMoney(o.totalAmount)}</td>
                    <td><div className="badge-stack"><DeliveryStatusBadge status={o.deliveryStatus} /><SourceStatusBadge status={o.sourceStatus} /></div></td>
                    <td className="muted nowrap">{formatDateTime(o.assignedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="سجل التسليم">
        {!recentReviews.length ? (
          <EmptyState title="لا توجد تقارير تسليم" />
        ) : (
          <ul className="simple-list">
            {recentReviews.map((r) => (
              <li key={r._id}>
                <div className="badge-row">
                  <ReviewStatusBadge status={r.status} />
                  <Link className="link mono" to={`/admin/reviews/${r._id}`}>{r.order?.easyOrdersId}</Link>
                  <span className="muted small">{formatDateTime(r.submittedAt)}</span>
                </div>
                {r.rejectionReason && <p className="small">سبب الرفض: {r.rejectionReason}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="سجل الحساب">
        {events.data ? <Timeline events={events.data.items} /> : <LoadingState />}
      </Card>

      <Modal open={editOpen} title="تعديل بيانات المندوب" onClose={() => setEditOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setEditOpen(false)} disabled={saving}>إلغاء</Button><Button loading={saving} onClick={save}>حفظ</Button></>}>
        <Field label="الاسم" required error={errors.name}>{(fid) => <input id={fid} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="رقم الموبايل" required error={errors.phone}>{(fid) => <input id={fid} className="input" dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
        <Field label="البريد الإلكتروني" error={errors.email}>{(fid) => <input id={fid} className="input" dir="ltr" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
        {errors.form && <p className="form-error">{errors.form}</p>}
      </Modal>

      <Modal open={pwOpen} title="إعادة تعيين كلمة المرور" onClose={() => setPwOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setPwOpen(false)} disabled={resetting}>إلغاء</Button><Button loading={resetting} onClick={resetPassword}>تعيين</Button></>}>
        <p>سيتم تسجيل خروج المندوب من كل الأجهزة، وسيُطلب منه اختيار كلمة مرور جديدة عند الدخول.</p>
        <Field label="كلمة مرور مؤقتة" required error={errors.newPassword || errors.form} hint="10 أحرف على الأقل، حروف وأرقام">
          {(fid) => <input id={fid} className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
      </Modal>

      <ConfirmDialog
        open={toggleOpen}
        title={courier.isActive ? 'إيقاف حساب المندوب' : 'تفعيل حساب المندوب'}
        message={courier.isActive ? 'لن يتمكن المندوب من الدخول، وسيتم إنهاء جلساته الحالية.' : 'سيتمكن المندوب من تسجيل الدخول مرة أخرى.'}
        tone={courier.isActive ? 'danger' : 'primary'}
        confirmLabel={courier.isActive ? 'إيقاف' : 'تفعيل'}
        loading={toggling}
        onClose={() => setToggleOpen(false)}
        onConfirm={toggle}
      />
    </>
  );
}
