import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Field, Logo } from '../components/ui.jsx';
import { useAuth } from '../features/auth/AuthContext.jsx';
import { homeFor } from '../features/auth/RequireRole.jsx';
import { api, setCsrfToken } from '../services/api.js';

/** The invited person opens the one-time link (#t=token), chooses a password and is signed in. */
export function InvitePage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  // The token lives in the address fragment (never sent to a server or logged): read it once.
  const [token] = useState(() => window.location.hash.match(/[#&]t=([A-Za-z0-9_-]+)/)?.[1] || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  // Then remove it from the address bar and history.
  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  if (user) return <Navigate to={homeFor(user)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('كلمتا المرور غير متطابقتين');
      return;
    }
    setPending(true);
    try {
      const data = await api.post('/auth/invite/accept', { token, password });
      setCsrfToken(data.csrfToken);
      setUser(data.user);
      navigate(homeFor(data.user), { replace: true });
    } catch (err) {
      setError(err.details?.[0]?.message || err.message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit} noValidate>
        <div className="auth-card__brand">
          <Logo size={150} />
        </div>
        <h1 className="auth-card__title">تفعيل الحساب</h1>
        {!token ? (
          <p className="form-error" role="alert">لينك الدعوة غير صالح. اطلب من المشرف لينكًا جديدًا.</p>
        ) : (
          <>
            <p className="auth-card__subtitle">اختر كلمة مرور لحسابك. اللينك يعمل مرة واحدة فقط.</p>
            <Field label="كلمة المرور" hint="10 أحرف على الأقل، حروف وأرقام">
              {(id) => <input id={id} className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
            <Field label="تأكيد كلمة المرور">
              {(id) => <input id={id} className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
            </Field>
            {error && <p className="form-error" role="alert">{error}</p>}
            <Button type="submit" loading={pending} className="btn--block">تفعيل الحساب والدخول</Button>
          </>
        )}
      </form>
    </div>
  );
}
