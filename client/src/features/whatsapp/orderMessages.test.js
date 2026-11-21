import { describe, expect, it } from 'vitest';
import { confirmationMessage, couponMessage, describeOrderItems } from './orderMessages.js';

const order = {
  easyOrdersShortId: 57,
  customer: { name: 'أحمد علي', government: 'الجيزة', address: '10 شارع النيل' },
  cod: { isCod: true },
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

  it('fills the confirmation template', () => {
    const msg = confirmationMessage(order, 'أهلاً {name}، طلب {num}:\n{items}\nالإجمالي: {total} ({payment}).\nالعنوان: {address}');
    expect(msg).toContain('أهلاً أحمد،');
    expect(msg).toContain('#57');
    expect(msg).toContain('- Samba (مقاس 42)');
    expect(msg).toContain('الدفع عند الاستلام');
    expect(msg).toContain('الجيزة، 10 شارع النيل');
  });

  it('marks a prepaid order as paid and survives a missing name', () => {
    const msg = confirmationMessage({ ...order, cod: { isCod: false }, customer: {} }, 'أهلاً {name}، ({payment}) {address}');
    expect(msg).toBe('أهلاً، (مدفوع) —');
  });

  it('writes the coupon message with the code in capitals and the store link', () => {
    const msg = couponMessage(order, 'st30-a7k2', 'أهلاً {name}\nالكود: {code}\n{store}');
    expect(msg).toBe('أهلاً أحمد\nالكود: ST30-A7K2\nhttps://solita.myeasyorders.com');
  });
});
