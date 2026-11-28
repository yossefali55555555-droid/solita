import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { PageTabs } from '../../components/PageTabs.jsx';
import { Badge, Button, Card, ConfirmDialog, Field, Modal, PageHeader } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAuth } from '../../features/auth/AuthContext.jsx';
import { EMPTY_PERMISSIONS, PermissionEditor, summarizePermissions } from '../../features/staff/PermissionEditor.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDateTime, toAsciiDigits } from '../../utils/format.js';

import { STATUS_TONE } from '../../features/staff/status.js';

/** The administrator's staff page: accounts, permission templates, ready-made WhatsApp texts. */
export function StaffPage() {
  const { user } = useAuth();
  const catalog = useAsync(() => api.get('/admin/staff/catalog'), []);
  if (user?.role !== 'admin') return <Navigate to="/admin" replace />;
  return (
    <>
      <PageHeader title="المودريتورز" subtitle="حسابات الفريق وصلاحياتهم ونصوص واتساب الجاهزة" />
      {catalog.error && <ErrorState error={catalog.error} onRetry={catalog.reload} />}
      {catalog.loading && !catalog.data && <LoadingState />}
      {catalog.data && (
        <PageTabs
          label="أقسام صفحة المودريتورز"
          tabs={[
            { key: 'accounts', label: 'الحسابات', content: <AccountsTab catalog={catalog.data} /> },
            { key: 'templates', label: 'قوالب الصلاحيات', content: <TemplatesTab catalog={catalog.data} /> },
            { key: 'whatsapp', label: 'نصوص واتساب', content: <WhatsAppTextsTab /> },
          ]}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- shown once

function SecretModal({ secret, onClose }) {
  const toast = useToast();
  if (!secret) return null;
  const isInvite = Boolean(secret.invite);
  const value = isInvite ? secret.invite.link || secret.invite.token : secret.tempPassword;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('تم النسخ');
    } catch {
      toast.error('تعذر النسخ. انسخه يدويًا.');
    }
  };
  return (
    <Modal open title={isInvite ? 'لينك الدعوة' : 'كلمة المرور المؤقتة'} onClose={onClose} footer={<Button onClick={onClose}>تم، حفظتها</Button>}>
      <p>
        {isInvite
          ? 'أرسل هذا اللينك للموظف. يعمل مرة واحدة فقط ويبطل بعد 48 ساعة، ولن يُعرض هنا مرة أخرى.'
          : 'سلّم هذه الكلمة للموظف. سيُطلب منه تغييرها عند أول دخول، ولن تُعرض هنا مرة أخرى.'}
      </p>
      <div className="secret-box" dir="ltr">{value}</div>
      <div className="row-between">
        <Button variant="secondary" onClick={copy}>نسخ</Button>
        {isInvite && <span className="muted">ينتهي: {formatDateTime(secret.invite.expiresAt)}</span>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- accounts

const EMPTY_FORM = { name: '', phone: '', mode: 'password', password: '', templateName: '', permissions: EMPTY_PERMISSIONS };

function AccountsTab({ catalog }) {
  const toast = useToast();
  const list = useAsync(() => api.get('/admin/staff'), []);
  const templates = useAsync(() => api.get('/admin/templates'), []);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [secret, setSecret] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const pickTemplate = (name) => {
    const t = templates.data?.items.find((x) => x.name === name);
    setForm((f) => ({
      ...f,
      templateName: name,
      permissions: t ? { sections: { ...t.sections }, dangerous: [...t.dangerous], fields: [...t.fields] } : EMPTY_PERMISSIONS,
    }));
  };

  const [create, creating] = useAction(async () => {
    setErrors({});
    try {
      const res = await api.post('/admin/staff', {
        name: form.name,
        phone: toAsciiDigits(form.phone),
        mode: form.mode,
        password: form.mode === 'password' && form.password ? form.password : undefined,
        templateName: form.templateName || undefined,
        permissions: { ...form.permissions, fields: form.permissions.fields.map((key) => ({ key, until: null })) },
      });
      setOpen(false);
      setForm(EMPTY_FORM);
      setSecret(res);
      list.reload({ silent: true });
      templates.reload({ silent: true });
    } catch (err) {
      if (err.details) setErrors(Object.fromEntries(err.details.map((d) => [d.path, d.message])));
      else setErrors({ form: err.message });
      toast.error(err.message);
    }
  });

  return (
    <>
      <Card
        title="حسابات المودريتورز"
        actions={<Button onClick={() => { setErrors({}); setForm(EMPTY_FORM); setOpen(true); }}>إضافة حساب</Button>}
        padded={false}
      >
        {list.loading && !list.data ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : !list.data.items.length ? (
          <EmptyState title="لا توجد حسابات بعد" description="أضف أول موظف واختر له قالب صلاحيات." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>الاسم</th>
                  <th>الهاتف</th>
                  <th>الحالة</th>
                  <th>القالب</th>
                  <th>الصلاحيات</th>
                  <th>آخر دخول</th>
                  <th>جلسات نشطة</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <Link className="link" to={`/admin/staff/${a.id}`}>{a.name}</Link>
                    </td>
                    <td className="mono" dir="ltr">{a.phone}</td>
                    <td><Badge tone={STATUS_TONE[a.status]}>{a.statusLabel}</Badge></td>
                    <td>{a.templateName || '—'}</td>
                    <td className="muted">{summarizePermissions(catalog, a.permissions)}</td>
                    <td>{a.lastLoginAt ? formatDateTime(a.lastLoginAt) : 'لم يدخل بعد'}</td>
                    <td>{a.activeSessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={open}
        title="إضافة حساب مودريتور"
        size="lg"
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
        <Field label="رقم الموبايل" required error={errors.phone} hint="يدخل به الموظف">
          {(id) => <input id={id} className="input" dir="ltr" inputMode="tel" placeholder="01xxxxxxxxx" value={form.phone} onChange={set('phone')} autoComplete="off" />}
        </Field>
        <fieldset className="radio-list">
          <legend>طريقة التفعيل</legend>
          <label className="radio">
            <input type="radio" name="mode" checked={form.mode === 'password'} onChange={() => setForm((f) => ({ ...f, mode: 'password' }))} />
            <span>كلمة سر مؤقتة تُعرض مرة واحدة، ويغيّرها الموظف عند أول دخول</span>
          </label>
          <label className="radio">
            <input type="radio" name="mode" checked={form.mode === 'invite'} onChange={() => setForm((f) => ({ ...f, mode: 'invite' }))} />
            <span>لينك دعوة يعيّن به الموظف كلمة سره بنفسه (يعمل مرة واحدة ولمدة 48 ساعة)</span>
          </label>
        </fieldset>
        {form.mode === 'password' && (
          <Field label="كلمة السر المؤقتة (اختياري)" error={errors.password} hint="اتركها فارغة لتوليد كلمة سر عشوائية">
            {(id) => <input id={id} className="input" dir="ltr" value={form.password} onChange={set('password')} autoComplete="off" />}
          </Field>
        )}
        <Field label="قالب الصلاحيات" hint="تُنسخ صلاحيات القالب إلى الحساب، ويمكن تعديلها بعد ذلك أو البدء من الصفر">
          {(id) => (
            <select id={id} className="input" value={form.templateName} onChange={(e) => pickTemplate(e.target.value)}>
              <option value="">من الصفر (بدون صلاحيات)</option>
              {templates.data?.items.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>
          )}
        </Field>
        <PermissionEditor
          catalog={catalog}
          value={form.permissions}
          onChange={(permissions) => setForm((f) => ({ ...f, permissions }))}
          fieldNote="لمنح رقم العميل لفترة محددة فقط، أنشئ الحساب أولًا ثم استخدم «منح مؤقت» من صفحة الحساب."
        />
        {errors.form && <p className="form-error" role="alert">{errors.form}</p>}
      </Modal>
      <SecretModal secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}

// ---------------------------------------------------------------- templates

function TemplatesTab({ catalog }) {
  const toast = useToast();
  const list = useAsync(() => api.get('/admin/templates'), []);
  const [editing, setEditing] = useState(null); // { id?, name, description, perms }
  const [error, setError] = useState('');
  const [applyFor, setApplyFor] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const startEdit = (t) =>
    setEditing(
      t
        ? { id: t.id, name: t.name, description: t.description, perms: { sections: { ...t.sections }, dangerous: [...t.dangerous], fields: [...t.fields] } }
        : { name: '', description: '', perms: EMPTY_PERMISSIONS },
    );

  const [save, saving] = useAction(async () => {
    setError('');
    const body = { name: editing.name, description: editing.description, ...editing.perms };
    try {
      const res = editing.id ? await api.patch(`/admin/templates/${editing.id}`, body) : await api.post('/admin/templates', body);
      toast.success('تم حفظ القالب');
      setEditing(null);
      list.reload({ silent: true });
      if (editing.id && res.affected > 0) setApplyFor({ id: editing.id, name: editing.name });
    } catch (err) {
      setError(err.message);
    }
  });

  const [remove, removing] = useAction(async () => {
    try {
      await api.post(`/admin/templates/${deleting.id}/delete`);
      toast.success('تم حذف القالب');
      setDeleting(null);
      list.reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
      setDeleting(null);
    }
  });

  return (
    <>
      <Card title="قوالب الصلاحيات" actions={<Button onClick={() => startEdit(null)}>قالب جديد</Button>}>
        <p className="muted">الحساب ينسخ القالب عند إنشائه. تعديل القالب لا يغيّر الحسابات القائمة إلا إذا ضغطت «طبّق على الحسابات» وراجعت المقارنة.</p>
        {list.loading && !list.data ? (
          <LoadingState />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : (
          <div className="tpl-list">
            {list.data.items.map((t) => (
              <div key={t.id} className="tpl-item">
                <div>
                  <strong>{t.name}</strong> <Badge tone="neutral">{t.accounts} حساب</Badge>
                  <div className="muted">{summarizePermissions(catalog, t)}</div>
                </div>
                <div className="tpl-item__actions">
                  <Button size="sm" variant="secondary" onClick={() => startEdit(t)}>عرض وتعديل</Button>
                  {t.accounts > 0 && <Button size="sm" variant="secondary" onClick={() => setApplyFor({ id: t.id, name: t.name })}>طبّق على {t.accounts} حساب</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(t)}>حذف</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={Boolean(editing)}
        title={editing?.id ? `قالب «${editing.name}»` : 'قالب جديد'}
        size="lg"
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving}>إلغاء</Button>
            <Button loading={saving} onClick={save}>حفظ القالب</Button>
          </>
        }
      >
        {editing && (
          <>
            <Field label="اسم القالب" required>
              {(id) => <input id={id} className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />}
            </Field>
            <Field label="وصف (اختياري)">
              {(id) => <input id={id} className="input" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />}
            </Field>
            <PermissionEditor catalog={catalog} value={editing.perms} onChange={(perms) => setEditing({ ...editing, perms })} />
            {error && <p className="form-error" role="alert">{error}</p>}
          </>
        )}
      </Modal>
      <ConfirmDialog
        open={Boolean(deleting)}
        title="حذف القالب"
        message={`حذف قالب «${deleting?.name}»؟ لا يؤثر على الحسابات (القالب المستخدم لا يُحذف).`}
        confirmLabel="حذف"
        tone="danger"
        loading={removing}
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
      {applyFor && <ApplyModal template={applyFor} onClose={() => { setApplyFor(null); list.reload({ silent: true }); }} />}
    </>
  );
}

/** «Apply to N accounts»: each account's permissions before and after, then apply. */
function ApplyModal({ template, onClose }) {
  const toast = useToast();
  const preview = useAsync(() => api.get(`/admin/templates/${template.id}/apply-preview`), [template.id]);
  const [picked, setPicked] = useState(null);
  const accounts = preview.data?.accounts || [];
  const selected = picked || accounts.filter((a) => a.changed).map((a) => a.accountId);
  const toggle = (id) => setPicked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  const [apply, applying] = useAction(async () => {
    try {
      const res = await api.post(`/admin/templates/${template.id}/apply`, { accountIds: selected });
      toast.success(`طُبّق القالب على ${res.applied} حساب`);
      onClose();
    } catch (err) {
      toast.error(err.message);
    }
  });

  return (
    <Modal
      open
      title={`تطبيق قالب «${template.name}» على الحسابات`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={applying}>إغلاق</Button>
          <Button loading={applying} disabled={!selected.length} onClick={apply}>طبّق على {selected.length} حساب</Button>
        </>
      }
    >
      {preview.loading && !preview.data ? <LoadingState /> : preview.error ? <ErrorState error={preview.error} onRetry={preview.reload} /> : !accounts.length ? <p>لا توجد حسابات على هذا القالب.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th /><th>الحساب</th><th>التغيير (قبل ← بعد)</th></tr></thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.accountId}>
                  <td><input type="checkbox" aria-label={`اختيار ${a.name}`} checked={selected.includes(a.accountId)} disabled={!a.changed} onChange={() => toggle(a.accountId)} /></td>
                  <td>{a.name} {a.status !== 'active' && <Badge tone="muted">{a.status === 'invited' ? 'مدعو' : 'موقوف'}</Badge>}</td>
                  <td>{a.changed ? <ul className="plain-list">{a.changes.map((c) => <li key={c}>{c}</li>)}</ul> : <span className="muted">لا تغيير</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- WhatsApp texts

const WA_FIELDS = [
  ['cartWhatsappTemplate', 'رسالة السلة المتروكة', '{name} الاسم · {items} المنتجات · {total} الإجمالي'],
  ['couponWhatsappTemplate', 'رسالة الكوبون بعد التسليم', '{name} · {code} الكود · {start} و{end} فترة الصلاحية · {store} رابط المتجر'],
  ['confirmWhatsappTemplate', 'رسالة تأكيد بيانات الطلب', '{name} · {num} رقم الطلب · {items} · {total} · {payment} · {address}'],
];

function WhatsAppTextsTab() {
  const toast = useToast();
  const state = useAsync(() => api.get('/admin/wa-templates'), []);
  const [draft, setDraft] = useState(null);
  const value = draft || state.data?.templates;

  const [save, saving] = useAction(async () => {
    try {
      await api.patch('/admin/wa-templates', draft);
      toast.success('تم حفظ نصوص واتساب');
      setDraft(null);
      state.reload({ silent: true });
    } catch (err) {
      toast.error(err.message);
    }
  });

  if (state.loading && !state.data) return <LoadingState />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  return (
    <Card title="نصوص رسائل واتساب الجاهزة" actions={<Button loading={saving} disabled={!draft} onClick={save}>حفظ</Button>}>
      <p className="muted">هذه النصوص يعدّلها الأدمن فقط. الموظف يرى النص جاهزًا ويفتح المحادثة ليرسله، ولا يستطيع تغيير القالب.</p>
      {WA_FIELDS.map(([key, label, hint]) => (
        <Field key={key} label={label} hint={`المتغيرات: ${hint}`}>
          {(id) => <textarea id={id} className="input" rows={6} value={value[key]} onChange={(e) => setDraft({ ...value, [key]: e.target.value })} />}
        </Field>
      ))}
    </Card>
  );
}
