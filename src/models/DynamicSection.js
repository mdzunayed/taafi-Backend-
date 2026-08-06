const mongoose = require('mongoose');

// One content element inside a dynamic home section. Embedded (no own _id);
// `itemId` is a client-generated stable key used for image public_ids.
const ContentItemSchema = new mongoose.Schema(
  {
    itemId: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, default: null },
    // Bengali counterparts of the two text slots. The app has no locale
    // switch — BN renders as a secondary line beside EN, the same treatment
    // the section title already gets — so null simply means "show EN alone".
    titleBn: { type: String, default: null },
    subtitleBn: { type: String, default: null },
    imageUrl: { type: String, required: true },
    priceTag: { type: String, default: null },
    // The capsule floating on the card image ("Popular", "New"). Distinct from
    // `subtitle`: before this field existed the renderer spent `subtitle` on
    // that capsule, so cards saved back then have no badgeText and the client
    // falls back to `subtitle` for them — they keep rendering unchanged.
    badgeText: { type: String, default: null },
    // Per-card visibility. The section-level `isActive` hides a whole block;
    // this hides a single card while leaving it editable in the CMS. Stripped
    // from the public feed (`?active=1`), always present for admins.
    isActive: { type: Boolean, default: true },
    // Which Home filter pill this card belongs under. Null ⇒ the card is
    // untagged and only appears under the implicit "All" pill.
    //
    // Only the Care Services section actually filters on this today, but it
    // lives on the shared item schema rather than a Care-Services-specific one
    // because there is no such thing: CARE_SERVICES is an ordinary
    // DynamicSection with a reserved `sectionKey`.
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
    },
    // --- Target action linking -------------------------------------------
    // What a tap on this card does. Mirrors PromoBanner.actionType; only the
    // field matching `targetType` is expected to be set. Items saved before
    // this field shipped carry only `navigationRoute` — the route layer
    // re-derives their effective target on read (see `normalizeTarget` in
    // routes/homeSections.js), so this default never mislabels them.
    targetType: {
      type: String,
      enum: ['SERVICE', 'CUSTOM_ROUTE', 'EXTERNAL_URL', 'NONE'],
      default: 'SERVICE',
    },
    // The linked catalog service for targetType 'SERVICE'. Populated on read
    // so the patient app can prefill the booking form without a second
    // /api/services round trip.
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service',
      default: null,
    },
    // In-app route string for 'CUSTOM_ROUTE' (e.g. "activities:tracking") or
    // the http(s) address for 'EXTERNAL_URL'.
    customRoute: { type: String, default: '' },
    // Legacy mirror of the resolved target, kept in sync on every write so
    // app builds predating `targetType` keep navigating correctly:
    // "service:<id>", "activities:tracking", "https://…" — unknown values
    // no-op on the client.
    navigationRoute: { type: String, default: null },
    routeArguments: { type: Map, of: String, default: {} },
    // Optional per-card color overrides (admin "micro-branding"). Each is a
    // `#RRGGBB` hex string or null — null means "fall back to the client's
    // built-in theme token", so unset cards render exactly as before. The
    // Light/Dark pairs let a color stay accessible in both display modes; tag
    // colors are single values used in both.
    cardStyles: {
      cardBgLight: { type: String, default: null },
      cardBgDark: { type: String, default: null },
      accentColorLight: { type: String, default: null },
      accentColorDark: { type: String, default: null },
      tagBgColor: { type: String, default: null },
      tagTextColor: { type: String, default: null },
    },
  },
  { _id: false }
);

const DynamicSectionSchema = new mongoose.Schema(
  {
    // Stable natural key, e.g. "trending_doctors", "ramadan_packages".
    sectionKey: { type: String, required: true, unique: true, trim: true },
    titleEn: { type: String, required: true, trim: true },
    titleBn: { type: String, default: null },
    // Which reusable client template renders this section. The client skips
    // sections whose template it doesn't know, so new values can be added
    // here ahead of an app update.
    uiTemplate: {
      type: String,
      enum: [
        'HORIZONTAL_ROUND_AVATAR',
        'HORIZONTAL_PRODUCT_CARD',
        'GRID_2X2_TILES',
        'SINGLE_WIDE_BANNER',
      ],
      required: true,
    },
    // How the section's cards are arranged. Orthogonal to `uiTemplate`, which
    // says what a *card* looks like; this says how the cards are laid out.
    //
    // Only the reserved CARE_SERVICES section reads it today — its renderer is
    // the adaptive layout engine in the app (care_services_section.dart), and
    // this is the field the admin's layout selector writes. Other sections
    // keep rendering from `uiTemplate` and ignore it, so the default is the
    // swipeable rail those sections have always used.
    layoutType: {
      type: String,
      enum: ['GRID_2_COL', 'CAROUSEL', 'LIST'],
      default: 'CAROUSEL',
    },
    // Ascending display order below the fixed Banners + Care Services blocks.
    orderIndex: { type: Number, required: true, index: true },
    isActive: { type: Boolean, default: true, index: true },
    // Optional section-container color overrides. `#RRGGBB` hex or null;
    // null ⇒ the client falls back to its built-in theme token.
    styleTokens: {
      titleColorLight: { type: String, default: null },
      titleColorDark: { type: String, default: null },
      sectionBackgroundColor: { type: String, default: null },
    },
    contentData: { type: [ContentItemSchema], default: [] },
  },
  { timestamps: true }
);

DynamicSectionSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('DynamicSection', DynamicSectionSchema);
