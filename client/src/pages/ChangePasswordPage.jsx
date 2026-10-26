import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext.jsx';
import { homeFor } from '../features/auth/RequireRole.jsx';
import { Button, Field, Logo } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';
import { api } from '../services/api.js';

export function ChangePasswordPage() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.newPassword.length < 10) return setError('كلمة المرور الجديدة يجب ألا تقل عن 10 أحرف');
    if (form.newPassword !== form.confirm) return setError('تأكيد كلمة المرور غير مطابق');
    setPending(true);
    try {
      const data = await api.post('/auth/change-password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
      setUser(data.user);
      toast.success('تم تغيير كلمة المرور بنجاح');
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
          <Logo size={110} />
        </div>
        <h1 className="auth-card__title">تغيير كلمة المرور</h1>
        {user?.mustChangePassword && (
          <p className="auth-card__subtitle">يجب اختيار كلمة مرور جديدة قبل المتابعة.</p>
        )}
        <Field label="كلمة المرور الحالية" required>
          {(id) => <input id={id} className="input" type="password" autoComplete="current-password" value={form.currentPassword} onChange={set('currentPassword')} />}
        </Field>
        <Field label="كلمة المرور الجديدة" hint="10 أحرف على الأقل، وتحتوي على حروف وأرقام" required>
          {(id) => <input id={id} className="input" type="password" autoComplete="new-password" value={form.newPassword} onChange={set('newPassword')} />}
        </Field>
        <Field label="تأكيد كلمة المرور الجديدة" required>
          {(id) => <input id={id} className="input" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />}
        </Field>
        {error && <p className="form-error" role="alert">{error}</p>}
        <Button type="submit" loading={pending} className="btn--block">
          حفظ كلمة المرور
        </Button>
        <Button variant="ghost" className="btn--block" onClick={() => logout().then(() => navigate('/login'))}>
          تسجيل الخروج
        </Button>
      </form>
    </div>
  );
}
