import { describe, expect, it } from 'vitest';
import { cartWhatsappMessage, describeCartItems } from './cartMessage.js';

const cart = {
  customer: { name: 'منى أحمد', phone: '01001112222' },
  items: [
    { slug: 'samba-wb', name: 'Samba', size: '42', qty: 2, price: 165000 },
    { slug: 'salaxi-w', name: '', size: '', qty: 1, price: 149900 },
  ],
  value: 479900,
};

describe('abandoned cart WhatsApp message', () => {
  it('describes the items with size and quantity', () => {
    expect(describeCartItems(cart.items)).toBe('Samba (مقاس 42) × 2، salaxi-w');
  });

  it('fills the template placeholders', () => {
    const text = cartWhatsappMessage(cart, 'مرحبًا {name}، {items} — {total}');
    expect(text).toContain('مرحبًا منى،');
    expect(text).toContain('Samba (مقاس 42) × 2');
    expect(text).toContain('4,799.00 ج.م');
  });

  it('works without a name and with the default template', () => {
    const text = cartWhatsappMessage({ ...cart, customer: { phone: '01001112222' } });
    expect(text.startsWith('مرحبًا، معك فريق سوليتا.')).toBe(true);
  });
});
