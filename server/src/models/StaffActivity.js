import mongoose from 'mongoose';
import { SEVERITIES } from '../constants/activity.js';

const { ObjectId, Mixed } = mongoose.Schema.Types;

/**
 * Staff activity log (SPEC (ز)): who did what, as one readable Arabic sentence
 * plus structured fields. Append only: update and delete operations are
 * blocked at the model level (rows leave only through the TTL on `expiresAt`,
 * which MongoDB runs itself). No phone numbers are ever stored here.
 */
const targetSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, maxlength: 20 },
    id: { type: String, maxlength: 40 },
    label: { type: String, maxlength: 120 },
  },
  { _id: false },
);

const staffActivitySchema = new mongoose.Schema(
  {
    at: { type: Date, required: true, default: Date.now },
    // Snapshot of the actor at the time of the action.
    actorId: { type: ObjectId, ref: 'User', default: null },
    actorName: { type: String, maxlength: 120 },
    actorRole: { type: String, maxlength: 20 },
    action: { type: String, required: true, maxlength: 60 },
    group: { type: String, required: true, maxlength: 20 },
    severity: { type: String, enum: SEVERITIES, default: 'normal' },
    targets: { type: [targetSchema], default: [] },
    // Only the changed fields, about 1KB at most, never secrets.
    before: { type: Mixed },
    after: { type: Mixed },
    sentence: { type: String, required: true, maxlength: 700 },
    sentenceVersion: { type: Number, default: 1 },
    sessionId: { type: ObjectId, default: null },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

staffActivitySchema.index({ at: -1 });
staffActivitySchema.index({ actorId: 1, at: -1 });
staffActivitySchema.index({ group: 1, at: -1 });
staffActivitySchema.index({ 'targets.type': 1, 'targets.id': 1, at: -1 });
staffActivitySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const blocked = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'];
staffActivitySchema.pre(blocked, function blockMutation() {
  throw new Error('StaffActivity is append-only');
});
staffActivitySchema.pre('save', function blockResave() {
  if (!this.isNew) throw new Error('StaffActivity is append-only');
});

export const StaffActivity = mongoose.models.StaffActivity || mongoose.model('StaffActivity', staffActivitySchema);
