const express = require('express');
const PromoBanner = require('../models/PromoBanner');
const {
  upload,
  storeImage,
  removeImage,
} = require('../middleware/upload');
const { requireRole } = require('../middleware/auth');
// Redis read-cache: public GET cached 5 min; every admin write purges it.
const { cache, invalidateOnSuccess } = require('../services/cacheService');

const router = express.Router();

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:4000';
const imageUrl = (filename) => filename ? `${PUBLIC_BASE_URL}/uploads/${filename}` : null;

function decorate(doc) {
  const obj = doc.toJSON();
  if (obj.imageUrl && !/^https?:\/\//i.test(obj.imageUrl)) {
    obj.imageUrl = imageUrl(obj.imageUrl);
  }
  // The populated target service goes through its own toJSON (id/title/
  // price/category/imageUrl) but not services.js's own `decorate`, so its
  // imageUrl still needs the same bare-filename -> absolute-URL resolution.
  if (obj.targetServiceId && obj.targetServiceId.imageUrl &&
      !/^https?:\/\//i.test(obj.targetServiceId.imageUrl)) {
    obj.targetServiceId.imageUrl = imageUrl(obj.targetServiceId.imageUrl);
  }
  return obj;
}

// Accept gradientColors from multipart (a JSON string) or JSON body (an
// array). Returns undefined when nothing usable was sent so callers can
// fall back to the schema default / the existing value.
function parseGradient(raw) {
  if (Array.isArray(raw)) {
    return raw.map((c) => String(c)).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim().length) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((c) => String(c)).filter(Boolean);
    } catch (_e) {
      // Not JSON — treat a bare comma-separated string as a fallback.
      const parts = raw.split(',').map((c) => c.trim()).filter(Boolean);
      if (parts.length) return parts;
    }
  }
  return undefined;
}

function parseBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return raw === true || raw === 'true' || raw === '1' || raw === 1;
}

const ACTION_TYPES = ['SERVICE', 'CATEGORY', 'EXTERNAL_URL', 'PROMO_CODE', 'NONE'];

// Pulls the actionType/target* fields out of a POST/PUT body and returns only
// the ones actually present, so callers can `Object.assign`/`doc.set` without
// clobbering unrelated fields on partial (PUT) updates. Coerces a blank
// targetServiceId ('' from a cleared dropdown) to null rather than letting
// Mongoose reject it as an invalid ObjectId.
function pickActionFields(body) {
  const out = {};
  if (body.actionType !== undefined) {
    out.actionType = ACTION_TYPES.includes(body.actionType) ? body.actionType : 'NONE';
  }
  if (body.targetServiceId !== undefined) {
    const v = String(body.targetServiceId || '').trim();
    out.targetServiceId = v || null;
  }
  if (body.targetCategoryId !== undefined) {
    const v = String(body.targetCategoryId || '').trim();
    out.targetCategoryId = v || null;
  }
  if (body.targetUrl !== undefined) out.targetUrl = String(body.targetUrl || '').trim();
  if (body.promoCode !== undefined) out.promoCode = String(body.promoCode || '').trim();
  return out;
}

// Populated so the patient app's tap handler has immediate context (title,
// price, category, image) without a second round trip to /api/services.
const TARGET_SERVICE_POPULATE = {
  path: 'targetServiceId',
  select: '_id title price category imageUrl',
};

// GET /api/promo-banners?active=1  (public — the client home slider reads this; Redis-cached 5 min)
router.get('/', cache('banners'), async (req, res) => {
  try {
    const filter = {};
    if (req.query.active === '1' || req.query.active === 'true') {
      filter.isActive = true;
    }
    const docs = await PromoBanner.find(filter)
      .sort({ priorityOrder: 1, createdAt: -1 })
      .populate(TARGET_SERVICE_POPULATE);
    res.json(docs.map(decorate));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/promo-banners  (admin; multipart: fields + optional image)
router.post('/', requireRole('admin'), invalidateOnSuccess('banners'), upload.single('image'), async (req, res) => {
  try {
    const { tagText, title, buttonText } = req.body;
    if (!tagText || !tagText.trim()) return res.status(400).json({ message: 'tagText is required' });
    if (!title || !title.trim()) return res.status(400).json({ message: 'title is required' });
    if (!buttonText || !buttonText.trim()) return res.status(400).json({ message: 'buttonText is required' });

    // Default the new banner to the end of the current order.
    const last = await PromoBanner.findOne().sort({ priorityOrder: -1 }).select('priorityOrder');
    const nextOrder = last ? last.priorityOrder + 1 : 0;

    const gradientColors = parseGradient(req.body.gradientColors);

    const doc = await PromoBanner.create({
      tagText: tagText.trim(),
      title: title.trim(),
      buttonText: buttonText.trim(),
      ...(gradientColors ? { gradientColors } : {}),
      priorityOrder: req.body.priorityOrder !== undefined ? Number(req.body.priorityOrder) : nextOrder,
      isActive: parseBool(req.body.isActive, true),
      ...pickActionFields(req.body),
    });

    if (req.file) {
      doc.imageUrl = await storeImage(req.file.buffer, doc._id.toString());
      await doc.save();
    }

    await doc.populate(TARGET_SERVICE_POPULATE);
    res.status(201).json(decorate(doc));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/promo-banners/reorder  { ids: [...] }  (admin)
// Renumbers priorityOrder to match the supplied id order (0..n-1).
router.patch('/reorder', requireRole('admin'), invalidateOnSuccess('banners'), async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'ids must be a non-empty array' });
    }
    const ops = ids.map((id, index) => ({
      updateOne: { filter: { _id: id }, update: { $set: { priorityOrder: index } } },
    }));
    await PromoBanner.bulkWrite(ops);
    const docs = await PromoBanner.find()
      .sort({ priorityOrder: 1, createdAt: -1 })
      .populate(TARGET_SERVICE_POPULATE);
    res.json(docs.map(decorate));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/promo-banners/:id  (admin; multipart: fields + optional new image)
router.put('/:id', requireRole('admin'), invalidateOnSuccess('banners'), upload.single('image'), async (req, res) => {
  try {
    const doc = await PromoBanner.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Banner not found' });

    const { tagText, title, buttonText } = req.body;
    if (tagText !== undefined) {
      if (!tagText.trim()) return res.status(400).json({ message: 'tagText cannot be empty' });
      doc.tagText = tagText.trim();
    }
    if (title !== undefined) {
      if (!title.trim()) return res.status(400).json({ message: 'title cannot be empty' });
      doc.title = title.trim();
    }
    if (buttonText !== undefined) {
      if (!buttonText.trim()) return res.status(400).json({ message: 'buttonText cannot be empty' });
      doc.buttonText = buttonText.trim();
    }
    const gradientColors = parseGradient(req.body.gradientColors);
    if (gradientColors) doc.gradientColors = gradientColors;
    if (req.body.priorityOrder !== undefined) doc.priorityOrder = Number(req.body.priorityOrder);
    if (req.body.isActive !== undefined) doc.isActive = parseBool(req.body.isActive, doc.isActive);
    Object.assign(doc, pickActionFields(req.body));

    if (req.file) {
      doc.imageUrl = await storeImage(req.file.buffer, doc._id.toString());
    }

    await doc.save();
    await doc.populate(TARGET_SERVICE_POPULATE);
    res.json(decorate(doc));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/promo-banners/:id/status  { isActive: boolean }  (admin)
router.patch('/:id/status', requireRole('admin'), invalidateOnSuccess('banners'), async (req, res) => {
  try {
    if (req.body.isActive === undefined) {
      return res.status(400).json({ message: 'isActive is required' });
    }
    const isActive = parseBool(req.body.isActive, true);
    const doc = await PromoBanner.findByIdAndUpdate(
      req.params.id,
      { isActive },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: 'Banner not found' });
    res.json(decorate(doc));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/promo-banners/:id  (admin)
router.delete('/:id', requireRole('admin'), invalidateOnSuccess('banners'), async (req, res) => {
  try {
    const doc = await PromoBanner.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Banner not found' });
    await removeImage(doc._id.toString());
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
