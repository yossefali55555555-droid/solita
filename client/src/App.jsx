import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './features/auth/AuthContext.jsx';
import { RequireRole, homeFor } from './features/auth/RequireRole.jsx';
import { RequireSection } from './features/auth/RequireSection.jsx';
import { firstAllowedPage, usePermissions } from './features/auth/permissions.js';
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
import { MissedOrdersPage } from './pages/admin/MissedOrdersPage.jsx';
import { PageTimePage } from './pages/admin/PageTimePage.jsx';
import { FoundersPage } from './pages/admin/FoundersPage.jsx';
import { CouponsPage } from './pages/admin/CouponsPage.jsx';
import { SiteSettingsPage } from './pages/admin/SiteSettingsPage.jsx';
import { SizeGuidePage } from './pages/admin/SizeGuidePage.jsx';
import { SecurityPage } from './pages/admin/SecurityPage.jsx';
import { StepUpPrompt } from './features/auth/StepUpPrompt.jsx';
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

const guard = (section, page) => <RequireSection section={section}>{page}</RequireSection>;

/** The admin landing page: the dashboard, or the first page a moderator may open. */
function AdminHome() {
  const perms = usePermissions();
  if (perms.can('dashboard')) return <OverviewPage />;
  const first = firstAllowedPage(perms);
  if (first) return <Navigate to={first} replace />;
  return guard('dashboard', null);
}

export function App() {
  return (
    <>
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
          <RequireRole role="staff">
            <AdminLayout />
          </RequireRole>
        }
      >
        <Route index element={<AdminHome />} />
        <Route path="orders" element={guard('orders', <OrdersPage />)} />
        <Route path="orders/:id" element={guard('orders', <OrderDetailPage />)} />
        <Route path="reviews" element={guard('reviews', <ReviewsPage />)} />
        <Route path="reviews/:id" element={guard('reviews', <ReviewDetailPage />)} />
        <Route path="couriers" element={guard('couriers', <CouriersPage />)} />
        <Route path="couriers/:id" element={guard('couriers', <CourierDetailPage />)} />
        <Route path="cash" element={guard('cash', <CashPage />)} />
        <Route path="sync" element={guard('sync', <SyncPage />)} />
        <Route path="returns" element={guard('warehouse', <ReturnsPage />)} />
        <Route path="customers" element={guard('customers', <CustomersPage />)} />
        <Route path="customers/:key" element={guard('customers', <CustomerDetailPage />)} />
        <Route path="finance" element={guard('finance', <FinancePage />)} />
        <Route path="labels" element={guard('warehouse', <LabelsPage />)} />
        <Route path="abandoned-carts" element={guard('storefront', <AbandonedCartsPage />)} />
        <Route path="missed-orders" element={guard('missedOrders', <MissedOrdersPage />)} />
        <Route path="page-time" element={guard('storefront', <PageTimePage />)} />
        <Route path="founders" element={guard('founders', <FoundersPage />)} />
        <Route path="coupons" element={guard('coupons', <CouponsPage />)} />
        <Route path="site-settings" element={guard('siteSettings', <SiteSettingsPage />)} />
        <Route path="size-guide" element={guard('siteSettings', <SizeGuidePage />)} />
        <Route path="security" element={<SecurityPage />} />
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
    <StepUpPrompt />
    </>
  );
}
