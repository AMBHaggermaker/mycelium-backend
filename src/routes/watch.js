const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pool = require('../db');
const authenticate = require('../middleware/auth');

const router = express.Router();

const VALID_DASHBOARDS = new Set([
  'infrastructure', 'environment', 'housing', 'health',
  'watershed', 'food', 'surveillance', 'civic',
]);

const uploadDir = path.resolve('uploads/watch');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = new Set(['image/jpeg','image/png','image/webp','image/gif']);
    cb(null, ok.has(file.mimetype));
  },
});

// GET /api/watch/:dashboard/reports
router.get('/:dashboard/reports', async (req, res, next) => {
  try {
    const { dashboard } = req.params;
    if (!VALID_DASHBOARDS.has(dashboard)) return res.status(404).json({ error: 'Unknown dashboard' });

    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await pool.query(
      `SELECT wr.*, u.username
       FROM watch_reports wr
       JOIN users u ON u.id = wr.user_id
       WHERE wr.dashboard_type = $1
       ORDER BY wr.created_at DESC
       LIMIT $2 OFFSET $3`,
      [dashboard, parseInt(limit), offset]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/watch/:dashboard/reports
router.post('/:dashboard/reports', authenticate, upload.array('photos', 5), async (req, res, next) => {
  try {
    const { dashboard } = req.params;
    if (!VALID_DASHBOARDS.has(dashboard)) {
      req.files?.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(404).json({ error: 'Unknown dashboard' });
    }

    const { title, description, location_label, location_lat, location_lng, source_url } = req.body;
    if (!title?.trim()) {
      req.files?.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'title is required' });
    }

    const photoUrls = (req.files || []).map(f => `/api/uploads/watch/${f.filename}`);

    const result = await pool.query(
      `INSERT INTO watch_reports
         (user_id, dashboard_type, title, description, location_label,
          location_lat, location_lng, photo_urls, source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        req.user.id, dashboard, title.trim(),
        description || null, location_label || null,
        location_lat ? parseFloat(location_lat) : null,
        location_lng ? parseFloat(location_lng) : null,
        photoUrls, source_url || null,
      ]
    );

    const row = result.rows[0];
    res.status(201).json({ ...row, username: req.user.username });
  } catch (err) {
    req.files?.forEach(f => fs.unlink(f.path, () => {}));
    next(err);
  }
});

module.exports = router;
