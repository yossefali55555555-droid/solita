import { useState } from 'react';
import { Badge, Button } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';
import { api } from '../../services/api.js';
import { whatsappLink } from './whatsapp.js';
import { confirmationMessage, couponMessage } from './orderMessages.js';

/**
 * Two WhatsApp buttons on an order row:
 *  1. «كود الخصم»: sends the customer's personal coupon (assigned on the spot if
 *     they have none yet) and marks it as sent;
 *  2. «تأكيد البيانات»: sends the data-confirmation message for an order under review.
 * Message texts come from «إعدادات الموقع» (admin.couponWhatsappTemplate / confirmWhatsappTemplate).
 */
export function OrderWhatsAppButtons({ order, templates, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const phone = order.customer?.phoneNormalized || order.customer?.phone;
  const confirmHref = phone && templates ? whatsappLink(phone, confirmationMessage(order, templates.confirm)) : '';
  const cancelled = order.sourceStatus === 'canceled' || order.deliveryStatus === 'cancelled';
  const coupon = order.couponAssignment;

  const sendCoupon = async () => {
    // Open the tab now (browsers block pop-ups opened after an await), fill it later.
    const tab = window.open('', '_blank');
    setBusy(true);
    try {
      const { coupon: row } = coupon ? { coupon } : await api.post(`/admin/orders/${order._id}/coupon`);
      const href = whatsappLink(phone, couponMessage(order, row.code, templates.coupon));
      if (tab) tab.location.href = href;
      else window.location.href = href;
      await api.post(`/admin/coupons/${row._id}/sent`);
      onChanged?.();
    } catch (err) {
      tab?.close();
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmSent = () => {
    api.post(`/admin/orders/${order._id}/confirmation-sent`).then(() => onChanged?.(), () => {});
  };

  if (!phone || !templates) return <span className="muted small">—</span>;

  return (
    <div className="badge-stack">
      <div className="badge-row">
        <Button size="sm" className="btn--whatsapp" loading={busy} disabled={cancelled} onClick={sendCoupon}>
          {coupon ? 'إرسال الكود' : 'تخصيص وإرسال كود'}
        </Button>
        <a
          className="btn btn--whatsapp btn--sm"
          href={confirmHref}
          target="_blank"
          rel="noopener noreferrer"
          onClick={confirmSent}
        >
          تأكيد البيانات
        </a>
      </div>
      <div className="badge-row">
        {coupon ? (
          <Badge tone={coupon.sentAt ? 'success' : 'warning'} title={coupon.code}>
            {coupon.sentAt ? 'الكود اتبعت' : 'الكود لم يُرسل'} · <span dir="ltr">{coupon.code.toUpperCase()}</span>
          </Badge>
        ) : null}
        {order.confirmationSentAt ? <Badge tone="success">رسالة التأكيد اتبعتت</Badge> : null}
        {order.couponFlag?.active ? <Badge tone="danger">كوبون غير مطابق</Badge> : null}
      </div>
    </div>
  );
}
