const express = require('express');
const Category = require('../models/Category');
const DynamicSection = require('../models/DynamicSection');
const Service = require('../models/Service');
const homeSections = require('./homeSections');
const {
  normalizeServiceCategory,
  resolveCategorySlugs,
} = require('../utils/serviceCategories');
const { serviceRatings, ratingFor } = require('../utils/serviceRatings');
const { toAbsolute } = require('../utils/publicUrl');

const { CARE_SERVICES_KEY, ITEM_POPULATE, decorate } = homeSections;

const router = express.Router();

// One-shot payload for the patient Home screen.
//
// PUBLIC, for the same reason GET /api/services is: Home renders before
// sign-in, and a gated feed would leave a new user staring at an empty screen.
//
// Home previously opened with three parallel requests (categories were
// compiled into the binary, sections and the catalog each had their own hop).
// Everything above the fold is now admin-controlled and interdependent — a
// card's pill has to exist for the filter to mean anything — so it is
// assembled server-side and served as one document.

// How a Care Services card reaches the wire. Both branches below emit this
// exact shape, which is what lets the app hold one card model and one adaptive
// renderer rather than a CMS path and a catalog path that drift.
function card({
  itemId,
  serviceId = null,
  categoryId = null,
  categorySlug: slug = null,
  categorySlugs = null,
  titleEn,
  titleBn = null,
  subtitleEn = null,
  subtitleBn = null,
  price = null,
  priceTag = null,
  badgeText = null,
  imageUrl = null,
  isUrgentAvailable = false,
  rating = 0,
  ratingCount = 0,
}) {
  // `categorySlugs` is the set the patient filter matches against — one service
  // can sit under several pills now. `categorySlug` stays as its first entry so
  // installed app builds that predate multi-assignment keep filtering.
  const slugs = Array.isArray(categorySlugs)
    ? categorySlugs.filter(Boolean)
    : slug
      ? [slug]
      : [];
  return {
    itemId,
    serviceId,
    categoryId,
    categorySlug: slugs[0] || null,
    categorySlugs: slugs,
    titleEn,
    titleBn,
    subtitleEn,
    subtitleBn,
    price,
    priceTag,
    badgeText,
    imageUrl,
    // Sub-filter inputs for the dedicated category view. Shipped with the
    // cards rather than fetched on demand so switching pills — and sorting
    // inside one — stays a pure client-side re-render with no round trip.
    isUrgentAvailable: isUrgentAvailable === true,
    rating,
    ratingCount,
    isActive: true,
  };
}

// Digits out of a freeform price tag ("৳2,400" → 2400), so a curated card can
// still sort/compare like a catalog one. Null when the tag is words ("Free").
function priceFromTag(tag) {
  const digits = String(tag || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

// Projects the live catalog onto Care Services cards — the default source, and
// what every existing deployment gets until an admin curates the section.
//
// The join to a pill is by slug, not by a stored reference: services carry a
// free-text `category`, and `categorySlug` folds legacy values ('Recovery')
// onto their canonical slug ('post-op') before matching. `bySlug` then
// resolves the pill's id, so a curated card and a catalog card carry the same
// `categoryId` and the client filter has one rule.
function fromCatalog(services, bySlug, byId, ratings) {
  return services.map((doc) => {
    const obj = doc.toJSON ? doc.toJSON() : doc;
    const id = String(obj.id || obj._id);
    // The full pill set: the admin's explicit `categoryIds` when they assigned
    // any, otherwise the legacy free-text join. The first entry is "primary",
    // and it is the one the badge and the scalar `categorySlug` follow.
    const slugs = resolveCategorySlugs(obj, byId);
    const primary = slugs[0] || '';
    const matched = primary ? bySlug.get(primary) : null;
    const stars = ratingFor(ratings, id);
    return card({
      itemId: `svc_${id}`,
      serviceId: id,
      categoryId: matched ? String(matched._id) : null,
      categorySlugs: slugs,
      titleEn: obj.title || '',
      subtitleEn: obj.description || null,
      price: typeof obj.price === 'number' ? obj.price : Number(obj.price) || 0,
      // The badge reads as the pill the admin named it, falling back to the
      // canonical label so an untagged-but-recognisable service still shows
      // one. Blank when neither applies rather than printing a raw slug.
      badgeText: matched
        ? matched.nameEn
        : normalizeServiceCategory(obj.category) || null,
      imageUrl: toAbsolute(obj.imageUrl) || null,
      isUrgentAvailable: obj.isUrgentAvailable === true,
      rating: stars.rating,
      ratingCount: stars.ratingCount,
    });
  });
}

// Projects a curated CARE_SERVICES section's cards. `items` have already been
// through `decorate`, so ids are flat, images absolute, and hidden cards gone.
//
// The badge/description split mirrors HomeSectionItem's: before `badgeText`
// existed the capsule was spent on `subtitle`, so a card saved back then must
// keep rendering its subtitle as the badge and show no description line.
function fromCuratedSection(items, byId, servicesById, ratings) {
  return items.map((item) => {
    const badge = (item.badgeText || '').trim();
    const subtitle = (item.subtitle || '').trim();
    const price = priceFromTag(item.priceTag) ??
      (item.service ? item.service.price : null);
    // A curated card's own pill assignment wins; a card the admin linked to a
    // service but never tagged inherits that service's pills, so curating the
    // block doesn't silently empty every filter.
    const linked = item.serviceId ? servicesById.get(String(item.serviceId)) : null;
    const slugs = item.categorySlug
      ? [item.categorySlug]
      : linked
        ? resolveCategorySlugs(linked, byId)
        : [];
    const stars = ratingFor(ratings, item.serviceId);
    return card({
      itemId: item.itemId,
      serviceId: item.serviceId || null,
      categoryId: item.categoryId || null,
      categorySlugs: slugs,
      // Urgency is a property of the underlying service, not of the card an
      // admin arranged, so an unlinked curated card is never "urgent".
      isUrgentAvailable: linked ? linked.isUrgentAvailable === true : false,
      rating: stars.rating,
      ratingCount: stars.ratingCount,
      titleEn: item.title || '',
      titleBn: item.titleBn || null,
      // Legacy card (no explicit badge) ⇒ subtitle is still the badge.
      subtitleEn: badge ? subtitle || null : null,
      subtitleBn: badge ? item.subtitleBn || null : null,
      price,
      priceTag: item.priceTag || null,
      badgeText: badge || subtitle || null,
      imageUrl: item.imageUrl || null,
    });
  });
}

// GET /api/home-data
router.get('/', async (req, res) => {
  try {
    const [allCategories, sections, services, ratings] = await Promise.all([
      // ALL pills, not just the active ones: a hidden pill still has to resolve
      // an id → slug for `resolveCategorySlugs`, otherwise hiding a category
      // would silently untag every service assigned to it. Only the rail below
      // is filtered to the active ones.
      Category.find().sort({ displayOrder: 1, createdAt: 1 }),
      DynamicSection.find({ isActive: true })
        .sort({ orderIndex: 1, createdAt: -1 })
        .populate(ITEM_POPULATE),
      Service.find({ status: 'active' }).sort({ createdAt: -1 }),
      serviceRatings(),
    ]);

    const categories = allCategories.filter((c) => c.isActive);
    const bySlug = new Map(allCategories.map((c) => [c.slug, c]));
    const byId = new Map(allCategories.map((c) => [String(c._id), c]));
    const servicesById = new Map(services.map((s) => [String(s._id), s]));

    const careSection = sections.find((s) => s.sectionKey === CARE_SERVICES_KEY);
    const careDecorated = careSection
      ? decorate(careSection, { publicOnly: true })
      : null;
    const curated = careDecorated ? careDecorated.contentData : [];

    // Curation is opt-in per section: an admin who only ever touches the
    // layout selector leaves `contentData` empty and keeps the live catalog,
    // which is the behaviour Home has always had. Adding a single card is what
    // switches the block over — and is reported as `source` so the CMS can say
    // which one is on screen.
    const useCurated = curated.length > 0;

    res.json({
      categories: categories.map((c) => {
        const obj = c.toJSON();
        obj.iconUrl = toAbsolute(obj.iconUrl) || null;
        return obj;
      }),
      careServices: {
        id: careDecorated ? careDecorated.id : null,
        sectionKey: CARE_SERVICES_KEY,
        titleEn: careDecorated ? careDecorated.titleEn : 'Care services',
        titleBn: careDecorated ? careDecorated.titleBn : 'সেবা',
        // No section document yet ⇒ the rail the block has always rendered.
        layoutType: careDecorated ? careDecorated.layoutType : 'CAROUSEL',
        isActive: careDecorated ? careDecorated.isActive !== false : true,
        source: useCurated ? 'CURATED' : 'CATALOG',
        services: useCurated
          ? fromCuratedSection(curated, byId, servicesById, ratings)
          : fromCatalog(services, bySlug, byId, ratings),
      },
      // Everything below Care Services, minus the reserved section itself —
      // it is rendered by the Care Services block, and leaving it here would
      // draw it a second time.
      sections: sections
        .filter((s) => s.sectionKey !== CARE_SERVICES_KEY)
        .map((s) => decorate(s, { publicOnly: true })),
    });
  } catch (err) {
    console.error('[home-data] GET / failed:', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
