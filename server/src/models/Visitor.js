import mongoose from 'mongoose';

/** How long an anonymous visitor (and its page history) is kept after the last visit. */
export const VISITOR_RETENTION_DAYS = 90;
export const VISITOR_LAST_PAGES = 20;

/**
 * Anonymous storefront visitor. `visitorId` is a random id the storefront
 * stores on the device; it does not identify a person. No IP address or
 * user agent is stored. Documents expire VISITOR_RETENTION_DAYS after the
 * last visit (TTL index on lastSeen).
 */
const visitorSchema = new mongoose.Schema(
  {
    visitorId: { type: String, required: true, maxlength: 64 },
    firstSeen: { type: Date, required: true },
    lastSeen: { type: Date, required: true },
    visits: { type: Number, default: 0 },
    pages: { type: Number, default: 0 },
    lastPages: {
      type: [
        new mongoose.Schema(
          {
            path: { type: String, maxlength: 300 },
            title: { type: String, maxlength: 200, default: '' },
            at: { type: Date },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: false, versionKey: false },
);

visitorSchema.index({ visitorId: 1 }, { unique: true });
visitorSchema.index({ lastSeen: 1 }, { expireAfterSeconds: VISITOR_RETENTION_DAYS * 24 * 60 * 60 });

export const Visitor = mongoose.models.Visitor || mongoose.model('Visitor', visitorSchema);
