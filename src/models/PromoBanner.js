const mongoose = require('mongoose');

const PromoBannerSchema = new mongoose.Schema(
  {
    tagText: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    buttonText: { type: String, required: true, trim: true },
    imageUrl: { type: String, default: null },
    // Two (or more) HEX stops driving the card's background gradient, e.g.
    // ['#4C1D95', '#8B5CF6']. Stored verbatim; the client parses them.
    gradientColors: {
      type: [String],
      default: ['#4C1D95', '#8B5CF6'],
    },
    // Ascending display order in the Home slider. Lower shows first.
    priorityOrder: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true, index: true },

    // --- Deep-link destination for the CTA button -----------------------
    // What happens when the patient taps `buttonText`. SERVICE/CATEGORY open
    // the app in-context; EXTERNAL_URL leaves the app; PROMO_CODE pre-fills
    // the code into the booking flow; NONE is a display-only banner (no tap
    // action). Only the field matching `actionType` is expected to be set —
    // the others are left at their defaults.
    actionType: {
      type: String,
      enum: ['SERVICE', 'CATEGORY', 'EXTERNAL_URL', 'PROMO_CODE', 'NONE'],
      default: 'SERVICE',
    },
    targetServiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service',
      default: null,
    },
    // Free-text service `category` value (services have no category
    // collection of their own — see Service.js) — matched against
    // Service.category on the client to filter the catalog screen.
    targetCategoryId: { type: String, default: null },
    targetUrl: { type: String, default: '', trim: true },
    promoCode: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

PromoBannerSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('PromoBanner', PromoBannerSchema);
