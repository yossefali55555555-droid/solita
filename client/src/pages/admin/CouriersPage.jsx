import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Field, Modal, PageHeader, Pagination } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAction, useAsync, useDebouncedValue } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { toAsciiDigits } from '../../utils/format.js';

const EMPTY = { name: '', phone: '', email: '', password: '' };

export function CouriersPage() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebouncedValue(q);
  const { data, error, loading, reload } = useAsync(
    () => api.get('/admin/couriers', { q: debounced, active, page, limit: 20 }),
    [debounced, active, page],
  );
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const [create, creating] = useAction(async () => {
    setErrors({});
    try {
      await api.post('/admin/couriers', {
        name: form.name,
        phone: toAsciiDigits(form.phone),
        email: form.email || undefined,
        password: form.password,
      });
      toast.success('تم إنشاء حساب المندوب. سيُطلب منه تغيير كلمة المرور عند أول دخول.');
      setOpen(false);
      setForm(EMPTY);
      reload({ silent: true });
    } catch (err) {
      if (err.details) setErrors(Object.fromEntries(err.details.map((d) => [d.path, d.message])));
      else setErrors({ form: err.message });
    }
  });

  return (
    <>
      <PageHeader
        title="المندوبون"
        actions={<Button onClick={() => { setErrors({}); setOpen(true); }}>إضافة مندوب</Button>}
      />
      <Card>
        <div className="filters">
          <input className="input filters__search" type="search" placeholder="بحث بالاسم أو الهاتف" aria-label="بحث" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <select className="input" aria-label="الحالة" value={active} onChange={(e) => { setActive(e.target.value); setPage(1); }}>
            <option value="">الكل</option>
            <option value="true">مفعل</option>
            <option value="false">موقوف</option>
          </select>
        </div>
      </Card>
      <Card padded={false}>
        {loading && !data ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : !data.items.length ? (
          <EmptyState title="لا يوجد مندوبون" description="أضف أول مندوب للبدء في توزيع الطلبات." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>الاسم</th>
                  <th>الهاتف</th>
                  <th>الحالة</th>
                  <th>معيّنة</th>
                  <th>خارج للتوصيل</th>
                  <th>بانتظار المراجعة</th>
                  <th>تسليمات معتمدة</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link className="link" to={`/admin/couriers/${c.id}`}>{c.name}</Link>
                      {c.isDemo && <Badge tone="demo">تجريبي</Badge>}
                    </td>
                    <td className="mono" dir="ltr">{c.phone}</td>
                    <td>{c.isActive ? <Badge tone="success">مفعل</Badge> : <Badge tone="muted">موقوف</Badge>}</td>
                    <td>{c.workload.assigned}</td>
                    <td>{c.workload.outForDelivery}</td>
                    <td>{c.workload.pendingReview}</td>
                    <td>{c.workload.delivered}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination pagination={data?.pagination} onPage={setPage} />
      </Card>

      <Modal
        open={open}
        title="إضافة مندوب جديد"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={creating}>إلغاء</Button>
            <Button loading={creating} onClick={create}>إنشاء الحساب</Button>
          </>
        }
      >
        <Field label="الاسم" required error={errors.name}>
          {(id) => <input id={id} className="input" value={form.name} onChange={set('name')} autoComplete="off" />}
        </Field>
        <Field label="رقم الموبايل" required error={errors.phone} hint="يستخدمه المندوب لتسجيل الدخول">
          {(id) => <input id={id} className="input" dir="ltr" inputMode="tel" placeholder="01xxxxxxxxx" value={form.phone} onChange={set('phone')} autoComplete="off" />}
        </Field>
        <Field label="البريد الإلكتروني (اختياري)" error={errors.email}>
          {(id) => <input id={id} className="input" dir="ltr" type="email" value={form.email} onChange={set('email')} autoComplete="off" />}
        </Field>
        <Field label="كلمة مرور مؤقتة" required error={errors.password} hint="10 أحرف على الأقل، حروف وأرقام. سيغيّرها المندوب عند أول دخول.">
          {(id) => <input id={id} className="input" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />}
        </Field>
        {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
      </Modal>
    </>
  );
}
