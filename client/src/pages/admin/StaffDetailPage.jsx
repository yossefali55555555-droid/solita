import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { Badge, Button, Card, ConfirmDialog, DefinitionList, Field, Modal, PageHeader } from '../../components/ui.jsx';
import { ErrorState, LoadingState } from '../../components/States.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useAuth } from '../../features/auth/AuthContext.jsx';
import { PermissionEditor } from '../../features/staff/PermissionEditor.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatDateTime, toAsciiDigits } from '../../utils/format.js';
import { STATUS_TONE } from '../../features/staff/status.js';

const toEditor = (account) => ({
  sections: { ...account.permissions.sections },
  dangerous: [...account.permissions.dangerous],
  // Only permanent grants are edited here; a temporary grant has its own panel.
  fields: account.permissions.fields.filter((g) => !g.until).map((g) => g.key),
});

export function StaffDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const catalog = useAsync(() => api.get('/admin/staff/catalog'), []);
  const state = useAsync(() => api.get(`/admin/staff/${id}`), [id]);
  if (user?.role !== 'admin') return <Navigate to="/admin" replace />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (!state.data || !catalog.data) return <LoadingState />;
  return <Detail id={id} account={state.data.account} catalog={catalog.data} refresh={() => state.reload({ silent: true })} />;
}

function Detail({ id, account, catalog, refresh }) {
  const toast = useToast();
  const [perms, setPerms] = useState(() => toEditor(account));
  const [profile, setProfile] = useState({ name: account.name, phone: account.phone });
  const [secret, setSecret] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'password' | 'sessions' | 'disable'
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantDate, setGrantDate] = useState('');

  // A fresh copy from the server (after a save, a grant, a template apply) replaces the editor state.
  const [seen, setSeen] = useState(account);
  if (seen !== account) {
    setSeen(account);
    setPerms(toEditor(account));
    setProfile({ name: account.name, phone: account.phone });
  }

  const fail = (err) => toast.error(err.message);

  /** Permanent choices from the editor, plus a temporary grant that is still running. */
  const payloadFields = () => {
    const fields = perms.fields.map((key) => ({ key, until: null }));
    for (const g of account.permissions.fields) if (g.until && !perms.fields.includes(g.key)) fields.push({ key: g.key, until: g.until });
    return fields;
  };

  const [savePerms, savingPerms] = useAction(async () => {
    try {
      await api.patch(`/admin/staff/${id}`, { permissions: { sections: perms.sections, dangerous: perms.dangerous, fields: payloadFields() }, templateName: account.templateName || 'مخصص' });
      toast.success('تم حفظ الصلاحيات، وتسري من الطلب التالي للموظف');
      refresh();
    } catch (err) {
      fail(err);
    }
  });

  const [saveProfile, savingProfile] = useAction(async () => {
    try {
      await api.patch(`/admin/staff/${id}`, { name: profile.name, phone: toAsciiDigits(profile.phone) });
      toast.success('تم حفظ البيانات');
      refresh();
    } catch (err) {
      fail(err);
    }
  });

  const [run, running] = useAction(async () => {
    try {
      if (confirm === 'password') setSecret(await api.post(`/admin/staff/${id}/password`));
      if (confirm === 'sessions') {
        const res = await api.post(`/admin/staff/${id}/sessions/revoke`);
        toast.success(`أُنهيت ${res.revoked} جلسة`);
      }
      if (confirm === 'disable') {
        await api.post(`/admin/staff/${id}/status`, { status: 'disabled' });
        toast.success('تم إيقاف الحساب وإنهاء جلساته');
      }
      setConfirm(null);
      refresh();
    } catch (err) {
      setConfirm(null);
      fail(err);
    }
  });

  const [enable, enabling] = useAction(async () => {
    try {
      const res = await api.post(`/admin/staff/${id}/status`, { status: 'active' });
      toast.success(res.account.status === 'invited' ? 'الحساب لم يقبل دعوته بعد، ولّد لينك دعوة جديدًا' : 'تم تفعيل الحساب');
      refresh();
    } catch (err) {
      fail(err);
    }
  });

  const [newInvite, creatingInvite] = useAction(async () => {
    try {
      setSecret(await api.post(`/admin/staff/${id}/invite`));
      refresh();
    } catch (err) {
      fail(err);
    }
  });

  const [grant, granting] = useAction(async (duration) => {
    try {
      await api.post(`/admin/staff/${id}/fields/customerPhone/grant`, { duration, until: duration === 'custom' ? new Date(grantDate).toISOString() : undefined });
      toast.success('تم منح رقم العميل مؤقتًا');
      setGrantOpen(false);
      refresh();
    } catch (err) {
      fail(err);
    }
  });

  const [revokeGrant, revoking] = useAction(async () => {
    try {
      await api.post(`/admin/staff/${id}/fields/customerPhone/revoke`);
      toast.success('تم سحب رقم العميل');
      refresh();
    } catch (err) {
      fail(err);
    }
  });

  const [revokeOne] = useAction(async (sessionId) => {
    try {
      await api.post(`/admin/staff/${id}/sessions/${sessionId}/revoke`);
      refresh();
    } catch (err) {
      fail(err);
    }
  });

  const phoneGrant = account.phoneGrant;
  const confirmText = {
    password: ['إعادة تعيين كلمة السر', `سيتم إنهاء كل جلسات «${account.name}» وتوليد كلمة سر مؤقتة تظهر لك مرة واحدة.`],
    sessions: ['طرد من كل الجلسات', `سيخرج «${account.name}» من كل أجهزته فورًا.`],
    disable: ['إيقاف الحساب', `سيتوقف «${account.name}» عن الدخول فورًا وتُنهى كل جلساته ولينكات الدعوة غير المستخدمة.`],
  };

  return (
    <>
      <PageHeader
        back="/admin/staff"
        title={account.name}
        subtitle={account.templateName ? `قالب: ${account.templateName}` : undefined}
        actions={<Badge tone={STATUS_TONE[account.status]}>{account.statusLabel}</Badge>}
      />

      <div className="grid-2">
        <Card title="بيانات الحساب">
          <DefinitionList
            items={[
              ['آخر دخول', account.lastLoginAt ? formatDateTime(account.lastLoginAt) : 'لم يدخل بعد'],
              ['أُنشئ في', formatDateTime(account.createdAt)],
              account.mustChangePassword && ['كلمة السر', 'مؤقتة، يغيّرها عند أول دخول'],
              account.invite && ['لينك الدعوة', `ينتهي ${formatDateTime(account.invite.expiresAt)}`],
            ]}
          />
          <Field label="الاسم">{(fid) => <input id={fid} className="input" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />}</Field>
          <Field label="رقم الموبايل">{(fid) => <input id={fid} className="input" dir="ltr" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />}</Field>
          <Button variant="secondary" loading={savingProfile} disabled={profile.name === account.name && profile.phone === account.phone} onClick={saveProfile}>حفظ البيانات</Button>
        </Card>

        <Card title="التحكم في الحساب">
          <div className="stack">
            {account.status === 'disabled' ? (
              <Button loading={enabling} onClick={enable}>إعادة تفعيل الحساب</Button>
            ) : (
              <Button variant="danger" onClick={() => setConfirm('disable')}>إيقاف الحساب</Button>
            )}
            {account.status === 'invited' ? (
              <Button variant="secondary" loading={creatingInvite} onClick={newInvite}>لينك دعوة جديد (يلغي القديم)</Button>
            ) : (
              <Button variant="secondary" onClick={() => setConfirm('password')}>إعادة تعيين كلمة السر</Button>
            )}
            <Button variant="secondary" onClick={() => setConfirm('sessions')} disabled={!account.sessions.length}>طرد من كل الجلسات ({account.sessions.length})</Button>
          </div>
        </Card>
      </div>

      <Card title="رقم العميل" className="mt">
        <p className="muted">منح رقم العميل لفترة محددة لموظف يحتاج التواصل مع عميل، ثم يزول تلقائيًا أو تسحبه بزر واحد.</p>
        {phoneGrant ? (
          <p>
            <Badge tone="success">ممنوح</Badge>{' '}
            {phoneGrant.until ? `مؤقتًا حتى ${formatDateTime(phoneGrant.until)}` : 'بشكل دائم (من الصلاحيات)'}
          </p>
        ) : (
          <p><Badge tone="muted">غير ممنوح</Badge></p>
        )}
        <div className="row-gap">
          <Button variant="secondary" onClick={() => setGrantOpen(true)}>منح مؤقت</Button>
          {phoneGrant?.until && <Button variant="danger" loading={revoking} onClick={revokeGrant}>سحب الآن</Button>}
        </div>
      </Card>

      <Card title="الصلاحيات" className="mt" actions={<Button loading={savingPerms} onClick={savePerms}>حفظ الصلاحيات</Button>}>
        <PermissionEditor catalog={catalog} value={perms} onChange={setPerms} />
      </Card>

      <Card title="الجلسات النشطة" className="mt" padded={false}>
        {!account.sessions.length ? (
          <p className="muted pad">لا توجد جلسات نشطة.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>الجهاز</th><th>بدأت</th><th>آخر نشاط</th><th>تنتهي</th><th /></tr></thead>
              <tbody>
                {account.sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.device}</td>
                    <td>{formatDateTime(s.createdAt)}</td>
                    <td>{formatDateTime(s.lastSeenAt)}</td>
                    <td>{formatDateTime(s.expiresAt)}</td>
                    <td><Button size="sm" variant="ghost" onClick={() => revokeOne(s.id)}>إنهاء</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="muted"><Link className="link" to="/admin/activity">راجع نشاط هذا الحساب في صفحة النشاطات</Link></p>

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm ? confirmText[confirm][0] : ''}
        message={confirm ? confirmText[confirm][1] : ''}
        tone={confirm === 'disable' ? 'danger' : 'primary'}
        loading={running}
        onConfirm={run}
        onClose={() => setConfirm(null)}
      />
      <Modal open={grantOpen} title="منح رقم العميل مؤقتًا" onClose={() => setGrantOpen(false)}>
        <div className="row-gap">
          {[['hour', 'ساعة'], ['day', 'يوم'], ['week', 'أسبوع']].map(([key, label]) => (
            <Button key={key} variant="secondary" loading={granting} onClick={() => grant(key)}>{label}</Button>
          ))}
        </div>
        <Field label="أو حتى تاريخ ووقت محدد">
          {(fid) => <input id={fid} className="input" type="datetime-local" value={grantDate} onChange={(e) => setGrantDate(e.target.value)} />}
        </Field>
        <Button disabled={!grantDate} loading={granting} onClick={() => grant('custom')}>منح حتى هذا الوقت</Button>
      </Modal>
      <Modal open={Boolean(secret)} title={secret?.invite ? 'لينك الدعوة' : 'كلمة المرور المؤقتة'} onClose={() => setSecret(null)} footer={<Button onClick={() => setSecret(null)}>تم، حفظتها</Button>}>
        <p>تُعرض مرة واحدة فقط.{secret?.invite ? ' اللينك يعمل مرة واحدة ويبطل بعد 48 ساعة.' : ' سيُطلب من الموظف تغييرها عند أول دخول.'}</p>
        <div className="secret-box" dir="ltr">{secret?.invite ? secret.invite.link : secret?.tempPassword}</div>
      </Modal>
    </>
  );
}
