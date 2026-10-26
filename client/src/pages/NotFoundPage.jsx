import { Link } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext.jsx';
import { homeFor } from '../features/auth/RequireRole.jsx';

export function NotFoundPage() {
  const { user } = useAuth();
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-card__title">الصفحة غير موجودة</h1>
        <p className="auth-card__subtitle">الرابط الذي فتحته غير صحيح أو لم يعد متاحاً.</p>
        <Link className="btn btn--primary btn--block" to={homeFor(user)}>
          العودة للرئيسية
        </Link>
      </div>
    </div>
  );
}
