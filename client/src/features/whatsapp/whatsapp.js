import { formatMoney, orderNumber, toAsciiDigits } from '../../utils/format.js';

/** Egyptian mobile → international digits for wa.me (01xxxxxxxxx → 201xxxxxxxxx). */
export function whatsappNumber(phone) {
  let d = toAsciiDigits(phone).replace(/\D/g, '');
  if (d.startsWith('0020')) d = d.slice(2);
  if (/^01\d{9}$/.test(d)) return `2${d}`;
  if (/^1\d{9}$/.test(d)) return `20${d}`;
  if (/^201\d{9}$/.test(d)) return d;
  return d.length >= 8 ? d : '';
}

/** Ready-made message about the order's current status (formal Arabic). */
export function orderStatusMessage(order, courierName) {
  const name = order.customer?.name ? ` ${order.customer.name.split(' ')[0]}` : '';
  const num = orderNumber(order);
  const expected = order.cod?.isCod ? order.cod.expectedAmount || 0 : 0;
  const amount = expected > 0 ? `\nالمبلغ المطلوب عند الاستلام: ${formatMoney(expected)}.` : '\nالطلب مدفوع، ولا يوجد مبلغ للتحصيل.';
  const me = courierName ? `معك ${courierName}، ` : '';
  const hello = `مرحبًا${name}، ${me}مندوب توصيل سوليتا.`;
  switch (order.deliveryStatus) {
    case 'assigned':
      return `${hello}\nطلبك رقم ${num} معي، وسأتواصل معك لتحديد موعد التسليم. برجاء تأكيد العنوان والموعد المناسب لك.${amount}`;
    case 'out_for_delivery':
      return `${hello}\nأنا في الطريق إليك الآن لتسليم طلبك رقم ${num}.${amount}\nبرجاء التواجد والرد على الهاتف.`;
    case 'failed':
      return `${hello}\nحاولت تسليم طلبك رقم ${num} ولم أتمكن من الوصول إليك. برجاء الرد لتحديد موعد مناسب للتسليم.${amount}`;
    case 'pending_delivery_review':
    case 'delivered':
      return `${hello}\nتم تسليم طلبك رقم ${num}. شكرًا لاختياركم سوليتا.`;
    case 'cancelled':
      return `${hello}\nتم إلغاء طلبك رقم ${num}. للاستفسار برجاء التواصل مع خدمة العملاء.`;
    default:
      return `${hello}\nبخصوص طلبك رقم ${num}.`;
  }
}

export function whatsappLink(phone, text) {
  const number = whatsappNumber(phone);
  if (!number) return '';
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
