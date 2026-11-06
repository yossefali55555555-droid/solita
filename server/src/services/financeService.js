import { CashRemittance, Expense, Order } from '../models/index.js';
import { EXPENSE_CATEGORIES } from '../constants/statuses.js';
import { conflict, notFound } from '../utils/errors.js';
import { recordEvent, userActor } from './auditService.js';

/**
 * Expenses (invoices) and the net-profit summary.
 *
 *   sales      = total of orders delivered (approved) in the period
 *   expenses   = total of expense invoices dated in the period
 *   net profit = sales - expenses
 *
 * The cash actually handed over by couriers in the period is reported next to
 * it (cash basis), so the admin can compare both views.
 *
 * All amounts are integer piasters.
 */

function dateRange(field, { from, to } = {}) {
  if (!from && !to) return {};
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return { [field]: range };
}

// ---------------------------------------------------------------- expenses

export async function createExpense(admin, body) {
  const expense = await Expense.create({ ...body, createdBy: admin._id });
  await recordEvent({
    type: 'expense_created',
    actor: userActor(admin),
    next: { amount: expense.amount, category: expense.category, date: expense.date },
    metadata: { expense: expense._id },
  });
  return expense.toObject();
}

export async function listExpenses({ from, to, category }, { skip, limit }) {
  const query = { deletedAt: null, ...dateRange('date', { from, to }) };
  if (category) query.category = category;
  const [items, total, sum] = await Promise.all([
    Expense.find(query).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).populate('createdBy', 'name').lean(),
    Expense.countDocuments(query),
    Expense.aggregate([{ $match: query }, { $group: { _id: null, amount: { $sum: '$amount' } } }]),
  ]);
  return { items, total, totalAmount: sum[0]?.amount || 0 };
}

export async function updateExpense(admin, expenseId, body) {
  const existing = await Expense.findOne({ _id: expenseId, deletedAt: null }).lean();
  if (!existing) throw notFound('المصروف غير موجود');
  const updated = await Expense.findOneAndUpdate(
    { _id: expenseId, deletedAt: null, updatedAt: existing.updatedAt },
    { $set: body },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!updated) throw conflict();
  await recordEvent({
    type: 'expense_updated',
    actor: userActor(admin),
    previous: { amount: existing.amount, category: existing.category, date: existing.date },
    next: { amount: updated.amount, category: updated.category, date: updated.date },
    metadata: { expense: existing._id },
  });
  return updated;
}

export async function deleteExpense(admin, expenseId, { reason } = {}) {
  const updated = await Expense.findOneAndUpdate(
    { _id: expenseId, deletedAt: null },
    { $set: { deletedAt: new Date(), deletedBy: admin._id, deleteReason: reason } },
    { returnDocument: 'after' },
  ).lean();
  if (!updated) throw notFound('المصروف غير موجود');
  await recordEvent({
    type: 'expense_deleted',
    actor: userActor(admin),
    previous: { amount: updated.amount, category: updated.category, date: updated.date },
    reason,
    metadata: { expense: updated._id },
  });
  return updated;
}

// ---------------------------------------------------------------- profit

export async function getProfitSummary({ from, to } = {}) {
  const [salesAgg, returnedCount, expensesAgg, cashAgg] = await Promise.all([
    Order.aggregate([
      { $match: { deliveryStatus: 'delivered', ...dateRange('deliveredAt', { from, to }) } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          amount: { $sum: '$totalAmount' },
          shipping: { $sum: '$shippingFee' },
          cod: { $sum: { $cond: ['$cod.isCod', '$totalAmount', 0] } },
        },
      },
    ]),
    Order.countDocuments({ deliveryStatus: 'returned', ...dateRange('returnInfo.at', { from, to }) }),
    Expense.aggregate([
      { $match: { deletedAt: null, ...dateRange('date', { from, to }) } },
      { $group: { _id: '$category', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    CashRemittance.aggregate([
      { $match: { status: { $in: ['received', 'reconciled', 'discrepancy'] }, ...dateRange('receivedAt', { from, to }) } },
      { $group: { _id: null, amount: { $sum: { $ifNull: ['$verifiedAmount', '$handedOverAmount'] } }, count: { $sum: 1 } } },
    ]),
  ]);

  const sales = salesAgg[0] || { count: 0, amount: 0, shipping: 0, cod: 0 };
  const byCategory = Object.fromEntries(expensesAgg.map((e) => [e._id, { amount: e.amount, count: e.count }]));
  const expensesTotal = expensesAgg.reduce((acc, e) => acc + e.amount, 0);
  const cashReceived = cashAgg[0]?.amount || 0;

  return {
    period: { from: from || null, to: to || null },
    sales: {
      deliveredOrders: sales.count,
      amount: sales.amount,
      shipping: sales.shipping,
      codAmount: sales.cod,
      returnedOrders: returnedCount,
    },
    expenses: {
      total: expensesTotal,
      count: expensesAgg.reduce((acc, e) => acc + e.count, 0),
      byCategory: EXPENSE_CATEGORIES.map((c) => ({ category: c, amount: byCategory[c]?.amount || 0, count: byCategory[c]?.count || 0 })),
    },
    netProfit: sales.amount - expensesTotal,
    cash: { received: cashReceived, net: cashReceived - expensesTotal },
  };
}
