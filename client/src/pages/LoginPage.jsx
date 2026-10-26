import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext.jsx';
import { homeFor } from '../features/auth/RequireRole.jsx';
import { Button, Field, Logo } from '../components/ui.jsx';
import { LoadingState } from '../components/States.jsx';
import { toAsciiDigits } from '../utils/format.js';

export function LoginPage() {
  const { user, status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  if (status === 'loading') return <LoadingState full />;
  if (user) return <Navigate to={user.mustChangePassword ? '/change-password' : homeFor(user)} replace />;

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
      const from = location.state?.from;
      const target = u.mustChangePassword ? '/change-password' : from && from.startsWith(homeFor(u)) ? from : homeFor(u);
      navigate(target, { replace: true });
    } catch (err) {
      setError(err.message);
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
