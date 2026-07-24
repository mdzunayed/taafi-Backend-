const express = require('express');
const AppOpenAd = require('../models/AppOpenAd');
const { upload, storeImage, removeImage } = require('../middleware/upload');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:4000';

function decorate(doc) {
  const obj = doc.toJSON();
  if (obj.imageUrl && !/^https?:\/\//i.test(obj.imageUrl)) {
    obj.imageUrl = `${PUBLIC_BASE_URL}/uploads/${obj.imageUrl}`;
  }
  return obj;
}

function parseBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return raw === true || raw === 'true' || raw === '1' || raw === 1;
}

// Keeps a fat-fingered duration from locking patients out of the app for
// minutes (or zero-flashing past the ad entirely).
function clampDuration(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(60, Math.max(1, Math.round(n)));
}

// GET /api/app-open-ad            (public — admin management view)
// GET /api/app-open-ad?active=1   (public — client launch check; 200 + null
//                                  body when no active campaign exists)
router.get('/', async (req, res) => {
  try {
    const doc = await AppOpenAd.findOne().sort({ updatedAt: -1 });
    const activeOnly = req.query.active === '1' || req.query.active === 'true';
    if (!doc || (activeOnly && !doc.isActive)) return res.json(null);
    res.json(decorate(doc));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/app-open-ad  (admin; multipart: optional image + durationInSeconds
// + isActive). Upserts the singleton — the first save must include an image.
router.put('/', requireRole('admin'), upload.single('image'), async (req, res) => {
  try {
    let doc = await AppOpenAd.findOne().sort({ updatedAt: -1 });

    if (!doc) {
      if (!req.file) {
        return res.status(400).json({ message: 'An ad image is required' });
      }
      doc = new AppOpenAd({
        // Placeholder — replaced below once the _id exists for the publicId.
        imageUrl: 'pending',
        durationInSeconds: clampDuration(req.body.durationInSeconds, 5),
        isActive: parseBool(req.body.isActive, false),
      });
    } else {
      if (req.body.durationInSeconds !== undefined) {
        doc.durationInSeconds = clampDuration(
          req.body.durationInSeconds,
          doc.durationInSeconds
        );
      }
      if (req.body.isActive !== undefined) {
        doc.isActive = parseBool(req.body.isActive, doc.isActive);
      }
    }

    if (req.file) {
      doc.imageUrl = await storeImage(req.file.buffer, `app-open-ad-${doc._id}`);
    }

    await doc.save();
    res.json(decorate(doc));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/app-open-ad  (admin) — removes the campaign and its image.
router.delete('/', requireRole('admin'), async (req, res) => {
  try {
    const doc = await AppOpenAd.findOneAndDelete();
    if (!doc) return res.status(404).json({ message: 'No app-open ad exists' });
    await removeImage(`app-open-ad-${doc._id}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
