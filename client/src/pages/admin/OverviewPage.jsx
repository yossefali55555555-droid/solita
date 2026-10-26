import { Badge, Card, PageHeader, StatCard } from '../../components/ui.jsx';
import { ErrorState, LoadingState } from '../../components/States.jsx';
import { useAsync } from '../../hooks/useAsync.js';
import { api } from '../../services/api.js';
import { formatMoney, formatNumber } from '../../utils/format.js';

function ReadinessRow({ ok, label, hint }) {
  return (
    <li className="readiness__row">
      <Badge tone={ok ? 'success' : 'warning'}>{ok ? 'مُهيأ' : 'غير مُهيأ'}</Badge>
      <span>{label}</span>
      {!ok && hint && <span className="muted readiness__hint">{hint}</span>}
    </li>
  );
}

export function OverviewPage() {
  const { data, error, loading, reload } = useAsync(() => api.get('/admin/overview'), []);

  if (loading && !data) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const { stats, system } = data;
  const o = stats.orders;

  return (
    <>
      <PageHeader title="نظرة عامة" subtitle="أرقام فعلية من قاعدة البيانات" />

      <h2 className="section-title">الطلبات</h2>
      <div className="stats-grid">
        <StatCard label="إجمالي الطلبات" value={formatNumber(o.total)} to="/admin/orders" />
        <StatCard label="طلبات جديدة" value={formatNumber(o.new)} to="/admin/orders?deliveryStatus=new" />
        <StatCard label="غير معيّنة لمندوب" value={formatNumber(o.unassigned)} tone="warning" to="/admin/orders?courier=unassigned" />
        <StatCard label="معيّنة لمندوب" value={formatNumber(o.assigned)} tone="info" to="/admin/orders?deliveryStatus=assigned" />
        <StatCard label="خرجت للتوصيل" value={formatNumber(o.outForDelivery)} tone="indigo" to="/admin/orders?deliveryStatus=out_for_delivery" />
        <StatCard label="بانتظار مراجعة التسليم" value={formatNumber(stats.pendingReviews)} tone="warning" to="/admin/reviews" />
        <StatCard label="تسليمات معتمدة" value={formatNumber(o.delivered)} tone="success" to="/admin/orders?deliveryStatus=delivered" />
        <StatCard label="محاولات فاشلة" value={formatNumber(o.failed)} tone="danger" to="/admin/orders?deliveryStatus=failed" />
        <StatCard label="طلبات ملغاة" value={formatNumber(o.cancelled)} to="/admin/orders?deliveryStatus=cancelled" />
        <StatCard
          label="أخطاء المزامنة"
          value={formatNumber(stats.sync.failures + stats.sync.webhookFailures)}
          tone={stats.sync.failures + stats.sync.webhookFailures ? 'danger' : 'neutral'}
          to="/admin/sync"
        />
      </div>

      <h2 className="section-title">النقدية (الدفع عند الاستلام)</h2>
      <div className="stats-grid">
        <StatCard label="النقدية المتوقعة من التسليمات المعتمدة" value={formatMoney(stats.cash.expected)} to="/admin/cash" />
        <StatCard label="النقدية المُسلّمة للإدارة" value={formatMoney(stats.cash.handedOver)} tone="info" to="/admin/cash" />
        <StatCard label="المبالغ المتحقق منها" value={formatMoney(stats.cash.verified)} tone="success" to="/admin/cash" />
        <StatCard label="المتبقي دون تسوية" value={formatMoney(stats.cash.outstanding)} tone="warning" to="/admin/cash" />
      </div>

      <Card title="جاهزية التكامل">
        <ul className="readiness">
          <ReadinessRow ok={!system.mockMode} label="قاعدة البيانات الحقيقية (MongoDB Atlas)" hint="الوضع التجريبي مفعل" />
          <ReadinessRow ok={system.easyOrders.apiConfigured} label="مفتاح EasyOrders API" hint="أضف EASYORDERS_API_KEY" />
          <ReadinessRow ok={system.easyOrders.webhooksConfigured} label="سر Webhook من EasyOrders" hint="أضف EASYORDERS_WEBHOOK_SECRET" />
          <ReadinessRow ok={system.cronConfigured} label="المعالجة الدورية (Cron)" hint="أضف CRON_SECRET" />
          <ReadinessRow ok={!system.sessionSecretEphemeral} label="SESSION_SECRET ثابت" hint="أضف SESSION_SECRET" />
        </ul>
      </Card>
    </>
  );
}
