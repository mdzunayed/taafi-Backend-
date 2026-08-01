const mongoose = require('mongoose');
const { PROVIDER_TYPES } = require('../utils/providerTypes');

const ServiceSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    description: { type: String, default: '' },
    // Canonical values live in ../utils/serviceCategories.js ('Post-op',
    // 'Doctor in Home', or '' for uncategorized) and are enforced by
    // `normalizeServiceCategory` in routes/services.js — the only writer.
    //
    // Deliberately NOT a Mongoose `enum`: PUT /api/services/:id loads the doc
    // and calls `doc.save()`, which runs full-document validation, so any row
    // still holding a legacy category would 500 on every edit — including the
    // edit meant to fix it. Normalizing at the route boundary gives the same
    // guarantee without stranding un-migrated rows.
    category: { type: String, default: '' },
    // Who attends this service — DOCTOR / NURSE / PHYSIOTHERAPIST / LAB_TECH
    // (canonical list in ../utils/providerTypes.js). Copied onto every booking
    // at creation time, where it drives the patient tracker's wording ("Nurse
    // On the Way" vs "Doctor On the Way") and the pre-arrival preparation tip.
    //
    // `null` means the admin has never tagged this service, NOT "nurse": the
    // read boundary in routes/services.js falls back to inferring a type from
    // the title/category so a legacy row still yields correct patient copy,
    // and `scripts/backfillProviderTypes.js` persists that inference. Defaulting
    // to NURSE here would have erased the distinction on the first read.
    provider_type: {
      type: String,
      enum: [...PROVIDER_TYPES, null],
      default: null,
    },
    duration: { type: String, default: null },
    imageUrl: { type: String, default: null },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
  },
  { timestamps: true }
);

ServiceSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Service', ServiceSchema);
