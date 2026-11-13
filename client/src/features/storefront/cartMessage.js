import { formatMoney } from '../../utils/format.js';

export const DEFAULT_CART_TEMPLATE =
  'مرحبًا {name}، معك فريق سوليتا.\nلاحظنا أنك أضفت إلى سلتك: {items}\nالإجمالي: {total}.\nهل يمكننا مساعدتك في إتمام طلبك أو الإجابة عن أي سؤال؟';

/** "Samba (مقاس 42) × 2، Salaxi (مقاس 41)" */
export function describeCartItems(items = []) {
  return items
    .map((i) => {
      const name = i.name || i.slug;
      const size = i.size ? ` (مقاس ${i.size})` : '';
      const qty = i.qty > 1 ? ` × ${i.qty}` : '';
      return `${name}${size}${qty}`;
    })
    .join('، ');
}

/**
 * Fill the abandoned-cart WhatsApp template from site settings.
 * Placeholders: {name} (first name, or nothing), {items}, {total}.
 */
export function cartWhatsappMessage(cart, template) {
  const first = (cart.customer?.name || '').trim().split(/\s+/)[0] || '';
  return (template || DEFAULT_CART_TEMPLATE)
    .replaceAll('{name}', first)
    .replaceAll('{items}', describeCartItems(cart.items))
    .replaceAll('{total}', formatMoney(cart.value))
    .replace(/مرحبًا ،/g, 'مرحبًا،')
    .replace(/[ \t]{2,}/g, ' ');
}
