import { describe, expect, it } from 'vitest';
import { formatMoney, isValidMoneyInput, minorToInput, toAsciiDigits } from './format.js';
import { DELIVERY_STATUS_LABELS, SOURCE_STATUS_LABELS, label } from './labels.js';

describe('formatting', () => {
  it('formats integer piasters as EGP', () => {
    expect(formatMoney(125075)).toBe('1,250.75 ج.م');
    expect(formatMoney(null)).toBe('—');
    expect(minorToInput(105000)).toBe('1050.00');
    expect(minorToInput(-5)).toBe('-0.05');
  });

  it('validates money input and converts Arabic digits', () => {
    expect(isValidMoneyInput('1050.5')).toBe(true);
    expect(isValidMoneyInput('10.555')).toBe(false);
    expect(isValidMoneyInput('-1')).toBe(false);
    expect(toAsciiDigits('١٠٥٠')).toBe('1050');
  });

  it('labels every documented EasyOrders status and tolerates unknown ones', () => {
    for (const s of ['pending', 'confirmed', 'pending_payment', 'paid', 'paid_failed', 'processing', 'waiting_for_pickup', 'in_delivery', 'delivered', 'canceled', 'returning_from_delivery', 'request_refund', 'refund_in_progress', 'refunded']) {
      expect(SOURCE_STATUS_LABELS[s]).toBeTruthy();
    }
    expect(label(SOURCE_STATUS_LABELS, 'something_new')).toBe('something_new');
    expect(label(DELIVERY_STATUS_LABELS, 'pending_delivery_review')).toBe('بانتظار مراجعة التسليم');
  });
});
