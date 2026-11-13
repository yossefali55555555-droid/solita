import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './features/auth/AuthContext.jsx';
import { RequireRole, homeFor } from './features/auth/RequireRole.jsx';
import { LoadingState } from './components/States.jsx';
import { AdminLayout } from './layouts/AdminLayout.jsx';
import { CourierLayout } from './layouts/CourierLayout.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { ChangePasswordPage } from './pages/ChangePasswordPage.jsx';
import { NotFoundPage } from './pages/NotFoundPage.jsx';
import { OverviewPage } from './pages/admin/OverviewPage.jsx';
import { OrdersPage } from './pages/admin/OrdersPage.jsx';
import { OrderDetailPage } from './pages/admin/OrderDetailPage.jsx';
import { ReviewsPage } from './pages/admin/ReviewsPage.jsx';
import { ReviewDetailPage } from './pages/admin/ReviewDetailPage.jsx';
import { CouriersPage } from './pages/admin/CouriersPage.jsx';
import { CourierDetailPage } from './pages/admin/CourierDetailPage.jsx';
import { CashPage } from './pages/admin/CashPage.jsx';
import { SyncPage } from './pages/admin/SyncPage.jsx';
import { ReturnsPage } from './pages/admin/ReturnsPage.jsx';
import { CustomersPage } from './pages/admin/CustomersPage.jsx';
import { CustomerDetailPage } from './pages/admin/CustomerDetailPage.jsx';
import { FinancePage } from './pages/admin/FinancePage.jsx';
import { LabelsPage } from './pages/admin/LabelsPage.jsx';
import { AbandonedCartsPage } from './pages/admin/AbandonedCartsPage.jsx';
import { SiteSettingsPage } from './pages/admin/SiteSettingsPage.jsx';
import { CourierOrdersPage } from './pages/courier/CourierOrdersPage.jsx';
import { CourierOrderPage } from './pages/courier/CourierOrderPage.jsx';
import { CourierCashPage } from './pages/courier/CourierCashPage.jsx';
import { CourierNotificationsPage } from './pages/courier/CourierNotificationsPage.jsx';
import { CourierScanPage } from './pages/courier/CourierScanPage.jsx';

function Home() {
  const { user, status } = useAuth();
  if (status === 'loading') return <LoadingState full />;
  return <Navigate to={homeFor(user)} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/change-password"
        element={
          <RequireRole>
            <ChangePasswordPage />
          </RequireRole>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireRole role="admin">
            <AdminLayout />
          </RequireRole>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="orders/:id" element={<OrderDetailPage />} />
        <Route path="reviews" element={<ReviewsPage />} />
        <Route path="reviews/:id" element={<ReviewDetailPage />} />
        <Route path="couriers" element={<CouriersPage />} />
        <Route path="couriers/:id" element={<CourierDetailPage />} />
        <Route path="cash" element={<CashPage />} />
        <Route path="sync" element={<SyncPage />} />
        <Route path="returns" element={<ReturnsPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="customers/:key" element={<CustomerDetailPage />} />
        <Route path="finance" element={<FinancePage />} />
        <Route path="labels" element={<LabelsPage />} />
        <Route path="abandoned-carts" element={<AbandonedCartsPage />} />
        <Route path="site-settings" element={<SiteSettingsPage />} />
      </Route>
      <Route
        path="/courier"
        element={
          <RequireRole role="courier">
            <CourierLayout />
          </RequireRole>
        }
      >
        <Route index element={<CourierOrdersPage />} />
        <Route path="orders/:id" element={<CourierOrderPage />} />
        <Route path="scan" element={<CourierScanPage />} />
        <Route path="cash" element={<CourierCashPage />} />
        <Route path="notifications" element={<CourierNotificationsPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
