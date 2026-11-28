import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Order, SecurityAlert, StaffActivity } from '../src/models/index.js';
import { splitName, toE164 } from '../src/services/metaExportService.js';
import { createOrder, createUser, loginAs } from './helpers.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const grants = (fields) => ({ sections: { customers: 'view' }, dangerous: [], fields: fields.map((key) => ({ key, until: null })) });
const parse = (text) => text.trim().split('\r\n').map((l) => l.split(','));

async function seed() {
  const a = await createOrder({ full_name: 'مريم أحمد علي', phone: '+20 101 112 2233', total_cost: 1000, government: 'القاهرة' });
  const b = await createOrder({ full_name: 'مريم أحمد علي', phone: '01011122233', total_cost: 500 });
  const c = await createOrder({ full_name: 'كريم سعيد', phone: '01222233344', total_cost: 700 });
  const d = await createOrder({ full_name: 'عميل مرتجع', phone: '01155566677', total_cost: 900 });
  const e = await createOrder({ full_name: 'تجريبي', phone: '01099988877', total_cost: 800 });
  const f = await createOrder({ full_name: '=HYPERLINK("x")', phone: '01033344455', total_cost: 300 });
  await Order.updateOne({ _id: a._id }, { $set: { deliveryStatus: 'delivered', 'customer.email': '  Mariam@Example.COM ' } });
  await Order.updateOne({ _id: b._id }, { $set: { deliveryStatus: 'delivered' } });
  await Order.updateOne({ _id: c._id }, { $set: { deliveryStatus: 'delivered' } });
  await Order.updateOne({ _id: d._id }, { $set: { deliveryStatus: 'returned' } });
  await Order.updateOne({ _id: e._id }, { $set: { deliveryStatus: 'delivered', isTest: true } });
  await Order.updateOne({ _id: f._id }, { $set: { deliveryStatus: 'delivered' } });
}

describe('Meta Ads export', () => {
  it('formats phones as Egyptian E.164 digits and splits names', () => {
    expect(toE164('+20 101 112 2233')).toBe('201011122233');
    expect(toE164('٠١٠١١١٢٢٢٣٣')).toBe('201011122233');
    expect(toE164('12345')).toBe('');
    expect(splitName('  مريم   أحمد  علي ')).toEqual({ fn: 'مريم', ln: 'أحمد علي' });
  });

  it('customers file: Meta column names, one row per customer, value = delivered total, tests and returns left out', async () => {
    await seed();
    const api = await loginAs(await createUser('admin'));
    const res = await api.get('/api/admin/customers/export-meta');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text.charCodeAt(0)).not.toBe(0xfeff); // a BOM would corrupt the first column name
    const [header, ...rows] = parse(res.text);
    expect(header).toEqual(['email', 'phone', 'phone', 'fn', 'ln', 'ct', 'st', 'country', 'value']);
    const byPhone = Object.fromEntries(rows.map((r) => [r[1], r]));
    expect(rows).toHaveLength(3); // Mariam (2 orders), Karim, the formula one; no returned, no test order
    expect(byPhone['201011122233']).toMatchObject({ 0: 'mariam@example.com', 3: 'مريم', 4: 'أحمد علي', 7: 'EG', 8: '1500.00' });
    expect(byPhone['201222233344'][8]).toBe('700.00');
    expect(res.text).not.toContain('201155566677'); // returned
    expect(res.text).not.toContain('201099988877'); // test order
    expect(res.text).toContain("'=HYPERLINK"); // formula neutralised
    expect(Number(res.headers['x-row-count'])).toBe(3);
  });

  it('filters: minimum orders, returned customers, date window', async () => {
    await seed();
    const api = await loginAs(await createUser('admin'));
    const two = parse((await api.get('/api/admin/customers/export-meta?minOrders=2')).text);
    expect(two).toHaveLength(2); // header + Mariam
    const withReturned = parse((await api.get('/api/admin/customers/export-meta?includeReturned=true')).text);
    const returned = withReturned.find((r) => r[1] === '201155566677');
    expect(returned[8]).toBe('0.00'); // a returned order adds no value
    const none = parse((await api.get('/api/admin/customers/export-meta?from=2030-01-01T00:00:00.000Z')).text);
    expect(none).toHaveLength(1); // header only
    expect((await api.get('/api/admin/customers/export-meta?minOrders=0')).status).toBe(400);
  });

  it('orders file: one purchase event per delivered order with time, value and currency', async () => {
    await seed();
    const api = await loginAs(await createUser('admin'));
    const res = await api.get('/api/admin/customers/export-meta?mode=orders');
    const [header, ...rows] = parse(res.text);
    expect(header.slice(-4)).toEqual(['event_name', 'event_time', 'value', 'currency']);
    expect(rows).toHaveLength(4); // Mariam x2, Karim, the formula one
    expect(rows[0].slice(-4)).toEqual(['Purchase', '2026-10-01T10:00:00.000Z', expect.stringMatching(/^\d+\.\d{2}$/), 'EGP']);
  });

  it('hash=sha256 hashes the identifiers the way Meta normalises them and leaves value alone', async () => {
    await seed();
    const api = await loginAs(await createUser('admin'));
    const res = await api.get('/api/admin/customers/export-meta?hash=sha256');
    const rows = parse(res.text).slice(1);
    const mariam = rows.find((r) => r[0] === sha('mariam@example.com'));
    expect(mariam).toBeTruthy();
    expect(mariam[1]).toBe(sha('201011122233'));
    expect(mariam[3]).toBe(sha('مريم'));
    expect(mariam[4]).toBe(sha('أحمدعلي'));
    expect(mariam[7]).toBe(sha('eg'));
    expect(mariam[8]).toBe('1500.00');
    expect(res.text).not.toContain('201011122233');
    expect(res.text).not.toContain('mariam@');
  });

  it('needs the export and phone grants; a refused call returns no number', async () => {
    await seed();
    for (const fields of [[], ['export'], ['customerPhone']]) {
      const res = await (await loginAs(await createUser('moderator', { permissions: grants(fields) }))).get('/api/admin/customers/export-meta');
      expect(res.status, fields.join()).toBe(403);
      expect(res.text).not.toContain('2010111');
    }
    const noSection = await createUser('moderator', {
      permissions: { sections: { orders: 'edit' }, dangerous: [], fields: [{ key: 'export', until: null }, { key: 'customerPhone', until: null }] },
    });
    expect((await (await loginAs(noSection)).get('/api/admin/customers/export-meta')).status).toBe(403);
    expect((await (await loginAs(await createUser('courier'))).get('/api/admin/customers/export-meta')).status).toBe(403);
  });

  it('logs the row count as a danger line and alerts the admin when a moderator exports', async () => {
    await seed();
    const moderator = await createUser('moderator', { permissions: grants(['export', 'customerPhone']) });
    const res = await (await loginAs(moderator)).get('/api/admin/customers/export-meta?hash=sha256');
    expect(res.status).toBe(200);
    const line = await StaffActivity.findOne({ action: 'export.meta_ads' }).lean();
    expect(line.severity).toBe('danger');
    expect(line.after).toMatchObject({ rows: 3, mode: 'customers', encoding: 'sha256' });
    expect(String(line.actorId)).toBe(String(moderator._id));
    expect(line.sentence).not.toMatch(/\d{9,}/);
    const alert = await SecurityAlert.findOne({ type: 'staff_export' }).lean();
    expect(alert.message).toContain('3 صفًا');
    // The admin exporting is logged but raises no alert for themselves.
    await SecurityAlert.deleteMany({});
    await (await loginAs(await createUser('admin'))).get('/api/admin/customers/export-meta');
    expect(await SecurityAlert.countDocuments({ type: 'staff_export' })).toBe(0);
  });
});
