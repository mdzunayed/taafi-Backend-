const express = require('express');
const mongoose = require('mongoose');
const Service = require('../models/Service');
const Category = require('../models/Category');
const {
  upload,
  storeImage,
  removeImage,
} = require('../middleware/upload');
// Redis read-cache: GET is cached for 5 min; every write purges it.
const { cache, invalidateOnSuccess } = require('../services/cacheService');
const { requireRole } = require('../middleware/auth');
const { toAbsolute } = require('../utils/publicUrl');
// Category is canonicalised here, at the write boundary — see the comment on
// the POST handler below for why the model has no `enum`.
const {
  normalizeServiceCategory,
  resolveCategorySlugs,
} = require('../utils/serviceCategories');
// Star ratings are computed from real patient feedback, never stored — see the
// module header for why there is no `Service.rating`.
const { serviceRatings, ratingFor } = require('../utils/serviceRatings');
// Provider type is canonicalised at the same boundary — and, for rows the
// admin has never tagged, inferred at read time so the patient tracker always
// has a role to word its steps with.
const {
  normalizeProviderType,
  inferProviderType,
} = require('../utils/providerTypes');

const router = express.Router();

// The published spec spells the service name `title_en`; this API stores one
// title and emits it as `title` (there is no Bengali counterpart on Service).
// Accept every spelling on write so a payload written against either shape
// lands in the same field, without changing what comes back.
function pickTitle(body) {
  if (body.title !== undefined) return body.title;
  if (body.titleEn !== undefined) return body.titleEn;
  return body.title_en;
}

// Accept either the snake_case wire key or the camelCase one the admin web
// tools send, and fold it onto the canonical vocabulary. `null` (untagged) is
// preserved rather than defaulted — see the model comment for why.
function pickProviderType(body) {
  const raw = body.provider_type !== undefined ? body.provider_type : body.providerType;
  if (raw === undefined) return undefined;
  return normalizeProviderType(raw);
}

// Coerce a stored field to a String for the wire. The schema types these as
// String, but Mongoose only enforces that on documents IT wrote — rows that
// predate a field, or that a migration script / mongosh set by hand, can hold
// a Number or null. The Flutter client is now tolerant of that (see
// ServiceCatalogItem.fromJson), but the API should not be the one emitting it.
function asString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function asPrice(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === '1' || value === 1;
}

// The lookups `decorate` needs to resolve a service's pills and its rating.
//
// Both are collection-wide, so they are fetched ONCE per request rather than
// per row: the categories table is a handful of documents, and the rating
// aggregation is memoized for a minute inside `serviceRatings`.
async function decorateContext({ withRatings = true } = {}) {
  const [categories, ratings] = await Promise.all([
    Category.find().select('_id slug nameEn nameBn').lean(),
    withRatings ? serviceRatings() : Promise.resolve(new Map()),
  ]);
  return {
    categoryById: new Map(categories.map((c) => [String(c._id), c])),
    ratings,
  };
}

const EMPTY_CONTEXT = { categoryById: new Map(), ratings: new Map() };

function decorate(doc, ctx = EMPTY_CONTEXT) {
  const obj = doc.toJSON();
  obj.imageUrl = toAbsolute(obj.imageUrl) || null;
  // Guarantee the shape of every field the patient app reads, so a partially
  // populated legacy row renders as a card with sane defaults instead of
  // reaching the client as a type the model has to defend against.
  obj.id = asString(obj.id || obj._id);
  obj.title = asString(obj.title);
  obj.price = asPrice(obj.price);
  obj.description = asString(obj.description);
  obj.category = asString(obj.category);
  obj.duration = obj.duration ? asString(obj.duration) : null;
  obj.status = obj.status === 'inactive' ? 'inactive' : 'active';

  // Pill membership. `categorySlugs` is the full set the patient filter
  // matches against; `categorySlug` is its first entry, kept as a scalar so
  // app builds that predate multi-category assignment keep filtering.
  obj.categoryIds = (Array.isArray(obj.categoryIds) ? obj.categoryIds : [])
    .map((id) => String((id && (id._id || id.id)) || id || ''))
    .filter(Boolean);
  obj.categorySlugs = resolveCategorySlugs(obj, ctx.categoryById);
  obj.categorySlug = obj.categorySlugs[0] || null;
  obj.isUrgentAvailable = obj.isUrgentAvailable === true;

  // Earned, not stored — 0 / 0 for a service nobody has reviewed yet.
  const stars = ratingFor(ctx.ratings, obj.id);
  obj.rating = stars.rating;
  obj.ratingCount = stars.ratingCount;

  // Resolve the effective provider type for every reader: the stored value
  // when the admin tagged the service, otherwise a best-effort read of the
  // title + category. `provider_type_source` tells the admin console which of
  // the two it is looking at, so an inferred value can be reviewed and saved
  // rather than silently trusted.
  const stored = normalizeProviderType(obj.provider_type);
  const inferred = stored || inferProviderType(obj.title, obj.category);
  obj.provider_type = inferred;
  obj.provider_type_source = stored ? 'assigned' : inferred ? 'inferred' : 'none';
  return obj;
}

// GET /api/services?active=1  (Redis-cached, 5 min)
//
// PUBLIC — deliberately no `requireRole` / auth middleware. The patient Home
// screen renders this catalog, including before sign-in, so gating it would
// blank Care Services for anyone whose session had lapsed. Only the write
// routes below are admin-gated.
router.get('/', cache('services'), async (req, res) => {
  try {
    const filter = {};
    if (req.query.active === '1' || req.query.active === 'true') {
      filter.status = 'active';
    }
    const [docs, ctx] = await Promise.all([
      Service.find(filter).sort({ createdAt: -1 }),
      decorateContext(),
    ]);

    // Decorate per-document. `inferProviderType` reads free-text title and
    // category, so a single pathological row throwing would have turned the
    // whole catalog into a 500 for every user — drop that row and serve the
    // rest. Logged loudly because a row that never renders is otherwise
    // invisible until someone asks why their service is missing.
    const out = [];
    for (const doc of docs) {
      try {
        out.push(decorate(doc, ctx));
      } catch (err) {
        console.error(
          `[services] skipped malformed service ${doc && doc._id}:`,
          err.message,
        );
      }
    }
    res.json(out);
  } catch (err) {
    console.error('[services] GET / failed:', err);
    res.status(500).json({ message: err.message });
  }
});

// The sub-filter vocabulary the patient category view sends, and the comparator
// each one selects. `recommended` is the catalog's own order (newest first),
// which is what the unfiltered Home rail has always shown.
const SORTS = {
  recommended: null,
  price_asc: (a, b) => a.price - b.price,
  price_desc: (a, b) => b.price - a.price,
  // Ties broken by review volume: a lone 5★ should not outrank a 4.9★ with 200
  // reviews, and an unrated service sorts last rather than first.
  rating: (a, b) =>
    b.rating - a.rating || b.ratingCount - a.ratingCount || a.price - b.price,
};

// Tolerates the snake_case spellings the published spec used (`price_asc` is
// already snake, but `sort=price` and `sort=priceAsc` both reach people).
function pickSort(raw) {
  const key = String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return 'recommended';
  if (key === 'price' || key === 'priceasc' || key === 'price_asc') return 'price_asc';
  if (key === 'pricedesc' || key === 'price_desc') return 'price_desc';
  if (key === 'rating' || key === 'top_rated' || key === 'toprated') return 'rating';
  return SORTS[key] !== undefined ? key : 'recommended';
}

// GET /api/services/by-category?categoryId=<id>&slug=<slug>&sort=&urgentOnly=
//   (Redis-cached under the same 'services' namespace, so every admin write
//   already purges it.)
//
// The dedicated category listing behind the patient's Play-Store-style category
// view, and the CMS's "who actually shows up under this pill" preview.
//
// Identify the category by `categoryId` OR `slug` — the patient rail is
// slug-keyed (labels are translatable, ids aren't on the wire for the implicit
// "All" pill) while the CMS holds ids. Omit both, or pass `all`, for the
// unfiltered catalog; `category` then comes back null.
//
// Declared BEFORE the `/:id` routes: Express matches in order, and a bare
// `/:id` GET added later would otherwise swallow "by-category" as an id.
//
// PUBLIC, on the same reasoning as GET / above.
router.get('/by-category', cache('services'), async (req, res) => {
  try {
    const rawId = req.query.categoryId || req.query.category_id || '';
    const rawSlug = req.query.slug || req.query.category_slug || '';
    const wantsAll =
      (!rawId && !rawSlug) ||
      String(rawId).toLowerCase() === 'all' ||
      String(rawSlug).toLowerCase() === 'all';

    let category = null;
    if (!wantsAll) {
      if (rawId && mongoose.Types.ObjectId.isValid(String(rawId))) {
        category = await Category.findById(String(rawId));
      } else if (rawSlug) {
        category = await Category.findOne({ slug: String(rawSlug).trim().toLowerCase() });
      }
      if (!category) {
        return res.status(404).json({ message: 'Category not found' });
      }
    }

    // Fetch the active catalog and filter in memory rather than with a Mongo
    // query on `categoryIds`. It has to be in memory: a service can belong to a
    // pill through the LEGACY free-text `category` too, and that join only
    // exists once `resolveCategorySlugs` has run. The catalog is tens of rows,
    // and the response is Redis-cached per querystring.
    const [docs, ctx] = await Promise.all([
      Service.find({ status: 'active' }).sort({ createdAt: -1 }),
      decorateContext(),
    ]);

    const urgentOnly = asBool(req.query.urgentOnly ?? req.query.urgent_only);
    const sortKey = pickSort(req.query.sort);

    const services = [];
    for (const doc of docs) {
      let obj;
      try {
        obj = decorate(doc, ctx);
      } catch (err) {
        console.error(
          `[services] skipped malformed service ${doc && doc._id}:`,
          err.message,
        );
        continue;
      }
      if (category && !obj.categorySlugs.includes(category.slug)) continue;
      if (urgentOnly && !obj.isUrgentAvailable) continue;
      services.push(obj);
    }

    const comparator = SORTS[sortKey];
    if (comparator) services.sort(comparator);

    res.json({
      category: category
        ? {
            id: String(category._id),
            nameEn: category.nameEn,
            nameBn: category.nameBn || null,
            slug: category.slug,
            descriptionEn: category.descriptionEn || null,
            descriptionBn: category.descriptionBn || null,
            iconUrl: toAbsolute(category.iconUrl) || null,
          }
        : null,
      // `totalServices` counts what this response contains, sub-filters
      // included — it is the number the header banner prints, so it has to
      // agree with the list underneath it.
      totalServices: services.length,
      sort: sortKey,
      urgentOnly,
      services,
    });
  } catch (err) {
    console.error('[services] GET /by-category failed:', err);
    res.status(500).json({ message: err.message });
  }
});

// Explicit Home-pill assignment off a write body.
//
// Multipart can't carry a JSON array natively, so three spellings are accepted:
// a real array (JSON body), repeated `categoryIds` fields (Dio FormData), and a
// JSON / comma-separated string. `undefined` means "not sent, leave alone";
// an empty array is a real value that CLEARS every assignment, which is why the
// Flutter admin always sends the JSON string form rather than omitting the key.
function pickCategoryIds(body) {
  let raw = body.categoryIds !== undefined ? body.categoryIds : body.category_ids;

  // The published spec links a service to ONE category (`category_id`). The
  // stored shape stays an array — a service legitimately sits on several pills,
  // which a scalar could never express — so the singular is folded in as a
  // one-entry list rather than given a field of its own. The plural wins when
  // both are sent: it is the richer statement, and a client sending both meant
  // the array. Below, the string branch already handles a bare id.
  if (raw === undefined || raw === null) {
    raw = body.categoryId !== undefined ? body.categoryId : body.category_id;
    if (raw === undefined || raw === null) return undefined;
  }

  let list = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        list = JSON.parse(trimmed);
      } catch {
        return [];
      }
    } else {
      list = trimmed.split(',');
    }
  }
  if (!Array.isArray(list)) list = [list];

  const out = [];
  for (const entry of list) {
    const id = String(entry || '').trim();
    // Silently drop anything that isn't an id: this is a coerce-don't-reject
    // boundary like `category` and `provider_type` above, and a stale client
    // sending a deleted pill must not 400 an otherwise valid save.
    if (mongoose.Types.ObjectId.isValid(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

// POST /api/services  (multipart: fields + image)
router.post('/', requireRole('admin'), invalidateOnSuccess('services'), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'image is required' });
    const { price, description, category, duration, status } = req.body;
    const title = pickTitle(req.body);
    if (!title || !title.trim()) return res.status(400).json({ message: 'title is required' });
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      return res.status(400).json({ message: 'price must be > 0' });
    }

    // Store the image BEFORE creating the row. Service.imageUrl defaults to
    // null (models/Service.js), so creating first meant a storeImage failure
    // left a permanent image-less service behind — visible in the admin list
    // on the next GET despite this endpoint's "image is required" contract.
    // The _id is only needed as a stable publicId, so mint it up front.
    const _id = new mongoose.Types.ObjectId();
    const imageUrl = await storeImage(req.file.buffer, _id.toString());

    const doc = await Service.create({
      _id,
      imageUrl,
      title: title.trim(),
      price: priceNum,
      description: description || '',
      // Coerce, don't reject. This route is the only writer of `category`, so
      // folding every alias onto the canonical vocabulary here means a stale
      // app build, a script, or a hand-rolled curl can never introduce a value
      // the patient Home chips don't understand. Anything unrecognised lands
      // as '' (uncategorized) and stays visible under the 'All' chip.
      category: normalizeServiceCategory(category),
      // The explicit multi-pill assignment. Unlike `category` it is NOT folded
      // through the alias table — these are real Category ids the admin ticked.
      categoryIds: pickCategoryIds(req.body) ?? [],
      isUrgentAvailable: asBool(
        req.body.isUrgentAvailable ?? req.body.is_urgent_available,
      ),
      // Same coerce-don't-reject rule as `category`: an unrecognised role
      // lands as null (untagged) and `decorate` infers one for readers.
      provider_type: pickProviderType(req.body) ?? null,
      duration: duration && duration.length ? duration : null,
      status: status === 'inactive' ? 'inactive' : 'active',
    });

    res.status(201).json(decorate(doc, await decorateContext()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/services/:id  (multipart: fields + optional new image)
router.put('/:id', requireRole('admin'), invalidateOnSuccess('services'), upload.single('image'), async (req, res) => {
  try {
    const doc = await Service.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Service not found' });

    const { price, description, category, duration, status } = req.body;
    const title = pickTitle(req.body);

    if (title !== undefined) {
      if (!title.trim()) return res.status(400).json({ message: 'title cannot be empty' });
      doc.title = title.trim();
    }
    if (price !== undefined) {
      const priceNum = Number(price);
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        return res.status(400).json({ message: 'price must be > 0' });
      }
      doc.price = priceNum;
    }
    if (description !== undefined) doc.description = description;
    if (category !== undefined) doc.category = normalizeServiceCategory(category);

    const categoryIds = pickCategoryIds(req.body);
    if (categoryIds !== undefined) doc.categoryIds = categoryIds;

    const urgent = req.body.isUrgentAvailable ?? req.body.is_urgent_available;
    if (urgent !== undefined) doc.isUrgentAvailable = asBool(urgent);

    const providerType = pickProviderType(req.body);
    if (providerType !== undefined) doc.provider_type = providerType;
    if (duration !== undefined) doc.duration = duration && duration.length ? duration : null;
    if (status !== undefined) doc.status = status === 'inactive' ? 'inactive' : 'active';

    if (req.file) {
      doc.imageUrl = await storeImage(req.file.buffer, doc._id.toString());
    }

    await doc.save();
    res.json(decorate(doc, await decorateContext()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/services/:id/status  { status: "active" | "inactive" }
router.patch('/:id/status', requireRole('admin'), invalidateOnSuccess('services'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ message: 'status must be "active" or "inactive"' });
    }
    const doc = await Service.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: 'Service not found' });
    res.json(decorate(doc, await decorateContext()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/services/:id
router.delete('/:id', requireRole('admin'), invalidateOnSuccess('services'), async (req, res) => {
  try {
    const doc = await Service.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Service not found' });
    await removeImage(doc._id.toString());
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
// Test seams for tests/homeCategories.test.js — the sort vocabulary is
// mirrored client-side, so it is pinned on both sides rather than trusted.
module.exports._pickSort = pickSort;
module.exports._SORTS = SORTS;
// Exported for tests/serviceCategoryLinking.test.js — the write boundary that
// folds every accepted spelling of "which category" onto one stored array.
module.exports._pickCategoryIds = pickCategoryIds;
module.exports._pickTitle = pickTitle;
