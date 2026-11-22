import { describe, expect, it } from 'vitest';
import { cairoDate, confirmationMessage, couponMessage, describeOrderItems, inspectLine, paymentLine } from './orderMessages.js';

const order = {
  easyOrdersShortId: 57,
  customer: { name: 'أحمد علي', government: 'الجيزة', address: '10 شارع النيل' },
  paymentMethod: 'cod',
  cod: { isCod: true },
  paymentStatus: 'unpaid',
  totalAmount: 165000,
  currency: 'EGP',
  items: [
    { name: 'Samba', quantity: 1, options: [{ name: 'size', value: '42' }] },
    { name: 'فوم تنظيف', quantity: 2 },
  ],
};

describe('order WhatsApp messages', () => {
  it('lists items with size and quantity', () => {
    expect(describeOrderItems(order.items)).toBe('- Samba (مقاس 42)\n- فوم تنظيف × 2');
  });

  it('fills the confirmation template for a cash on delivery order', () => {
    const msg = confirmationMessage(order, 'أهلاً {name}، طلب {num}:\n{items}\nالإجمالي: {total}.\n{payment}\nالعنوان: {address}\n{inspect}');
    expect(msg).toContain('أهلاً أحمد،');
    expect(msg).toContain('#57');
    expect(msg).toContain('- Samba (مقاس 42)');
    expect(msg).toContain('الدفع عند الاستلام.');
    expect(msg).toContain('الجيزة، 10 شارع النيل');
    expect(msg).toContain('تقيسه قدام المندوب قبل ما تدفع');
  });

  it('never says cash on delivery for an order paid online', () => {
    const transfer = { ...order, paymentMethod: 'transfer_receipt', cod: { isCod: false }, paymentStatus: 'paid' };
    expect(paymentLine(transfer)).toContain('تم الدفع بالتحويل');
    expect(paymentLine(transfer)).not.toContain('عند الاستلام');
    expect(inspectLine(transfer)).not.toContain('قبل ما تدفع');
    expect(inspectLine(transfer)).toContain('تقيسه قدام المندوب');

    const waiting = { ...transfer, paymentStatus: 'unpaid' };
    expect(paymentLine(waiting)).toContain('بانتظار تأكيد وصول المبلغ');

    const card = { ...order, paymentMethod: 'paymob_card', cod: { isCod: false }, paymentStatus: 'paid' };
    expect(paymentLine(card)).toContain('تم الدفع بالفيزا');
    const other = { ...order, paymentMethod: 'something_new', cod: { isCod: false }, paymentStatus: 'paid' };
    expect(paymentLine(other)).toContain('تم الدفع أونلاين');
  });

  it('survives a missing name', () => {
    const msg = confirmationMessage({ ...order, customer: {} }, 'أهلاً {name}، ({payment}) {address}');
    expect(msg).toBe('أهلاً، (الدفع عند الاستلام.) —');
  });

  it('writes the coupon message with the code, the dates and the store link', () => {
    const coupon = { code: 'st30-a7k2', sentAt: '2026-11-22T10:00:00.000Z', expiresAt: '2027-11-22T10:00:00.000Z' };
    const msg = couponMessage(order, coupon, 'أهلاً {name}\nالكود: {code}\nمن {start} إلى {end}\n{store}');
    expect(msg).toBe('أهلاً أحمد\nالكود: ST30-A7K2\nمن 22/11/2026 إلى 22/11/2027\nhttps://solita.myeasyorders.com');
    expect(cairoDate('2026-11-22T22:30:00.000Z')).toBe('23/11/2026');
  });
});
