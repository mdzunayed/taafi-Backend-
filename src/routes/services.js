const express = require('express');
const mongoose = require('mongoose');
const Service = require('../models/Service');
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
const { normalizeServiceCategory } = require('../utils/serviceCategories');
// Provider type is canonicalised at the same boundary — and, for rows the
// admin has never tagged, inferred at read time so the patient tracker always
// has a role to word its steps with.
const {
  normalizeProviderType,
  inferProviderType,
} = require('../utils/providerTypes');

const router = express.Router();

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

function decorate(doc) {
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
    const docs = await Service.find(filter).sort({ createdAt: -1 });

    // Decorate per-document. `inferProviderType` reads free-text title and
    // category, so a single pathological row throwing would have turned the
    // whole catalog into a 500 for every user — drop that row and serve the
    // rest. Logged loudly because a row that never renders is otherwise
    // invisible until someone asks why their service is missing.
    const out = [];
    for (const doc of docs) {
      try {
        out.push(decorate(doc));
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

// POST /api/services  (multipart: fields + image)
router.post('/', requireRole('admin'), invalidateOnSuccess('services'), upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'image is required' });
    const { title, price, description, category, duration, status } = req.body;
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
      // Same coerce-don't-reject rule as `category`: an unrecognised role
      // lands as null (untagged) and `decorate` infers one for readers.
      provider_type: pickProviderType(req.body) ?? null,
      duration: duration && duration.length ? duration : null,
      status: status === 'inactive' ? 'inactive' : 'active',
    });

    res.status(201).json(decorate(doc));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/services/:id  (multipart: fields + optional new image)
router.put('/:id', requireRole('admin'), invalidateOnSuccess('services'), upload.single('image'), async (req, res) => {
  try {
    const doc = await Service.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Service not found' });

    const { title, price, description, category, duration, status } = req.body;

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
    const providerType = pickProviderType(req.body);
    if (providerType !== undefined) doc.provider_type = providerType;
    if (duration !== undefined) doc.duration = duration && duration.length ? duration : null;
    if (status !== undefined) doc.status = status === 'inactive' ? 'inactive' : 'active';

    if (req.file) {
      doc.imageUrl = await storeImage(req.file.buffer, doc._id.toString());
    }

    await doc.save();
    res.json(decorate(doc));
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
    res.json(decorate(doc));
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
