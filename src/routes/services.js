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

const router = express.Router();

function decorate(doc) {
  const obj = doc.toJSON();
  obj.imageUrl = toAbsolute(obj.imageUrl);
  return obj;
}

// GET /api/services?active=1  (Redis-cached, 5 min)
router.get('/', cache('services'), async (req, res) => {
  try {
    const filter = {};
    if (req.query.active === '1' || req.query.active === 'true') {
      filter.status = 'active';
    }
    const docs = await Service.find(filter).sort({ createdAt: -1 });
    res.json(docs.map(decorate));
  } catch (err) {
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
      category: category || '',
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
    if (category !== undefined) doc.category = category;
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
