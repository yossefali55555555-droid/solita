import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

/** In-application notifications (e.g. a courier's report was rejected). */
const notificationSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: ['order_assigned', 'order_unassigned', 'review_rejected', 'review_approved', 'order_cancelled'],
      required: true,
    },
    order: { type: ObjectId, ref: 'Order', default: null },
    message: { type: String, required: true, maxlength: 500 },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

notificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });

export const Notification =
  mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
