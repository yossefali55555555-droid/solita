import { Order } from '../models/index.js';
import { badRequest, conflict, unprocessable } from '../utils/errors.js';
import { recordEvent, userActor } from './auditService.js';
import { notify } from './notificationService.js';

/**
 * Shipping labels (البوليصة) and parcel QR codes.
 *
 * Every pair of shoes travels in its own parcel. Each parcel gets a label
 * with a QR code whose text is `SOL:<order number>-<n>/<total>`, for
 * example `SOL:24-2/3` (order 24, parcel 2 of 3). The order number is the
 * EasyOrders short id, or the EasyOrders id when the order has no short id.
 *
 * The QR code is scanned:
 *  1. by the courier when picking the parcels up (all parcels are required
 *     before the delivery can start),
 *  2. by the courier before every delivery action (delivered / failed),
 *  3. by an administrator when a returned parcel is back in the warehouse.
 */

export const MAX_PARCELS = 30;
export const MAX_PRINT_BATCH = 40;

// Internal statuses whose labels may be printed or reprinted.
export const PRINTABLE_STATUSES = ['new', 'assigned', 'out_for_delivery', 'failed'];
// Statuses in which a returned parcel can be scanned back into the warehouse.
const WAREHOUSE_STATUSES = ['failed', 'returned', 'cancelled'];

const CODE_RX = /^SOL:([A-Za-z0-9_-]{1,100})-(\d{1,3})\/(\d{1,3})$/;

// ---------------------------------------------------------------- codes

export function orderLabelNumber(order) {
  return order.easyOrdersShortId ? String(order.easyOrdersShortId) : String(order.easyOrdersId);
}

export function parcelCode(order, n, total) {
  return `SOL:${orderLabelNumber(order)}-${n}/${total}`;
}

/** Parse a scanned QR text. Returns { number, n, total } or null. */
export function parseParcelCode(raw) {
  if (typeof raw !== 'string') return null;
  // Scanners sometimes add whitespace; keyboards may type Arabic-Indic digits.
  const text = raw
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/^sol:/i, 'SOL:');
  const m = CODE_RX.exec(text);
  if (!m) return null;
  const n = Number(m[2]);
  const total = Number(m[3]);
  if (n < 1 || total < 1 || n > total || total > MAX_PARCELS) return null;
  return { number: m[1], n, total };
}

function orderQueryForNumber(number) {
  return /^\d{1,12}$/.test(number) ? { easyOrdersShortId: Number(number) } : { easyOrdersId: number };
}

function codeMatchesOrder(parsed, order) {
  return parsed.number === orderLabelNumber(order);
}

// ---------------------------------------------------------------- parcels

function itemSize(item) {
  const opts = item.options || [];
  const size = opts.find((o) => /size|مقاس/i.test(o.name || ''));
  if (size?.value) return size.value;
  return opts.map((o) => o.value).filter(Boolean).join(' / ');
}

/** One parcel per unit of every item. */
export function buildParcelPlan(order) {
  const contents = [];
  for (const item of order.items || []) {
    const qty = Math.max(0, Math.floor(Number(item.quantity) || 0));
    const size = itemSize(item);
    const text = `${item.name}${size ? ` — مقاس ${size}` : ''}`.slice(0, 400);
    for (let i = 0; i < qty; i += 1) contents.push(text);
  }
  return contents;
}

export function labelAmount(order) {
  if (!order.cod?.isCod) return 0;
  return order.cod.expectedAmount || 0;
}

function labelSignature(order) {
  return JSON.stringify([buildParcelPlan(order), labelAmount(order)]);
}

function isCancelled(order) {
  return order.deliveryStatus === 'cancelled' || order.sourceStatus === 'canceled';
}

/** Data the client needs to draw one label per parcel. */
export function labelOf(order) {
  const c = order.customer || {};
  const total = order.labels?.total || order.parcels?.length || 0;
  const amount = labelAmount(order);
  return {
    orderId: order._id,
    number: orderLabelNumber(order),
    total,
    parcels: (order.parcels || []).map((p) => ({ n: p.n, code: parcelCode(order, p.n, total), content: p.content })),
    customer: c.name || '',
    phone: c.phone || '',
    altPhone: c.alternativePhone && c.alternativePhone !== c.phone ? c.alternativePhone : '',
    city: c.government || '',
    area: c.area || '',
    address: c.address || '',
    note: c.notes || '',
    amount,
    prepaid: amount === 0,
    printedAt: order.labels?.printedAt || null,
  };
}

function parcelProgress(order) {
  const parcels = order.parcels || [];
  return {
    total: parcels.length,
    pickedUp: parcels.filter((p) => p.pickedUpAt).length,
    inWarehouse: parcels.filter((p) => p.warehouseAt).length,
  };
}

/**
 * Parcel state after a (re)assignment: parcels the order's previous courier
 * picked up, or that came back to the warehouse, must be scanned again by
 * the courier who now takes the order.
 */
export function parcelsAfterAssignment(order, nextCourierId) {
  const sameCourier = nextCourierId && String(order.assignedTo || '') === String(nextCourierId);
  return (order.parcels || []).map((p) => {
    const keep = sameCourier && p.pickedUpAt && !p.warehouseAt;
    return {
      n: p.n,
      content: p.content,
      pickedUpAt: keep ? p.pickedUpAt : null,
      pickedUpBy: keep ? p.pickedUpBy : null,
      warehouseAt: null,
      warehouseBy: null,
    };
  });
}

// ---------------------------------------------------------------- print queue

const QUEUE_FIELDS =
  'easyOrdersId easyOrdersShortId customer.name customer.phone customer.government items totalAmount cod paymentStatus sourceStatus deliveryStatus assignedTo labels parcels isDemo createdAt';

export async function listPrintQueue({ tab = 'pending' }, { skip, limit }) {
  const notCancelled = { sourceStatus: { $ne: 'canceled' } };
  const queries = {
    pending: { 'labels.printedAt': null, deliveryStatus: { $in: ['new', 'assigned'] }, dashboardHiddenAt: null, ...notCancelled },
    reprint: { 'labels.needsReprint': true, deliveryStatus: { $in: PRINTABLE_STATUSES }, ...notCancelled },
    printed: { 'labels.printedAt': { $ne: null } },
  };
  const query = queries[tab] || queries.pending;
  const sort = tab === 'printed' ? { 'labels.printedAt': -1, _id: -1 } : { createdAt: 1, _id: 1 };
  const [items, total, pending, reprint] = await Promise.all([
    Order.find(query).sort(sort).skip(skip).limit(limit).select(QUEUE_FIELDS).populate('assignedTo', 'name').lean(),
    Order.countDocuments(query),
    Order.countDocuments(queries.pending),
    Order.countDocuments(queries.reprint),
  ]);
  return {
    items: items.map((o) => ({ ...o, parcelCount: buildParcelPlan(o).length, items: undefined })),
    total,
    counts: { pending, reprint },
  };
}

// ---------------------------------------------------------------- printing

function printProblem(order) {
  if (isCancelled(order)) return 'الطلب ملغي';
  if (!PRINTABLE_STATUSES.includes(order.deliveryStatus)) return 'حالة الطلب لا تسمح بطباعة البوليصة';
  const plan = buildParcelPlan(order);
  if (!plan.length) return 'الطلب بدون منتجات';
  if (plan.length > MAX_PARCELS) return `عدد الطرود أكبر من ${MAX_PARCELS}`;
  const printed = Boolean(order.labels?.printedAt);
  const outside = (order.parcels || []).some((p) => p.pickedUpAt && !p.warehouseAt);
  if (printed && plan.length !== order.labels.total && outside) {
    return 'تغيّر عدد الطرود وبعض الطرود خرجت بالفعل مع المندوب';
  }
  return null;
}

/**
 * Print (or reprint) the labels of up to 40 orders. All or nothing: if any
 * order cannot be printed, nothing is written and every problem is listed.
 */
export async function printLabels(admin, orderIds) {
  const ids = [...new Set(orderIds.map(String))];
  if (!ids.length) throw badRequest('اختر طلباً واحداً على الأقل');
  if (ids.length > MAX_PRINT_BATCH) throw badRequest(`الحد الأقصى ${MAX_PRINT_BATCH} طلباً في المرة الواحدة`);
  const orders = await Order.find({ _id: { $in: ids } }).lean();
  const byId = new Map(orders.map((o) => [String(o._id), o]));

  const problems = [];
  for (const id of ids) {
    const order = byId.get(id);
    if (!order) problems.push({ orderId: id, message: 'الطلب غير موجود' });
    else {
      const problem = printProblem(order);
      if (problem) problems.push({ orderId: id, number: orderLabelNumber(order), message: problem });
    }
  }
  if (problems.length) {
    const first = problems[0];
    throw unprocessable(
      `لم تتم الطباعة: ${first.number ? `طلب ${first.number}` : 'طلب'} — ${first.message}`,
      'PRINT_REJECTED',
      problems,
    );
  }

  const now = new Date();
  const labels = [];
  for (const id of ids) {
    const order = byId.get(id);
    const plan = buildParcelPlan(order);
    const reprint = Boolean(order.labels?.printedAt);
    const sameCount = reprint && plan.length === order.labels.total && (order.parcels || []).length === plan.length;
    const parcels = sameCount
      ? order.parcels.map((p, i) => ({ ...p, content: plan[i] }))
      : plan.map((content, i) => ({ n: i + 1, content, pickedUpAt: null, pickedUpBy: null, warehouseAt: null, warehouseBy: null }));

    const updated = await Order.findOneAndUpdate(
      { _id: order._id, deliveryStatus: order.deliveryStatus, updatedAt: order.updatedAt },
      {
        $set: {
          parcels,
          'labels.printedAt': now,
          'labels.printedBy': admin._id,
          'labels.total': plan.length,
          'labels.amount': labelAmount(order),
          'labels.signature': labelSignature(order),
          'labels.needsReprint': false,
          'labels.reprintReason': null,
        },
        $inc: { 'labels.printCount': 1 },
      },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) {
      throw conflict(`تغيّر الطلب ${orderLabelNumber(order)} أثناء الطباعة، حدّث الصفحة وحاول مرة أخرى`);
    }
    await recordEvent({
      order: order._id,
      type: reprint ? 'labels_reprinted' : 'labels_printed',
      actor: userActor(admin),
      next: { parcels: plan.length, amount: labelAmount(order) },
      metadata: { previousTotal: order.labels?.total ?? null },
    });
    labels.push(labelOf(updated));
  }
  return { labels, printedAt: now };
}

/** Labels of already printed orders, without marking anything. */
export async function getLabels(orderIds) {
  const orders = await Order.find({ _id: { $in: orderIds }, 'labels.printedAt': { $ne: null } }).lean();
  return { labels: orders.map(labelOf) };
}

/**
 * Called after EasyOrders changed an order: if the printed label no longer
 * matches (parcels, sizes or amount), flag it for reprinting.
 */
export async function flagReprintIfChanged(orderId) {
  const order = await Order.findById(orderId).lean();
  if (!order?.labels?.printedAt || order.labels.needsReprint) return;
  if (!PRINTABLE_STATUSES.includes(order.deliveryStatus) || isCancelled(order)) return;
  if (labelSignature(order) === order.labels.signature) return;
  const reason = 'تغيّرت منتجات الطلب أو المبلغ في EasyOrders بعد الطباعة';
  const res = await Order.updateOne(
    { _id: order._id, 'labels.needsReprint': { $ne: true } },
    { $set: { 'labels.needsReprint': true, 'labels.reprintReason': reason } },
  );
  if (!res.modifiedCount) return;
  await recordEvent({ order: order._id, type: 'labels_need_reprint', actor: { kind: 'system' }, reason });
  if (order.assignedTo) {
    await notify(order.assignedTo, 'labels_need_reprint', `تغيّر الطلب (${orderLabelNumber(order)}) ويحتاج بوليصة جديدة من المشرف`, order._id);
  }
}

// ---------------------------------------------------------------- courier scans

function block(message) {
  return { kind: 'block', message };
}

function labelProblem(order, parsed) {
  if (!order.labels?.printedAt || !order.parcels?.length) return 'لم تُطبع بوليصة لهذا الطلب بعد';
  if (order.labels.needsReprint) return 'تغيّر هذا الطلب ويحتاج بوليصة جديدة — ارجع للمشرف';
  if (parsed.total !== order.labels.total || !order.parcels.some((p) => p.n === parsed.n)) {
    return 'بوليصة قديمة — هذا الملصق لا يطابق الطرود الحالية للطلب';
  }
  return null;
}

function courierOrderBrief(order) {
  return {
    _id: order._id,
    number: orderLabelNumber(order),
    customer: order.customer?.name || '',
    deliveryStatus: order.deliveryStatus,
    parcels: parcelProgress(order),
  };
}

const PICKUP_STATUSES = ['assigned', 'out_for_delivery', 'failed'];

/** Courier scans a parcel QR code (pickup). */
export async function courierScan(courier, code) {
  const parsed = parseParcelCode(code);
  if (!parsed) return block('هذا ليس كود طرد من سوليتا');
  const order = await Order.findOne(orderQueryForNumber(parsed.number)).lean();
  if (!order) return block('طرد غير مسجّل في النظام');
  if (isCancelled(order)) return block('هذا الطلب ملغى — لا تستلمه');
  if (String(order.assignedTo || '') !== String(courier._id)) {
    return block(order.assignedTo ? 'هذا الطلب مع مندوب آخر' : 'هذا الطلب غير مُسنَد إليك — اطلب من المشرف إسناده لك');
  }
  const problem = labelProblem(order, parsed);
  if (problem) return { ...block(problem), order: courierOrderBrief(order) };
  if (!PICKUP_STATUSES.includes(order.deliveryStatus)) {
    return { ...block('هذا الطلب لا يحتاج استلام في حالته الحالية'), order: courierOrderBrief(order) };
  }

  const parcel = order.parcels.find((p) => p.n === parsed.n);
  if (parcel.pickedUpAt && !parcel.warehouseAt) {
    return { kind: 'mine', message: `الطرد ${parsed.n} من ${parsed.total} معك بالفعل`, order: courierOrderBrief(order) };
  }

  const now = new Date();
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, assignedTo: courier._id, deliveryStatus: { $in: PICKUP_STATUSES }, 'labels.total': parsed.total },
    {
      $set: {
        'parcels.$[p].pickedUpAt': now,
        'parcels.$[p].pickedUpBy': courier._id,
        'parcels.$[p].warehouseAt': null,
        'parcels.$[p].warehouseBy': null,
      },
    },
    { arrayFilters: [{ 'p.n': parsed.n }], returnDocument: 'after' },
  ).lean();
  if (!updated) throw conflict();
  await recordEvent({
    order: order._id,
    type: 'parcel_picked_up',
    actor: userActor(courier),
    metadata: { parcel: parsed.n, total: parsed.total },
  });
  const brief = courierOrderBrief(updated);
  const done = brief.parcels.pickedUp === brief.parcels.total;
  return {
    kind: 'ok',
    message: done
      ? `تم استلام الطرد ${parsed.n} من ${parsed.total} — اكتمل استلام الطلب`
      : `تم استلام الطرد ${parsed.n} من ${parsed.total} — باقي ${brief.parcels.total - brief.parcels.pickedUp}`,
    order: brief,
    allPickedUp: done,
  };
}

/** Delivery cannot start until every parcel of the order was scanned. */
export function assertReadyToStart(order) {
  if (!order.labels?.printedAt || !order.parcels?.length) {
    throw unprocessable('لم تُطبع بوليصة هذا الطلب بعد — اطلب من المشرف طباعتها', 'LABELS_NOT_PRINTED');
  }
  if (order.labels.needsReprint) {
    throw unprocessable('تغيّر هذا الطلب ويحتاج بوليصة جديدة قبل الخروج', 'LABELS_NEED_REPRINT');
  }
  const { total, pickedUp } = parcelProgress(order);
  const held = order.parcels.filter((p) => p.pickedUpAt && !p.warehouseAt).length;
  if (held < total) {
    throw unprocessable(
      `هذا الطلب ${total} طرود، مسحت ${Math.min(pickedUp, held)} فقط — امسح باقي الطرود قبل بدء التوصيل`,
      'PARCELS_NOT_PICKED_UP',
    );
  }
}

/**
 * Before a delivery action the courier must scan a parcel of the same
 * order. Orders without printed labels (created before labels existed)
 * are accepted without a scan.
 */
export function assertParcelScan(order, code) {
  if (!order.labels?.printedAt || !order.parcels?.length) return null;
  if (!code) throw badRequest('امسح كود طرد من هذا الطلب أولاً', 'PARCEL_SCAN_REQUIRED');
  const parsed = parseParcelCode(code);
  if (!parsed) throw badRequest('هذا ليس كود طرد من سوليتا', 'PARCEL_CODE_INVALID');
  if (!codeMatchesOrder(parsed, order)) throw unprocessable('هذا الطرد من طلب آخر', 'PARCEL_OTHER_ORDER');
  if (parsed.total !== order.labels.total || !order.parcels.some((p) => p.n === parsed.n)) {
    throw unprocessable('بوليصة قديمة — هذا الملصق لا يطابق الطرود الحالية للطلب', 'PARCEL_LABEL_OUTDATED');
  }
  const parcel = order.parcels.find((p) => p.n === parsed.n);
  if (!parcel.pickedUpAt || parcel.warehouseAt) {
    throw unprocessable('هذا الطرد غير مسجّل معك — امسحه من شاشة الاستلام أولاً', 'PARCEL_NOT_PICKED_UP');
  }
  return parsed;
}

// ---------------------------------------------------------------- warehouse

/** Administrator scans a returned parcel back into the warehouse. */
export async function warehouseScan(admin, code) {
  const parsed = parseParcelCode(code);
  if (!parsed) return block('هذا ليس كود طرد من سوليتا');
  const order = await Order.findOne(orderQueryForNumber(parsed.number)).populate('assignedTo', 'name').lean();
  if (!order) return block('طرد غير مسجّل في النظام');
  const brief = () => ({
    _id: order._id,
    number: orderLabelNumber(order),
    customer: order.customer?.name || '',
    courier: order.assignedTo?.name || '',
    deliveryStatus: order.deliveryStatus,
    parcels: parcelProgress(order),
  });
  if (!order.labels?.printedAt || !order.parcels?.some((p) => p.n === parsed.n) || parsed.total !== order.labels.total) {
    return { ...block('بوليصة قديمة أو غير مطبوعة لهذا الطلب'), order: brief() };
  }
  if (!WAREHOUSE_STATUSES.includes(order.deliveryStatus)) {
    return { ...block('هذا الطلب ليس مرتجعًا — لا تُدخله المخزن من هنا'), order: brief() };
  }
  const parcel = order.parcels.find((p) => p.n === parsed.n);
  if (parcel.warehouseAt) return { kind: 'mine', message: `الطرد ${parsed.n} من ${parsed.total} وصل المخزن بالفعل`, order: brief() };
  if (!parcel.pickedUpAt) return { kind: 'mine', message: `الطرد ${parsed.n} من ${parsed.total} لم يخرج من المخزن أصلًا`, order: brief() };

  const now = new Date();
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, deliveryStatus: { $in: WAREHOUSE_STATUSES } },
    { $set: { 'parcels.$[p].warehouseAt': now, 'parcels.$[p].warehouseBy': admin._id } },
    { arrayFilters: [{ 'p.n': parsed.n, 'p.warehouseAt': null }], returnDocument: 'after' },
  ).lean();
  if (!updated) throw conflict();
  await recordEvent({
    order: order._id,
    type: 'parcel_returned_to_warehouse',
    actor: userActor(admin),
    metadata: { parcel: parsed.n, total: parsed.total, courier: order.assignedTo?._id },
  });
  const progress = parcelProgress(updated);
  const out = updated.parcels.filter((p) => p.pickedUpAt && !p.warehouseAt).length;
  return {
    kind: 'ok',
    message: out
      ? `وصل الطرد ${parsed.n} من ${parsed.total} للمخزن — باقي ${out} مع المندوب`
      : `وصل الطرد ${parsed.n} من ${parsed.total} للمخزن — كل طرود الطلب في المخزن`,
    order: { ...brief(), parcels: progress },
  };
}

