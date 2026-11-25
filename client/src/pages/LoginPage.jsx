import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext.jsx';
import { homeFor } from '../features/auth/RequireRole.jsx';
import { Button, Field, Logo } from '../components/ui.jsx';
import { LoadingState } from '../components/States.jsx';
import { useToast } from '../components/Toast.jsx';
import { toAsciiDigits } from '../utils/format.js';

export function LoginPage() {
  const { user, status, login, verifyMfa } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  // Second stage of the admin sign-in (2FA): 'app' code or a 'recovery' code.
  const [mfaStep, setMfaStep] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  if (status === 'loading') return <LoadingState full />;
  if (user) return <Navigate to={user.mustChangePassword ? '/change-password' : homeFor(user)} replace />;

  const goHome = (u) => {
    const from = location.state?.from;
    const target = u.mustChangePassword ? '/change-password' : from && from.startsWith(homeFor(u)) ? from : homeFor(u);
    navigate(target, { replace: true });
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!identifier.trim() || !password) {
      setError('أدخل رقم الهاتف وكلمة المرور');
      return;
    }
    setPending(true);
    try {
      const u = await login(toAsciiDigits(identifier.trim()), password);
      if (u.mfaRequired) {
        setMfaStep('app');
        setCode('');
        return;
      }
      goHome(u);
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  };

  const submitCode = async (e) => {
    e.preventDefault();
    setError('');
    const value = toAsciiDigits(code.trim());
    if (!value) {
      setError(mfaStep === 'app' ? 'أدخل الكود المكوّن من 6 أرقام' : 'أدخل كود الاسترجاع');
      return;
    }
    setPending(true);
    try {
      const data = await verifyMfa(value);
      if (data.usedRecovery) {
        toast.info(`استخدمت كود استرجاع. الباقي ${data.recoveryLeft} من 10.`);
      }
      goHome(data.user);
    } catch (err) {
      if (err.code === 'MFA_SESSION_EXPIRED') {
        setMfaStep(null);
        setPassword('');
      }
      setError(err.message);
    } finally {
      setPending(false);
    }
  };

  if (mfaStep) {
    return (
      <div className="auth-page">
        <form className="auth-card" onSubmit={submitCode} noValidate>
          <div className="auth-card__brand">
            <Logo size={150} />
          </div>
          <h1 className="auth-card__title">التحقق بخطوتين</h1>
          <p className="auth-card__subtitle">
            {mfaStep === 'app'
              ? 'افتح تطبيق المصادقة على هاتفك واكتب الكود الظاهر لحساب Solita.'
              : 'اكتب أحد أكواد الاسترجاع التي حفظتها. كل كود يعمل مرة واحدة فقط.'}
          </p>
          <Field label={mfaStep === 'app' ? 'كود التطبيق' : 'كود الاسترجاع'} required>
            {(id) => (
              <input
                id={id}
                className="input input--lg"
                inputMode={mfaStep === 'app' ? 'numeric' : 'text'}
                autoComplete="one-time-code"
                dir="ltr"
                maxLength={mfaStep === 'app' ? 6 : 24}
                placeholder={mfaStep === 'app' ? '123456' : 'XXXX-XXXX-XXXX-XXXX'}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
            )}
          </Field>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" loading={pending} className="btn--block">
            تأكيد
          </Button>
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--block"
            onClick={() => {
              setMfaStep(mfaStep === 'app' ? 'recovery' : 'app');
              setCode('');
              setError('');
            }}
          >
            {mfaStep === 'app' ? 'لا أستطيع الوصول إلى التطبيق: استخدم كود استرجاع' : 'العودة إلى كود التطبيق'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit} noValidate>
        <div className="auth-card__brand">
          <Logo size={150} />
        </div>
        <h1 className="auth-card__title">تسجيل الدخول</h1>
        <p className="auth-card__subtitle">نظام إدارة الطلبات والمندوبين</p>
        <Field label="رقم الهاتف" required>
          {(id) => (
            <input
              id={id}
              className="input"
              type="tel"
              inputMode="tel"
              autoComplete="username"
              dir="ltr"
              placeholder="01xxxxxxxxx"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          )}
        </Field>
        <Field label="كلمة المرور" required>
          {(id) => (
            <input
              id={id}
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" loading={pending} className="btn--block">
          دخول
        </Button>
      </form>
    </div>
  );
}
