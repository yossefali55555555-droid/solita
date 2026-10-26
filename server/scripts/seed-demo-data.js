/**
 * MOCK MODE ONLY: seeds clearly labelled demo data into the in-memory
 * database. Refuses to run in production or against a real MONGODB_URI.
 * Every record is flagged isDemo=true and named "تجريبي".
 */
import { getConfig } from '../src/config/env.js';
import { isUsingMockDatabase } from '../src/db/connect.js';
import { Order, User } from '../src/models/index.js';
import { hashPassword } from '../src/services/passwordService.js';
import { upsertOrderFromSource } from '../src/services/sourceOrderService.js';
import { normalizeEasyOrdersOrder } from '../src/integrations/easyorders/normalize.js';

export const DEMO_PASSWORD = 'Demo12345678';

export async function seedDemoData() {
  const config = getConfig();
  if (!config.mockMode || config.isProduction || !isUsingMockDatabase()) {
    throw new Error('Demo data can only be seeded in MOCK_MODE with the in-memory database.');
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const admin = await User.findOneAndUpdate(
    { phone: '01000000001' },
    { $setOnInsert: { name: 'مشرف تجريبي', phone: '01000000001', passwordHash, role: 'admin', isDemo: true } },
    { upsert: true, returnDocument: 'after' },
  );
  const courier = await User.findOneAndUpdate(
    { phone: '01000000002' },
    { $setOnInsert: { name: 'مندوب تجريبي', phone: '01000000002', passwordHash, role: 'courier', isDemo: true } },
    { upsert: true, returnDocument: 'after' },
  );
  await User.findOneAndUpdate(
    { phone: '01000000003' },
    { $setOnInsert: { name: 'مندوب تجريبي 2', phone: '01000000003', passwordHash, role: 'courier', isDemo: true } },
    { upsert: true, returnDocument: 'after' },
  );

  const governments = ['القاهرة', 'الجيزة', 'الإسكندرية', 'القليوبية'];
  const products = [
    { name: 'حذاء جلد كلاسيك (تجريبي)', price: 1250 },
    { name: 'صندل صيفي (تجريبي)', price: 650 },
    { name: 'سنيكرز رياضي (تجريبي)', price: 980 },
  ];
  for (let i = 1; i <= 12; i += 1) {
    const product = products[i % products.length];
    const qty = (i % 2) + 1;
    const cost = product.price * qty;
    const created = new Date(Date.now() - i * 3600_000);
    const payload = {
      id: `demo-${String(i).padStart(4, '0')}`,
      created_at: created.toISOString(),
      updated_at: created.toISOString(),
      store_id: 'demo-store',
      cost,
      shipping_cost: 60,
      total_cost: cost + 60,
      status: i % 5 === 0 ? 'pending' : 'confirmed',
      full_name: `عميل تجريبي ${i}`,
      phone: `0111111${String(1000 + i)}`,
      government: governments[i % governments.length],
      address: `عنوان تجريبي رقم ${i}، شارع المثال`,
      payment_method: 'cod',
      cart_items: [
        {
          id: `demo-item-${i}`,
          product_id: `demo-product-${i % products.length}`,
          price: product.price,
          quantity: qty,
          product: { name: product.name, price: product.price, sku: `DEMO-${i % products.length}` },
          variant: { variation_props: [{ variation: 'المقاس', variation_prop: String(38 + (i % 6)) }] },
        },
      ],
    };
    await upsertOrderFromSource(normalizeEasyOrdersOrder(payload), { via: 'demo_seed', isDemo: true });
  }

  // A few demo orders already assigned to the demo courier.
  const toAssign = await Order.find({ isDemo: true, deliveryStatus: 'new' }).sort({ easyOrdersId: 1 }).limit(4);
  for (const order of toAssign) {
    order.assignedTo = courier._id;
    order.assignedBy = admin._id;
    order.assignedAt = new Date();
    order.deliveryStatus = 'assigned';
    await order.save();
  }

  return { admin, courier, password: DEMO_PASSWORD };
}
