import { Link } from 'react-router-dom';
import { EmptyState } from '../../components/States.jsx';
import { usePermissions } from './permissions.js';

/**
 * Page guard by permission. It only keeps people out of pages they cannot use
 * (and hides the menu entry); the server refuses the data in any case.
 */
export function RequireSection({ section, level = 'view', children }) {
  const perms = usePermissions();
  if (perms.can(section, level)) return children;
  return (
    <EmptyState
      title="لا تملك صلاحية فتح هذه الصفحة"
      description="اطلب من المشرف تفعيل الصلاحية المناسبة لحسابك."
      action={<Link className="link" to="/admin">العودة إلى الرئيسية</Link>}
    />
  );
}
