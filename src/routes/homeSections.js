const express = require('express');
const mongoose = require('mongoose');
const DynamicSection = require('../models/DynamicSection');
const Service = require('../models/Service');
const {
  upload,
  storeImage,
  removeImage,
} = require('../middleware/upload');
const { requireRole } = require('../middleware/auth');

const { toAbsolute } = require('../utils/publicUrl');

const router = express.Router();

// Deterministic image public_id for a content item; also matched on delete.
const itemImageId = (itemId) => `hsitem_${itemId}`;

// itemId is caller-supplied and reaches path.join() via writeImageToDisk's
// `hsitem_${itemId}.jpg`, so a value like `../../evil` escapes UPLOAD_DIR.
// The endpoint is admin-gated, making this hardening rather than an open
// hole — but the constraint costs nothing and the ids the client actually
// sends are already plain slugs.
const SAFE_ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;

const TARGET_TYPES = ['SERVICE', 'CUSTOM_ROUTE', 'EXTERNAL_URL', 'NONE'];

// Populated so the patient app's tap handler can prefill the booking form
// with title/price/category/image immediately — no second /api/services hop.
// (Mirrors TARGET_SERVICE_POPULATE in promoBanners.js.)
const ITEM_SERVICE_POPULATE = {
  path: 'contentData.serviceId',
  select: '_id title price category imageUrl status',
};

// Resolved alongside the service so the client can filter a card against the
// Home pill rail without holding a second id→slug table. `slug` is the join
// key; the names come along for the CMS list, which shows what a card is
// tagged as without a lookup.
const ITEM_CATEGORY_POPULATE = {
  path: 'contentData.categoryId',
  select: '_id slug nameEn nameBn',
};

const ITEM_POPULATE = [ITEM_SERVICE_POPULATE, ITEM_CATEGORY_POPULATE];

// The one `sectionKey` the app treats specially: it is the Care Services block
// on Home, so the patient renderer reads its `layoutType` and skips it in the
// generic dynamic-sections list (otherwise it would render twice).
const CARE_SERVICES_KEY = 'CARE_SERVICES';

const LAYOUT_TYPES = DynamicSection.schema.path('layoutType').enumValues;

const isHttp = (v) => /^https?:\/\//i.test(v || '');

// Resolves an item's effective target for the wire, so clients never have to
// interpret a half-set document. Items written before `targetType` existed
// carry only `navigationRoute`, and mongoose hands those back with the schema
// default ('SERVICE') on a null serviceId — inferring from the route string
// in that case keeps their taps working exactly as before. Also re-emits
// `navigationRoute` as the canonical legacy mirror for older app builds.
function normalizeTarget(item) {
  const route = (item.customRoute || item.navigationRoute || '').trim();
  const rawId = item.serviceId && (item.serviceId._id || item.serviceId);
  const serviceId = rawId ? String(rawId) : null;

  let targetType = TARGET_TYPES.includes(item.targetType) ? item.targetType : 'NONE';
  if (targetType === 'SERVICE' && !serviceId) {
    // Unset / legacy item — fall back to what the route string says.
    if (isHttp(route)) targetType = 'EXTERNAL_URL';
    else if (route.startsWith('service:')) targetType = 'SERVICE';
    else targetType = route ? 'CUSTOM_ROUTE' : 'NONE';
  }

  const legacyServiceId = serviceId ||
    (route.startsWith('service:') ? route.slice('service:'.length).trim() : null);

  let navigationRoute = null;
  if (targetType === 'SERVICE') {
    navigationRoute = legacyServiceId ? `service:${legacyServiceId}` : null;
  } else if (targetType === 'CUSTOM_ROUTE' || targetType === 'EXTERNAL_URL') {
    navigationRoute = route || null;
  }

  return {
    targetType,
    serviceId: legacyServiceId,
    customRoute: targetType === 'SERVICE' ? '' : route,
    navigationRoute,
    // The populated snapshot, when the ref resolved to a live service.
    service: item.serviceId && item.serviceId.title
      ? {
          id: String(item.serviceId._id),
          title: item.serviceId.title,
          price: item.serviceId.price,
          category: item.serviceId.category || '',
          imageUrl: toAbsolute(item.serviceId.imageUrl),
          status: item.serviceId.status || 'active',
        }
      : null,
  };
}

// Flattens a card's (possibly populated) `categoryId` into a plain id plus the
// slug the client filters on. Mirrors `normalizeTarget`'s contract: the wire
// always carries a scalar id, never "sometimes an id and sometimes an object",
// with the resolved snapshot on its own key.
function normalizeCategory(item) {
  const raw = item.categoryId;
  if (!raw) return { categoryId: null, categorySlug: null, category: null };
  const id = String(raw._id || raw.id || raw);
  // Unpopulated (a bare ObjectId) or a reference to a deleted category — the
  // id still round-trips so the CMS doesn't drop the tag on the next save.
  if (!raw.slug) return { categoryId: id, categorySlug: null, category: null };
  return {
    categoryId: id,
    categorySlug: raw.slug,
    category: {
      id,
      slug: raw.slug,
      nameEn: raw.nameEn || '',
      nameBn: raw.nameBn || null,
    },
  };
}

// `publicOnly` drops cards an admin has switched off, so the patient feed
// never receives them; the admin console always sees the full array (that is
// what makes a hidden card recoverable rather than deleted).
function decorate(doc, { publicOnly = false } = {}) {
  const obj = doc.toJSON();
  const items = publicOnly
    ? (obj.contentData || []).filter((item) => item.isActive !== false)
    : (obj.contentData || []);
  obj.contentData = items.map((item) => ({
    ...item,
    ...(item.imageUrl ? { imageUrl: toAbsolute(item.imageUrl) } : {}),
    ...normalizeTarget(item),
    ...normalizeCategory(item),
  }));
  return obj;
}

// Rejects a save that links to a service that doesn't exist (deleted between
// the admin opening the editor and hitting save). Throws a client-safe Error;
// callers translate to 400.
async function assertLinkedServicesExist(items) {
  const ids = [
    ...new Set(items.filter((i) => i.targetType === 'SERVICE' && i.serviceId)
      .map((i) => String(i.serviceId))),
  ];
  if (ids.length === 0) return;
  const found = await Service.find({ _id: { $in: ids } }).select('_id').lean();
  if (found.length === ids.length) return;
  const alive = new Set(found.map((s) => String(s._id)));
  const missing = ids.filter((id) => !alive.has(id));
  throw new Error(`Linked service no longer exists: ${missing.join(', ')}`);
}

function parseBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return raw === true || raw === 'true' || raw === '1' || raw === 1;
}

// Trims an optional free-text card field to null when blank, so "cleared in
// the CMS" and "never set" reach the client as the same absent value.
function optionalText(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s || null;
}

// The optional color-override keys, per level.
const SECTION_STYLE_KEYS = ['titleColorLight', 'titleColorDark', 'sectionBackgroundColor'];
const CARD_STYLE_KEYS = [
  'cardBgLight', 'cardBgDark', 'accentColorLight', 'accentColorDark',
  'tagBgColor', 'tagTextColor',
];

// Normalizes a color to "#RRGGBB". Empty/null/undefined => null (unset, so the
// client falls back to its theme token). Accepts #RGB / #RRGGBB, case- and
// hash-insensitive. Throws a client-safe Error on a malformed value; `label`
// names the offending field.
function sanitizeHex(value, label) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const hex = s.startsWith('#') ? s.slice(1) : s;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const [r, g, b] = hex;
    return `#${(r + r + g + g + b + b).toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return `#${hex.toUpperCase()}`;
  }
  throw new Error(`${label} must be a hex color like #RRGGBB`);
}

// Sanitizes a style-token object against a known key set. Returns undefined
// when the object is absent (so the caller leaves the schema default nulls in
// place); throws on a non-object or malformed hex within.
function sanitizeTokens(raw, keys, label) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} must be an object`);
  }
  const out = {};
  for (const key of keys) {
    out[key] = sanitizeHex(raw[key], `${label}.${key}`);
  }
  return out;
}

// Accepts contentData as an array or a JSON string. Validates each item and
// coerces routeArguments values to strings. Throws Error with a client-safe
// message on invalid input (callers translate to 400).
function sanitizeItems(raw) {
  let items = raw;
  if (typeof raw === 'string') {
    try {
      items = JSON.parse(raw);
    } catch (_e) {
      throw new Error('contentData must be an array or JSON array string');
    }
  }
  if (!Array.isArray(items)) {
    throw new Error('contentData must be an array');
  }
  return items.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`contentData[${i}] must be an object`);
    }
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!title) throw new Error(`contentData[${i}].title is required`);
    const imageUrl = typeof item.imageUrl === 'string' ? item.imageUrl.trim() : '';
    if (!imageUrl) throw new Error(`contentData[${i}].imageUrl is required`);

    const routeArguments = {};
    if (item.routeArguments && typeof item.routeArguments === 'object') {
      for (const [k, v] of Object.entries(item.routeArguments)) {
        if (v !== undefined && v !== null) routeArguments[k] = String(v);
      }
    }

    const cardStyles = sanitizeTokens(
      item.cardStyles, CARD_STYLE_KEYS, `contentData[${i}].cardStyles`);
    const target = sanitizeTarget(item, `contentData[${i}]`);
    const categoryId = sanitizeCategoryId(item, `contentData[${i}]`);

    return {
      itemId: item.itemId ? String(item.itemId) : String(i),
      categoryId,
      title,
      subtitle: optionalText(item.subtitle),
      titleBn: optionalText(item.titleBn),
      subtitleBn: optionalText(item.subtitleBn),
      imageUrl,
      priceTag: optionalText(item.priceTag),
      badgeText: optionalText(item.badgeText),
      // Absent on payloads from admin builds predating per-card visibility;
      // those cards must stay visible, so the fallback is `true`.
      isActive: parseBool(item.isActive, true),
      ...target,
      routeArguments,
      ...(cardStyles ? { cardStyles } : {}),
    };
  });
}

// Reads a card's Home-pill tag off the request body. Absent, blank, and null
// all mean "untagged" — the card then only shows under the implicit "All"
// pill. Accepts a populated object as well as a bare id, so an admin can PUT
// back a section exactly as it was read.
//
// Existence is deliberately NOT checked here: the tag is cosmetic (it decides
// which pill a card hides behind), a deleted category already nulls its
// references in routes/categories.js, and a hard failure would block saving an
// unrelated text edit. Compare `assertLinkedServicesExist`, which does reject —
// a dangling *service* link breaks the booking tap, which is not cosmetic.
function sanitizeCategoryId(item, label) {
  const raw = item.categoryId;
  if (raw === undefined || raw === null || raw === '') return null;
  const id = String(raw._id || raw.id || raw).trim();
  if (!id) return null;
  if (!mongoose.isValidObjectId(id)) {
    throw new Error(`${label}.categoryId must be a valid category id`);
  }
  return id;
}

// Resolves one item's tap target from the request body into the four stored
// fields (targetType / serviceId / customRoute / navigationRoute).
//
// Accepts both shapes: the current admin CMS sends the structured fields; an
// older client (or a hand-rolled call) sends only `navigationRoute`, which is
// parsed back into structure so nothing regresses. `navigationRoute` is always
// rewritten from the resolved target, keeping the legacy mirror truthful.
// Throws a client-safe Error on a malformed value; `label` names the item.
function sanitizeTarget(item, label) {
  const legacyRoute = item.navigationRoute ? String(item.navigationRoute).trim() : '';
  const customRoute = item.customRoute !== undefined
    ? String(item.customRoute || '').trim()
    : legacyRoute;

  let targetType = item.targetType;
  if (targetType === undefined || targetType === null || targetType === '') {
    // Legacy payload — infer from the route string.
    if (item.serviceId) targetType = 'SERVICE';
    else if (isHttp(legacyRoute)) targetType = 'EXTERNAL_URL';
    else if (legacyRoute.startsWith('service:')) targetType = 'SERVICE';
    else targetType = legacyRoute ? 'CUSTOM_ROUTE' : 'NONE';
  }
  if (!TARGET_TYPES.includes(targetType)) {
    throw new Error(`${label}.targetType must be one of: ${TARGET_TYPES.join(', ')}`);
  }

  if (targetType === 'SERVICE') {
    const raw = item.serviceId
      ? String(item.serviceId._id || item.serviceId).trim()
      : (legacyRoute.startsWith('service:')
          ? legacyRoute.slice('service:'.length).trim()
          : '');
    if (!raw) throw new Error(`${label}.serviceId is required when targetType is SERVICE`);
    if (!mongoose.isValidObjectId(raw)) {
      throw new Error(`${label}.serviceId must be a valid service id`);
    }
    return {
      targetType,
      serviceId: raw,
      customRoute: '',
      navigationRoute: `service:${raw}`,
    };
  }

  if (targetType === 'EXTERNAL_URL') {
    if (!isHttp(customRoute)) {
      throw new Error(`${label}.customRoute must be an http(s) URL when targetType is EXTERNAL_URL`);
    }
    return { targetType, serviceId: null, customRoute, navigationRoute: customRoute };
  }

  if (targetType === 'CUSTOM_ROUTE') {
    if (!customRoute) {
      throw new Error(`${label}.customRoute is required when targetType is CUSTOM_ROUTE`);
    }
    return { targetType, serviceId: null, customRoute, navigationRoute: customRoute };
  }

  return { targetType: 'NONE', serviceId: null, customRoute: '', navigationRoute: null };
}

const UI_TEMPLATES = DynamicSection.schema.path('uiTemplate').enumValues;

// GET /api/home-sections?active=1  (public — the client home screen reads this)
router.get('/', async (req, res) => {
  try {
    const filter = {};
    const publicOnly =
      req.query.active === '1' || req.query.active === 'true';
    if (publicOnly) {
      filter.isActive = true;
    }
    const docs = await DynamicSection.find(filter)
      .sort({ orderIndex: 1, createdAt: -1 })
      .populate(ITEM_POPULATE);
    res.json(docs.map((d) => decorate(d, { publicOnly })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/home-sections  (admin; JSON body)
router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { sectionKey, titleEn, uiTemplate } = req.body;
    if (!sectionKey || !String(sectionKey).trim()) {
      return res.status(400).json({ message: 'sectionKey is required' });
    }
    if (!titleEn || !String(titleEn).trim()) {
      return res.status(400).json({ message: 'titleEn is required' });
    }
    if (!UI_TEMPLATES.includes(uiTemplate)) {
      return res.status(400).json({ message: `uiTemplate must be one of: ${UI_TEMPLATES.join(', ')}` });
    }
    const layoutType = req.body.layoutType ?? req.body.layout_type;
    if (layoutType !== undefined && !LAYOUT_TYPES.includes(layoutType)) {
      return res.status(400).json({ message: `layoutType must be one of: ${LAYOUT_TYPES.join(', ')}` });
    }

    const key = String(sectionKey).trim();
    const existing = await DynamicSection.findOne({ sectionKey: key }).select('_id');
    if (existing) return res.status(409).json({ message: 'sectionKey already exists' });

    let contentData = [];
    let styleTokens;
    if (req.body.contentData !== undefined) {
      try {
        contentData = sanitizeItems(req.body.contentData);
        await assertLinkedServicesExist(contentData);
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }
    }
    if (req.body.styleTokens !== undefined) {
      try {
        styleTokens = sanitizeTokens(req.body.styleTokens, SECTION_STYLE_KEYS, 'styleTokens');
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }
    }

    // Default the new section to the end of the current order.
    const last = await DynamicSection.findOne().sort({ orderIndex: -1 }).select('orderIndex');
    const nextOrder = last ? last.orderIndex + 1 : 0;

    const doc = await DynamicSection.create({
      sectionKey: key,
      titleEn: String(titleEn).trim(),
      titleBn: req.body.titleBn ? String(req.body.titleBn).trim() : null,
      uiTemplate,
      ...(layoutType !== undefined ? { layoutType } : {}),
      orderIndex: req.body.orderIndex !== undefined ? Number(req.body.orderIndex) : nextOrder,
      isActive: parseBool(req.body.isActive, true),
      contentData,
      ...(styleTokens ? { styleTokens } : {}),
    });

    await doc.populate(ITEM_POPULATE);
    res.status(201).json(decorate(doc));
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ message: 'sectionKey already exists' });
    }
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/home-sections/reorder  { ids: [...] }  (admin)
// Renumbers orderIndex to match the supplied id order (0..n-1).
router.patch('/reorder', requireRole('admin'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'ids must be a non-empty array' });
    }
    const ops = ids.map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { orderIndex: index } } },
    }));
    await DynamicSection.bulkWrite(ops);
    const docs = await DynamicSection.find()
      .sort({ orderIndex: 1, createdAt: -1 })
      .populate(ITEM_POPULATE);
    res.json(docs.map(decorate));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/home-sections/images  (admin; multipart: itemId + image)
// Upload-first flow: the admin dialog uploads each item image before the
// section itself is saved, then references the returned URL in contentData.
router.post('/images', requireRole('admin'), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'image file is required' });
    const itemId = req.body.itemId && String(req.body.itemId).trim();
    if (!itemId) return res.status(400).json({ message: 'itemId is required' });
    if (!SAFE_ITEM_ID.test(itemId)) {
      return res.status(400).json({
        message: 'itemId must be letters, digits, hyphens or underscores',
      });
    }

    const stored = await storeImage(req.file.buffer, itemImageId(itemId));
    res.status(201).json({ imageUrl: toAbsolute(stored) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/home-sections/care-services  { layoutType, titleEn?, titleBn? }
// (admin) — upserts the reserved CARE_SERVICES section.
//
// Care Services is the one block on Home that predates the CMS: it has always
// rendered the live `/api/services` catalog, so on an existing deployment
// there is no document to PATCH a layout onto. Rather than make the admin
// hand-create a section with a magic key before the layout selector works,
// this creates it on first use and updates it thereafter.
//
// Declared above `/:id` — Express matches in order, and "care-services" is not
// an ObjectId, so the reverse would 500 in the id cast instead of landing here.
router.put('/care-services', requireRole('admin'), async (req, res) => {
  try {
    const layoutType = req.body.layoutType ?? req.body.layout_type;
    if (layoutType !== undefined && !LAYOUT_TYPES.includes(layoutType)) {
      return res.status(400).json({ message: `layoutType must be one of: ${LAYOUT_TYPES.join(', ')}` });
    }

    let doc = await DynamicSection.findOne({ sectionKey: CARE_SERVICES_KEY });
    if (!doc) {
      doc = new DynamicSection({
        sectionKey: CARE_SERVICES_KEY,
        titleEn: 'Care services',
        titleBn: 'সেবা',
        // Care Services renders through the app's own layout engine, not the
        // generic template switch, but the field is `required` — so it is set
        // to the template whose cards the engine actually draws.
        uiTemplate: 'HORIZONTAL_PRODUCT_CARD',
        // Care Services sits above every admin-created section on Home, and
        // the patient renderer skips this document in the generic list, so the
        // index only matters for the CMS's own ordering.
        orderIndex: -1,
        isActive: true,
      });
    }
    if (layoutType !== undefined) doc.layoutType = layoutType;
    if (req.body.titleEn !== undefined) {
      const t = optionalText(req.body.titleEn);
      if (!t) return res.status(400).json({ message: 'titleEn cannot be empty' });
      doc.titleEn = t;
    }
    if (req.body.titleBn !== undefined) doc.titleBn = optionalText(req.body.titleBn);
    if (req.body.isActive !== undefined) {
      doc.isActive = parseBool(req.body.isActive, doc.isActive);
    }

    await doc.save();
    await doc.populate(ITEM_POPULATE);
    res.json(decorate(doc));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/home-sections/:id/layout  { layoutType }  (admin)
// The layout selector's write path for a section that already exists. Kept
// separate from the whole-section PUT so switching a layout can't clobber
// `contentData` from a stale editor — same reasoning as `/:id/status`.
router.patch('/:id/layout', requireRole('admin'), async (req, res) => {
  try {
    const layoutType = req.body.layoutType ?? req.body.layout_type;
    if (layoutType === undefined) {
      return res.status(400).json({ message: 'layoutType is required' });
    }
    if (!LAYOUT_TYPES.includes(layoutType)) {
      return res.status(400).json({ message: `layoutType must be one of: ${LAYOUT_TYPES.join(', ')}` });
    }
    const doc = await DynamicSection.findByIdAndUpdate(
      req.params.id,
      { layoutType },
      { new: true }
    ).populate(ITEM_POPULATE);
    if (!doc) return res.status(404).json({ message: 'Section not found' });
    res.json(decorate(doc));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/home-sections/:id  (admin; JSON body, partial update;
// contentData present ⇒ whole-array replace)
router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const doc = await DynamicSection.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Section not found' });

    const { titleEn, titleBn, uiTemplate } = req.body;
    if (titleEn !== undefined) {
      if (!String(titleEn).trim()) return res.status(400).json({ message: 'titleEn cannot be empty' });
      doc.titleEn = String(titleEn).trim();
    }
    if (titleBn !== undefined) {
      doc.titleBn = titleBn ? String(titleBn).trim() : null;
    }
    if (uiTemplate !== undefined) {
      if (!UI_TEMPLATES.includes(uiTemplate)) {
        return res.status(400).json({ message: `uiTemplate must be one of: ${UI_TEMPLATES.join(', ')}` });
      }
      doc.uiTemplate = uiTemplate;
    }
    const layoutType = req.body.layoutType ?? req.body.layout_type;
    if (layoutType !== undefined) {
      if (!LAYOUT_TYPES.includes(layoutType)) {
        return res.status(400).json({ message: `layoutType must be one of: ${LAYOUT_TYPES.join(', ')}` });
      }
      doc.layoutType = layoutType;
    }
    if (req.body.orderIndex !== undefined) doc.orderIndex = Number(req.body.orderIndex);
    if (req.body.isActive !== undefined) doc.isActive = parseBool(req.body.isActive, doc.isActive);
    if (req.body.styleTokens !== undefined) {
      try {
        doc.styleTokens = sanitizeTokens(req.body.styleTokens, SECTION_STYLE_KEYS, 'styleTokens');
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }
    }
    if (req.body.contentData !== undefined) {
      try {
        const items = sanitizeItems(req.body.contentData);
        await assertLinkedServicesExist(items);
        doc.contentData = items;
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }
    }

    await doc.save();
    await doc.populate(ITEM_POPULATE);
    res.json(decorate(doc));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/home-sections/:id/status  { isActive: boolean }  (admin)
router.patch('/:id/status', requireRole('admin'), async (req, res) => {
  try {
    if (req.body.isActive === undefined) {
      return res.status(400).json({ message: 'isActive is required' });
    }
    const isActive = parseBool(req.body.isActive, true);
    const doc = await DynamicSection.findByIdAndUpdate(
      req.params.id,
      { isActive },
      { new: true }
    ).populate(ITEM_POPULATE);
    if (!doc) return res.status(404).json({ message: 'Section not found' });
    res.json(decorate(doc));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/home-sections/:id/items/:itemId/status  { isActive }  (admin)
// One-tap show/hide for a single card. Exists alongside the whole-section PUT
// so flipping a card's visibility doesn't round-trip (and risk clobbering) the
// entire contentData array from a stale editor.
router.patch('/:id/items/:itemId/status', requireRole('admin'), async (req, res) => {
  try {
    if (req.body.isActive === undefined) {
      return res.status(400).json({ message: 'isActive is required' });
    }
    const doc = await DynamicSection.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Section not found' });

    const item = (doc.contentData || []).find(
      (i) => String(i.itemId) === String(req.params.itemId)
    );
    if (!item) return res.status(404).json({ message: 'Card not found' });

    item.isActive = parseBool(req.body.isActive, true);
    await doc.save();
    await doc.populate(ITEM_POPULATE);
    res.json(decorate(doc));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/home-sections/:id  (admin)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const doc = await DynamicSection.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Section not found' });
    // Best-effort cleanup of uploaded item images. Skips pasted external
    // URLs that never went through our upload pipeline.
    for (const item of doc.contentData || []) {
      const ours = item.imageUrl &&
        (!/^https?:\/\//i.test(item.imageUrl) || item.imageUrl.includes(`/${itemImageId(item.itemId)}`));
      if (ours) await removeImage(itemImageId(item.itemId));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;

// The reserved key, shared with routes/homeData.js so the two agree on which
// section is the Care Services block.
module.exports.CARE_SERVICES_KEY = CARE_SERVICES_KEY;
module.exports.ITEM_POPULATE = ITEM_POPULATE;
module.exports.decorate = decorate;

// Exposed for tests/homeSectionCards.test.js. These two pure transforms decide
// what an admin's payload becomes on disk and what the patient feed is allowed
// to see — the parts worth pinning without standing up a database.
module.exports._sanitizeItems = sanitizeItems;
module.exports._decorate = decorate;
