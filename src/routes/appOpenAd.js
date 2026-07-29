const express = require('express');
const { upload } = require('../middleware/upload');
const { requireRole } = require('../middleware/auth');
const {
  getAppOpenAd,
  updateAppOpenAd,
  deleteAppOpenAd,
} = require('../controllers/appOpenAdController');

const router = express.Router();

router.get('/', getAppOpenAd);

// requireRole stays AHEAD of upload.single so a non-admin request is rejected
// before multer consumes the multipart body.
router.put(
  '/',
  requireRole('admin'),
  upload.single('image'),
  updateAppOpenAd,
);

router.delete('/', requireRole('admin'), deleteAppOpenAd);

module.exports = router;
