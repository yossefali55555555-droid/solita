import { PageTabs } from '../../components/PageTabs.jsx';
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useAuth } from '../../features/auth/AuthContext.jsx';
import { QrSvg } from '../../features/labels/QrSvg.jsx';
import { useAction, useAsync } from '../../hooks/useAsync.js';
import { useToast } from '../../components/Toast.jsx';
import { Badge, Button, Card, Field, Modal, PageHeader } from '../../components/ui.jsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.jsx';
import { formatDateTime, toAsciiDigits } from '../../utils/format.js';

/**
 * «الأمان والتنبيهات» (administrator only, phase 3): 2FA with an
 * authenticator app, one-time recovery codes, the owner's personal email
 * for alerts, and the alert list. The server enforces every rule; sensitive
 * buttons ask for the password or a code first (step-up prompt).
 */
export function SecurityPage() {
  const { user, refresh } = useAuth();
  const status = useAsync(() => api.get('/auth/security'), []);
  const alerts = useAsync(() => api.get('/auth/security/alerts'), []);
  if (user?.role !== 'admin') return <Navigate to="/admin" replace />;

  const reloadAll = () => {
    status.reload({ silent: true });
    refresh();
  };

  return (
    <>
      <PageHeader title="الأمان والتنبيهات" subtitle="حماية حساب الأدمن وتنبيهات الإجراءات الحساسة" />
      {status.loading && !status.data && <LoadingState />}
      {status.error && <ErrorState error={status.error} onRetry={status.reload} />}
      <PageTabs
        label="أقسام الأمان"
        initial={alerts.data?.unread > 0 ? 'alerts' : undefined}
        tabs={[
          status.data && { key: 'mfa', label: 'التحقق بخطوتين', content: <TwoFactorCard data={status.data} onChange={reloadAll} /> },
          status.data && { key: 'email', label: 'إيميل التنبيهات', content: <EmailCard data={status.data} onChange={reloadAll} /> },
          { key: 'alerts', label: 'التنبيهات', count: alerts.data?.unread, content: <AlertsCard state={alerts} onRead={refresh} /> },
        ]}
      />
    </>
  );
}

function RecoveryCodesModal({ codes, onClose }) {
  const [saved, setSaved] = useState(false);
  const toast = useToast();
  const text = `أكواد استرجاع حساب الأدمن في نظام سوليتا (كل كود يعمل مرة واحدة)\n\n${codes.join('\n')}\n`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('نُسخت الأكواد');
    } catch {
      toast.error('تعذر النسخ. انسخها يدويًا.');
    }
  };
  const download = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    link.download = 'solita-recovery-codes.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  };
  return (
    <Modal
      open
      title="أكواد الاسترجاع"
      onClose={() => saved && onClose()}
      footer={
        <Button onClick={onClose} disabled={!saved}>
          تم
        </Button>
      }
    >
      <p className="alert alert--warning">
        تظهر هذه الأكواد مرة واحدة فقط. احفظها خارج الهاتف (ورقة أو مدير كلمات مرور). كل كود يدخلك مرة واحدة إن فقدت الهاتف.
      </p>
      <ol className="plain-list mono" dir="ltr">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="badge-row">
        <Button variant="secondary" size="sm" onClick={copy}>
          نسخ
        </Button>
        <Button variant="secondary" size="sm" onClick={download}>
          تنزيل ملف
        </Button>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> حفظت الأكواد في مكان آمن
      </label>
    </Modal>
  );
}

function TwoFactorCard({ data, onChange }) {
  const { mfa } = data;
  const toast = useToast();
  const [setup, setSetup] = useState(null); // { secret, otpauthUri }
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [codes, setCodes] = useState(null);

  const [start, starting] = useAction(async () => {
    setError('');
    try {
      setSetup(await api.post('/auth/security/2fa/setup'));
      setCode('');
    } catch (err) {
      toast.error(err.message);
    }
  });
  const [confirm, confirming] = useAction(async (e) => {
    e.preventDefault();
    setError('');
    try {
      const res = await api.post('/auth/security/2fa/confirm', { code: toAsciiDigits(code.trim()) });
      setSetup(null);
      setCodes(res.recoveryCodes);
      toast.success('تم تفعيل التحقق بخطوتين');
      onChange();
    } catch (err) {
      setError(err.message);
      if (err.code === 'MFA_SETUP_EXPIRED') setSetup(null);
    }
  });
  const [regenerate, regenerating] = useAction(async () => {
    try {
      const res = await api.post('/auth/security/recovery-codes');
      setCodes(res.recoveryCodes);
      onChange();
    } catch (err) {
      toast.error(err.message);
    }
  });

  return (
    <Card
      title="التحقق بخطوتين (تطبيق مصادقة)"
      actions={mfa.enabled ? <Badge tone="success">مفعّل</Badge> : <Badge tone="warning">غير مفعّل</Badge>}
    >
      {!mfa.keyAvailable && (
        <p className="alert alert--danger">
          مفتاح التشفير غير مضبوط على الخادم. شغّل <span className="mono">npm run mfa:keygen</span> على جهازك، وضع الناتج في فيرسل
          باسم <span className="mono">MFA_ENCRYPTION_KEY</span>، واحتفظ بنسخة منه خارج الجهاز، ثم أعد النشر.
        </p>
      )}
      {mfa.keyMismatch && (
        <p className="alert alert--danger">
          سر التحقق مشفّر بمفتاح غير المفتاح الحالي. ادخل بكود استرجاع، أو شغّل سكريبت الاسترجاع، ثم أعد الإعداد.
        </p>
      )}
      {mfa.enabled ? (
        <>
          <p>
            مفعّل منذ {formatDateTime(mfa.enabledAt)}. يُطلب كود التطبيق عند كل تسجيل دخول وقبل الإجراءات الحساسة. أكواد
            الاسترجاع الباقية: <strong>{mfa.recoveryCodesLeft}</strong> من 10.
          </p>
          {mfa.recoveryCodesLeft <= 3 && <p className="alert alert--warning">أكواد الاسترجاع قاربت على النفاد. أنشئ أكوادًا جديدة.</p>}
          <div className="badge-row">
            <Button variant="secondary" onClick={regenerate} loading={regenerating}>
              إنشاء أكواد استرجاع جديدة
            </Button>
            <Button variant="ghost" onClick={start} loading={starting} disabled={!mfa.keyAvailable}>
              نقل التحقق إلى هاتف جديد
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            بعد التفعيل يُطلب كود من تطبيق المصادقة (Google Authenticator أو Microsoft Authenticator) عند كل دخول. لن يتغير شيء
            قبل أن تكتب أول كود صحيح، فلا يمكن أن يُقفل حسابك بإعداد لم يكتمل.
          </p>
          <Button onClick={start} loading={starting} disabled={!mfa.keyAvailable}>
            بدء الإعداد
          </Button>
        </>
      )}
      {setup && (
        <form className="inline-form" onSubmit={confirm} noValidate>
          <ol className="plain-list">
            <li>افتح تطبيق المصادقة واختر إضافة حساب، ثم امسح الرمز:</li>
          </ol>
          <div dir="ltr">
            <QrSvg text={setup.otpauthUri} size="200px" title="رمز إعداد التحقق بخطوتين" />
          </div>
          <p className="small muted">
            أو اكتب المفتاح يدويًا: <span className="mono" dir="ltr">{setup.secret.match(/.{1,4}/g).join(' ')}</span>
          </p>
          <Field label="الكود الظاهر في التطبيق" required error={error}>
            {(id) => (
              <input
                id={id}
                className="input"
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
          <div className="badge-row">
            <Button type="submit" loading={confirming}>
              تأكيد وتفعيل
            </Button>
            <Button variant="ghost" onClick={() => setSetup(null)}>
              إلغاء
            </Button>
          </div>
        </form>
      )}
      <p className="small muted">
        فقدت الهاتف وأكواد الاسترجاع؟ من جهازك شغّل <span className="mono">npm run admin:reset-2fa</span> (يحتاج ملف .env المحلي).
      </p>
      {codes && <RecoveryCodesModal codes={codes} onClose={() => setCodes(null)} />}
    </Card>
  );
}

function EmailCard({ data, onChange }) {
  const { email, mailConfigured } = data;
  const toast = useToast();
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const [send, sending] = useAction(async (e) => {
    e.preventDefault();
    setError('');
    try {
      const res = await api.post('/auth/security/email', { email: address.trim() });
      toast.success(`أُرسل كود إلى ${res.sentTo}`);
      setCode('');
      onChange();
    } catch (err) {
      setError(err.message);
    }
  });
  const [verify, verifying] = useAction(async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/auth/security/email/verify', { code: toAsciiDigits(code.trim()) });
      toast.success('تم ربط الإيميل');
      setAddress('');
      setCode('');
      onChange();
    } catch (err) {
      setError(err.message);
    }
  });
  const [test, testing] = useAction(async () => {
    try {
      const res = await api.post('/auth/security/email/test');
      toast.success(`أُرسل إيميل تجريبي إلى ${res.sentTo}`);
    } catch (err) {
      toast.error(err.message);
    }
  });

  return (
    <Card title="إيميل التنبيهات" actions={email.address ? <Badge tone="success">مربوط</Badge> : <Badge tone="warning">غير مربوط</Badge>}>
      {!mailConfigured && (
        <p className="alert alert--warning">
          خدمة الإيميل غير مضبوطة. أضف في فيرسل <span className="mono">GMAIL_SMTP_USER</span> و
          <span className="mono">GMAIL_SMTP_APP_PASSWORD</span> (كلمة مرور تطبيق من حساب Gmail)، ثم أعد النشر. التنبيهات داخل الموقع
          تعمل بدونها.
        </p>
      )}
      <p>
        {email.address ? (
          <>
            التنبيهات الأمنية تصل فورًا إلى <strong dir="ltr">{email.address}</strong>، وملخص اليوم يصل مساءً.
          </>
        ) : (
          'اربط إيميلك الشخصي لتصلك التنبيهات الأمنية فورًا وملخص يومي بالإجراءات الحساسة.'
        )}
      </p>
      <form className="inline-form" onSubmit={send} noValidate>
        <Field label={email.address ? 'تغيير الإيميل' : 'الإيميل الشخصي'}>
          {(id) => (
            <input
              id={id}
              className="input"
              type="email"
              dir="ltr"
              autoComplete="email"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="secondary" loading={sending} disabled={!mailConfigured || !address.trim()}>
          إرسال كود التحقق
        </Button>
      </form>
      {email.pendingAddress && (
        <form className="inline-form" onSubmit={verify} noValidate>
          <Field label={`الكود المرسل إلى ${email.pendingAddress}`} hint="صالح 15 دقيقة">
            {(id) => (
              <input
                id={id}
                className="input"
                dir="ltr"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" loading={verifying}>
            تأكيد الربط
          </Button>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {email.address && mailConfigured && (
        <Button variant="ghost" size="sm" onClick={test} loading={testing}>
          إرسال إيميل تجريبي
        </Button>
      )}
    </Card>
  );
}

function AlertsCard({ state, onRead }) {
  const [markRead, marking] = useAction(async () => {
    await api.post('/auth/security/alerts/read');
    state.reload({ silent: true });
    onRead();
  });
  const data = state.data;
  return (
    <Card
      title="التنبيهات"
      actions={
        data?.unread > 0 && (
          <Button variant="secondary" size="sm" onClick={markRead} loading={marking}>
            تعليم الكل كمقروء
          </Button>
        )
      }
    >
      {state.loading && !data && <LoadingState />}
      {state.error && <ErrorState error={state.error} onRetry={state.reload} />}
      {data && data.items.length === 0 && <EmptyState title="لا توجد تنبيهات" />}
      {data && data.items.length > 0 && (
        <ul className="simple-list">
          {data.items.map((a) => (
            <li key={a.id} className={a.read ? '' : 'notification--unread'}>
              <div className="badge-row">
                {a.severity === 'security' && <Badge tone="danger">أمني</Badge>}
                {!a.read && <Badge tone="info">جديد</Badge>}
                {a.count > 1 && <Badge tone="neutral">{`تكرر ${a.count} مرات`}</Badge>}
              </div>
              <p>{a.message}</p>
              <p className="small muted">{formatDateTime(a.lastAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
