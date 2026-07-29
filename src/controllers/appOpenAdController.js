const AppOpenAd = require('../models/AppOpenAd');
const { storeImage, removeImage } = require('../middleware/upload');
const { toAbsolute } = require('../utils/publicUrl');

// Full-screen interstitial shown once when the patient app launches, managed
// as a singleton campaign: every handler resolves "the" ad with the same
// newest-first query so read, upsert and delete can never disagree about which
// document they mean.
const newestFirst = () => AppOpenAd.findOne().sort({ updatedAt: -1 });

function decorate(doc) {
  const obj = doc.toJSON();
  obj.imageUrl = toAbsolute(obj.imageUrl);
  return obj;
}

function parseBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return raw === true || raw === 'true' || raw === '1' || raw === 1;
}

// Keeps a fat-fingered duration from locking patients out of the app for
// minutes (or zero-flashing past the ad entirely). A non-numeric value falls
// back rather than rejecting — multipart carries everything as strings, and an
// unparseable duration is not worth failing an otherwise valid save over.
function clampDuration(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(60, Math.max(1, Math.round(n)));
}

// The Flutter admin panel sends camelCase (app_open_ad_repository.dart), but
// accept the snake_case spellings too so a client written against either
// convention works. Reads are unaffected — responses stay camelCase, which is
// what AppOpenAd.fromJson expects.
function readDuration(body) {
  return body.durationInSeconds !== undefined
    ? body.durationInSeconds
    : body.countdown_seconds;
}

function readActive(body) {
  return body.isActive !== undefined ? body.isActive : body.is_active;
}

// GET /api/app-open-ad            (public — admin management view)
// GET /api/app-open-ad?active=1   (public — client launch check; 200 + null
//                                  body when no active campaign exists)
async function getAppOpenAd(req, res, next) {
  try {
    const doc = await newestFirst();
    const activeOnly = req.query.active === '1' || req.query.active === 'true';
    if (!doc || (activeOnly && !doc.isActive)) return res.json(null);
    res.json(decorate(doc));
  } catch (err) {
    console.error('[AppOpenAd] read failed:', err);
    next(err);
  }
}

// PUT /api/app-open-ad  (admin; multipart: optional image + durationInSeconds
// + isActive). Upserts the singleton — the first save must include an image.
//
// The image is optional on purpose: the panel's common edit is toggling
// isActive or nudging the duration, and re-uploading the artwork to change a
// boolean would be both wasteful and a way to lose the current image to a
// failed upload. `req.file` being undefined is therefore the normal path, not
// an error — only a first-ever create needs the file.
async function updateAppOpenAd(req, res, next) {
  try {
    const body = req.body || {};
    let doc = await newestFirst();

    if (!doc) {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'An ad image is required when creating the campaign',
        });
      }
      doc = new AppOpenAd({
        // Placeholder — replaced below once the _id exists for the publicId.
        // Only ever persisted if the upload succeeds, since the save follows.
        imageUrl: 'pending',
        durationInSeconds: clampDuration(readDuration(body), 5),
        isActive: parseBool(readActive(body), false),
      });
    } else {
      const duration = readDuration(body);
      if (duration !== undefined) {
        doc.durationInSeconds = clampDuration(duration, doc.durationInSeconds);
      }
      const active = readActive(body);
      if (active !== undefined) {
        doc.isActive = parseBool(active, doc.isActive);
      }
    }

    if (req.file) {
      doc.imageUrl = await storeImage(
        req.file.buffer,
        `app-open-ad-${doc._id}`,
      );
    }

    await doc.save();
    // Bare document, not an envelope: AppOpenAd.fromJson reads these fields at
    // the top level.
    res.json(decorate(doc));
  } catch (err) {
    console.error('[AppOpenAd] update failed:', err);
    next(err);
  }
}

// DELETE /api/app-open-ad  (admin) — removes the campaign and its image.
async function deleteAppOpenAd(req, res, next) {
  try {
    // Resolve through the same newest-first query the other handlers use, then
    // delete by _id. A bare findOneAndDelete() takes natural order, so if a
    // second row ever existed it would delete a different document than the
    // one GET and PUT operate on.
    const doc = await newestFirst();
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: 'No app-open ad exists' });
    }
    await AppOpenAd.deleteOne({ _id: doc._id });
    await removeImage(`app-open-ad-${doc._id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[AppOpenAd] delete failed:', err);
    next(err);
  }
}

module.exports = {
  getAppOpenAd,
  updateAppOpenAd,
  deleteAppOpenAd,
};
