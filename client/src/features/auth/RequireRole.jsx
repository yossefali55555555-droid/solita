import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';
import { LoadingState } from '../../components/States.jsx';

/**
 * Client-side route guard for navigation only. Real authorization is
 * enforced by the server on every API request.
 */
export function RequireRole({ role, children }) {
  const { user, status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <LoadingState full />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  if (role && user.role !== role) return <Navigate to={homeFor(user)} replace />;
  return children;
}

export function homeFor(user) {
  if (!user) return '/login';
  return user.role === 'admin' ? '/admin' : '/courier';
}
