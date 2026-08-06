const express = require('express');
const Category = require('../models/Category');
const { requireRole } = require('../middleware/auth');
const { slugify } = require('../utils/serviceCategories');
const { toAbsolute } = require('../utils/publicUrl');
// A category's slug and its id→slug mapping are what `resolveCategorySlugs`
// turns into each service's `categorySlugs`, so the writes that touch either
// have to purge the Redis-cached service catalog alongside their own change.
const { invalidateOnSuccess } = require('../services/cacheService');

const router = express.Router();

// Slugs are the join key against `categorySlug(service.category)`, which emits
// lowercase kebab-case — so anything outside that charset could never match a
// service and is rejected rather than silently stored as a dead pill.
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return raw === true || raw === 'true' || raw === '1' || raw === 1;
}

// Trims an optional free-text field to null when blank, so "cleared in the
// CMS" and "never set" reach the client as the same absent value. (Same
// contract as `optionalText` in homeSections.js.)
function optionalText(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s || null;
}

// Accepts the camelCase keys the rest of this API speaks and the snake_case
// spelling of the same field. The Flutter admin sends camelCase; the
// snake_case fallbacks exist so a payload written against the published
// `name_en` / `icon_url` shape isn't silently dropped into a document with a
// missing name.
function pick(body, camel, snake) {
  return body[camel] !== undefined ? body[camel] : body[snake];
}

function decorate(doc) {
  const obj = doc.toJSON();
  obj.iconUrl = toAbsolute(obj.iconUrl) || null;
  return obj;
}

// Resolves the slug for a write. Explicit wins; otherwise it is minted from
// the English name, which is what the admin console relies on (the form has no
// slug field until you expand "Advanced").
function resolveSlug(body, nameEn) {
  const explicit = optionalText(pick(body, 'slug', 'slug'));
  const slug = slugify(explicit || nameEn || '');
  if (!slug) throw new Error('slug could not be derived — provide one explicitly');
  if (!SAFE_SLUG.test(slug)) {
    throw new Error('slug must be lowercase letters, digits and single hyphens');
  }
  return slug;
}

// GET /api/categories?active=1  (public — the patient chip rail reads this)
//
// PUBLIC by the same reasoning as GET /api/services: Home renders before
// sign-in, and a gated rail would leave the patient with a single "All" pill.
router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.active === '1' || req.query.active === 'true') {
      filter.isActive = true;
    }
    const docs = await Category.find(filter).sort({ displayOrder: 1, createdAt: 1 });
    res.json(docs.map(decorate));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/categories/reorder  { ids: [...] }  (admin)
// Renumbers displayOrder to match the supplied id order (0..n-1).
//
// Declared before `/:id` — Express matches in order, so the reverse would let
// the id routes swallow "reorder" as a category id.
router.patch('/reorder', requireRole('admin'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'ids must be a non-empty array' });
    }
    const ops = ids.map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { displayOrder: index } } },
    }));
    await Category.bulkWrite(ops);
    const docs = await Category.find().sort({ displayOrder: 1, createdAt: 1 });
    res.json(docs.map(decorate));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/categories  (admin; JSON body)
router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const nameEn = optionalText(pick(req.body, 'nameEn', 'name_en'));
    if (!nameEn) return res.status(400).json({ message: 'nameEn is required' });

    let slug;
    try {
      slug = resolveSlug(req.body, nameEn);
    } catch (e) {
      return res.status(400).json({ message: e.message });
    }

    const existing = await Category.findOne({ slug }).select('_id');
    if (existing) {
      return res.status(409).json({ message: `A category with slug "${slug}" already exists` });
    }

    // Default a new pill to the end of the rail.
    const last = await Category.findOne().sort({ displayOrder: -1 }).select('displayOrder');
    const nextOrder = last ? last.displayOrder + 1 : 0;
    const rawOrder = pick(req.body, 'displayOrder', 'display_order');

    const doc = await Category.create({
      nameEn,
      nameBn: optionalText(pick(req.body, 'nameBn', 'name_bn')),
      descriptionEn: optionalText(pick(req.body, 'descriptionEn', 'description_en')),
      descriptionBn: optionalText(pick(req.body, 'descriptionBn', 'description_bn')),
      slug,
      iconUrl: optionalText(pick(req.body, 'iconUrl', 'icon_url')),
      displayOrder: rawOrder !== undefined ? Number(rawOrder) : nextOrder,
      isActive: parseBool(pick(req.body, 'isActive', 'is_active'), true),
    });
    res.status(201).json(decorate(doc));
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ message: 'slug already exists' });
    }
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/categories/:id/status  { isActive: boolean }  (admin)
// One-tap show/hide, so flipping a pill's visibility doesn't round-trip the
// whole document from a stale editor.
router.patch('/:id/status', requireRole('admin'), async (req, res) => {
  try {
    const raw = pick(req.body, 'isActive', 'is_active');
    if (raw === undefined) {
      return res.status(400).json({ message: 'isActive is required' });
    }
    const doc = await Category.findByIdAndUpdate(
      req.params.id,
      { isActive: parseBool(raw, true) },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: 'Category not found' });
    res.json(decorate(doc));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/categories/:id  (admin; partial update)
// PUT is aliased onto the same handler: every field is optional either way, so
// the two verbs would have identical bodies.
async function updateCategory(req, res) {
  try {
    const doc = await Category.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Category not found' });

    const nameEn = pick(req.body, 'nameEn', 'name_en');
    if (nameEn !== undefined) {
      const trimmed = optionalText(nameEn);
      if (!trimmed) return res.status(400).json({ message: 'nameEn cannot be empty' });
      doc.nameEn = trimmed;
    }

    const nameBn = pick(req.body, 'nameBn', 'name_bn');
    if (nameBn !== undefined) doc.nameBn = optionalText(nameBn);

    // Blurb under the title on the patient's dedicated category view.
    const descriptionEn = pick(req.body, 'descriptionEn', 'description_en');
    if (descriptionEn !== undefined) doc.descriptionEn = optionalText(descriptionEn);

    const descriptionBn = pick(req.body, 'descriptionBn', 'description_bn');
    if (descriptionBn !== undefined) doc.descriptionBn = optionalText(descriptionBn);

    const iconUrl = pick(req.body, 'iconUrl', 'icon_url');
    if (iconUrl !== undefined) doc.iconUrl = optionalText(iconUrl);

    const displayOrder = pick(req.body, 'displayOrder', 'display_order');
    if (displayOrder !== undefined) doc.displayOrder = Number(displayOrder);

    const isActive = pick(req.body, 'isActive', 'is_active');
    if (isActive !== undefined) doc.isActive = parseBool(isActive, doc.isActive);

    // Editing a slug re-points the pill at a different set of services, so it
    // is only touched when the admin sends one explicitly — renaming "Nursing"
    // to "Home Nursing" must not silently empty the pill.
    const slug = pick(req.body, 'slug', 'slug');
    if (slug !== undefined) {
      let next;
      try {
        next = resolveSlug({ slug }, doc.nameEn);
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }
      if (next !== doc.slug) {
        const clash = await Category.findOne({ slug: next, _id: { $ne: doc._id } }).select('_id');
        if (clash) {
          return res.status(409).json({ message: `A category with slug "${next}" already exists` });
        }
        doc.slug = next;
      }
    }

    await doc.save();
    res.json(decorate(doc));
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ message: 'slug already exists' });
    }
    res.status(500).json({ message: err.message });
  }
}

// Both purge the service catalog: renaming a slug re-points every service
// assigned to this pill, and a cached `categorySlugs` would keep naming the
// old one.
router.patch('/:id', requireRole('admin'), invalidateOnSuccess('services'), updateCategory);
router.put('/:id', requireRole('admin'), invalidateOnSuccess('services'), updateCategory);

// DELETE /api/categories/:id  (admin)
//
// Legacy free-text tagging is joined by slug, not by a stored reference, so
// deleting a pill never orphans those services — they simply stop having a pill
// to appear under and remain visible under "All". Curated section cards and
// explicitly-assigned services DO carry ids; both are cleaned up here so the
// app never filters against a dangling reference.
//
// Purges the `services` cache namespace because it edits Service documents:
// `categorySlugs` is computed at read time from the ids below, so a stale
// GET /api/services would keep advertising a pill that no longer exists.
router.delete('/:id', requireRole('admin'), invalidateOnSuccess('services'), async (req, res) => {
  try {
    const doc = await Category.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Category not found' });
    // Required lazily: routes/homeSections.js requires this module's sibling
    // utils, and a top-level import here would close a require cycle through
    // the model registry.
    const DynamicSection = require('../models/DynamicSection');
    const Service = require('../models/Service');

    // Captured BEFORE the $pull. Afterwards a service that was assigned only to
    // this pill is indistinguishable from one that was never assigned at all,
    // and the difference decides where it lands.
    const linked = await Service.find({ categoryIds: doc._id }).select('_id categoryIds');
    const orphanedIds = linked
      .filter((s) => (s.categoryIds || []).length === 1)
      .map((s) => s._id);

    await Service.updateMany(
      { categoryIds: doc._id },
      { $pull: { categoryIds: doc._id } },
    );

    // Services left with NO assignment fall back to "All" — the one placement
    // nobody has to guess at.
    //
    // Without this they would fall through to the legacy free-text join
    // (`resolveCategorySlugs`) and silently resurface under whatever pill their
    // old `category` string happens to match: deleting "Nursing" would move
    // its services to Post-op behind the admin's back, which reads as data
    // corruption from the CMS. Clearing the legacy string is safe precisely
    // because these rows carried an EXPLICIT assignment — the admin had already
    // overridden that field, and `resolveCategorySlugs` has ignored it ever
    // since. Rows that only ever had the legacy tag are untouched.
    if (orphanedIds.length > 0) {
      await Service.updateMany(
        { _id: { $in: orphanedIds } },
        { $set: { category: '' } },
      );
    }

    await DynamicSection.updateMany(
      { 'contentData.categoryId': doc._id },
      { $set: { 'contentData.$[card].categoryId': null } },
      { arrayFilters: [{ 'card.categoryId': doc._id }] }
    );
    // Reported so the CMS can say what the delete actually moved, rather than
    // leaving the operator to discover it on the patient Home.
    res.json({ ok: true, servicesMovedToAll: orphanedIds.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
