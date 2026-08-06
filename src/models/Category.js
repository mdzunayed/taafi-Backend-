const mongoose = require('mongoose');

// An admin-managed filter pill on the patient Home screen ("Nursing",
// "Post-op", "Doctor in Home", …).
//
// The chip rail used to be a hardcoded three-entry list compiled into both the
// API (utils/serviceCategories.js) and the app (models/service_category.dart),
// so adding a category meant shipping a mobile release. These documents replace
// that list at runtime; the compiled table survives as the *alias* fold that
// maps legacy free-text `Service.category` values onto a slug (see
// `categorySlug` in utils/serviceCategories.js), which is what joins a service
// to its pill.
//
// The implicit "All" pill is NOT stored — the client always renders it at index
// 0. Storing it would make it deletable, and a rail with no way back to the
// unfiltered catalog is a trap.
const CategorySchema = new mongoose.Schema(
  {
    nameEn: { type: String, required: true, trim: true },
    // Bengali counterpart. The app has no locale switch — BN renders as a
    // secondary line, the same treatment section titles get — so null simply
    // means "show EN alone".
    nameBn: { type: String, default: null },
    // One-line blurb rendered under the title on the patient's dedicated
    // category view ("Licensed doctors visiting your home for consultations").
    // Null ⇒ the header shows the title and the service count alone, which is
    // what every pill created before this field does.
    descriptionEn: { type: String, default: null },
    descriptionBn: { type: String, default: null },
    // The join key, not a display string: `categorySlug(service.category)` is
    // matched against this. Lowercase kebab-case, unique, and derived from
    // `nameEn` when the admin doesn't supply one.
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    // Optional pill glyph. An http(s) URL or an upload-pipeline path; null ⇒
    // the client renders the label alone.
    iconUrl: { type: String, default: null },
    // Ascending rail order, left to right after the implicit "All" pill.
    displayOrder: { type: Number, required: true, default: 0, index: true },
    // Hides the pill from the patient rail without deleting it (and without
    // orphaning the services tagged with it — they stay reachable under "All").
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

CategorySchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Category', CategorySchema);
