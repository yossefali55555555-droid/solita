import { describe, expect, it } from 'vitest';
import { orderStatusMessage, whatsappLink, whatsappNumber } from './whatsapp.js';

const order = (deliveryStatus, extra = {}) => ({
  easyOrdersShortId: 24,
  deliveryStatus,
  customer: { name: 'أحمد علي', phone: '01012345678' },
  cod: { isCod: true, expectedAmount: 105000 },
  ...extra,
});

describe('whatsapp follow-up', () => {
  it('converts Egyptian numbers to wa.me format', () => {
    expect(whatsappNumber('01012345678')).toBe('201012345678');
    expect(whatsappNumber('+20 101 234 5678')).toBe('201012345678');
    expect(whatsappNumber('٠١٠١٢٣٤٥٦٧٨')).toBe('201012345678');
    expect(whatsappNumber('')).toBe('');
  });

  it('writes a message that matches the order status', () => {
    expect(orderStatusMessage(order('out_for_delivery'), 'محمد')).toContain('أنا في الطريق إليك الآن لتسليم طلبك رقم #24');
    expect(orderStatusMessage(order('out_for_delivery'), 'محمد')).toContain('مرحبًا أحمد، معك محمد');
    expect(orderStatusMessage(order('assigned'))).toContain('المبلغ المطلوب عند الاستلام');
    expect(orderStatusMessage(order('failed'))).toContain('ولم أتمكن من الوصول إليك');
    expect(orderStatusMessage(order('assigned', { cod: { isCod: false } }))).toContain('الطلب مدفوع');
  });

  it('builds a wa.me link with the encoded text', () => {
    expect(whatsappLink('01012345678', 'مرحبًا')).toBe(`https://wa.me/201012345678?text=${encodeURIComponent('مرحبًا')}`);
    expect(whatsappLink('', 'x')).toBe('');
  });
});
