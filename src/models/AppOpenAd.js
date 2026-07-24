const mongoose = require('mongoose');

// Full-screen interstitial shown once when the patient app launches.
// Managed as a singleton campaign: the routes upsert a single document,
// so "the" app-open ad is always findOne() — no ordering concerns.
const AppOpenAdSchema = new mongoose.Schema(
  {
    imageUrl: { type: String, required: true },
    // How long the interstitial holds the screen before the client
    // auto-dismisses to Home. Clamped by the routes to 1..60 s.
    durationInSeconds: { type: Number, default: 5, required: true },
    isActive: { type: Boolean, default: false },
  },
  { timestamps: true }
);

AppOpenAdSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('AppOpenAd', AppOpenAdSchema);
