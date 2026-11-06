import mongoose from 'mongoose';
import { EXPENSE_CATEGORIES } from '../constants/statuses.js';

const { ObjectId } = mongoose.Schema.Types;

/**
 * An expense invoice entered by an administrator (purchases, shipping, ads...).
 * Expenses are subtracted from sales in the net-profit summary. They are never
 * hard-deleted: a deleted expense keeps who deleted it and why.
 */
const expenseSchema = new mongoose.Schema(
  {
    // The invoice date (stored at 12:00 UTC so the calendar day never shifts).
    date: { type: Date, required: true },
    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: 'Money must be stored as integer piasters' },
    },
    currency: { type: String, default: 'EGP', maxlength: 3 },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    invoiceNumber: { type: String, trim: true, maxlength: 100 },
    vendor: { type: String, trim: true, maxlength: 200 },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: ObjectId, ref: 'User', default: null },
    deleteReason: { type: String, maxlength: 500 },
  },
  { timestamps: true },
);

expenseSchema.index({ deletedAt: 1, date: -1 });
expenseSchema.index({ category: 1, date: -1 });

export const Expense = mongoose.models.Expense || mongoose.model('Expense', expenseSchema);
