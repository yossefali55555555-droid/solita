import { describe, expect, it } from 'vitest';
import { fromMinor, toMinor } from '../src/utils/money.js';
import { normalizePhone } from '../src/utils/phone.js';
import { sanitizeMetadata } from '../src/utils/sanitize.js';
import { normalizeEasyOrdersOrder } from '../src/integrations/easyorders/normalize.js';
import { loadConfig } from '../src/config/env.js';
import { canTransition } from '../src/constants/statuses.js';

describe('money', () => {
  it('converts decimals to integer piasters without float errors', () => {
    expect(toMinor('0.1')).toBe(10);
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor('1,250.75')).toBe(125075);
    expect(toMinor(19.999)).toBe(2000);
    expect(fromMinor(125075)).toBe('1250.75');
    expect(fromMinor(-5)).toBe('-0.05');
    expect(() => toMinor('abc')).toThrow();
  });
});

describe('phone normalization', () => {
  it('normalizes Egyptian numbers', () => {
    expect(normalizePhone('+20 100 123 4567')).toBe('01001234567');
    expect(normalizePhone('00201001234567')).toBe('01001234567');
    expect(normalizePhone('201001234567')).toBe('01001234567');
    expect(normalizePhone('١٠٠١٢٣٤٥٦٧')).toBe('01001234567');
    expect(normalizePhone('010-0123-4567')).toBe('01001234567');
  });
});

describe('sanitization', () => {
  it('redacts secrets and drops operator keys', () => {
    const out = sanitizeMetadata({ password: 'x', apiKey: 'y', nested: { token: 'z', ok: 1 }, $where: 'bad' });
    expect(out).toEqual({ password: '[redacted]', apiKey: '[redacted]', nested: { token: '[redacted]', ok: 1 } });
  });
});

describe('EasyOrders normalization', () => {
  it('maps the documented order payload', () => {
    const n = normalizeEasyOrdersOrder({
      id: '2692e31f-27f6-472d-b4cd-c0c1c168511c',
      cost: 300,
      shipping_cost: 30,
      total_cost: 330,
      status: 'pending',
      full_name: 'Ali',
      phone: '01012345678',
      government: 'Giza',
      address: 'Street',
      payment_method: 'cod',
      cart_items: [{ price: 150, quantity: 2, product: { name: 'Shoe', sku: 'S1' }, variant: { variation_props: [{ variation: 'color', variation_prop: 'L' }] } }],
    });
    expect(n.totalAmount).toBe(33000);
    expect(n.items[0]).toMatchObject({ name: 'Shoe', quantity: 2, price: 15000, sku: 'S1' });
    expect(n.items[0].options).toEqual([{ name: 'color', value: 'L' }]);
    expect(n.isCod).toBe(true);
    expect(n.discount).toBe(0);
  });
});

describe('configuration', () => {
  it('refuses mock mode in production and on Vercel', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', MOCK_MODE: 'true', SESSION_SECRET: 'x'.repeat(40), MONGODB_URI: 'mongodb://a' })).toThrow(/MOCK_MODE/);
    expect(() => loadConfig({ NODE_ENV: 'development', VERCEL: '1', MOCK_MODE: 'true', SESSION_SECRET: 'x'.repeat(40) })).toThrow(/MOCK_MODE/);
  });

  it('requires MONGODB_URI and a strong SESSION_SECRET in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/MONGODB_URI[\s\S]*SESSION_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', MONGODB_URI: 'mongodb+srv://x', SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    const ok = loadConfig({ NODE_ENV: 'production', MONGODB_URI: 'mongodb+srv://x', SESSION_SECRET: 'x'.repeat(40) });
    expect(ok.cookieSecure).toBe(true);
    expect(ok.databaseName).toBe('solita');
    expect(ok.easyOrders.apiConfigured).toBe(false);
  });
});

describe('delivery state machine', () => {
  it('allows only defined transitions', () => {
    expect(canTransition('new', 'assigned')).toBe(true);
    expect(canTransition('new', 'delivered')).toBe(false);
    expect(canTransition('out_for_delivery', 'delivered')).toBe(false);
    expect(canTransition('pending_delivery_review', 'delivered')).toBe(true);
    expect(canTransition('delivered', 'cancelled')).toBe(false);
  });
});
