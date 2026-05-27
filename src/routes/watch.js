const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const pool    = require('../db');
const authenticate       = require('../middleware/auth');
const requireRole        = require('../middleware/requireRole');
const { criticalReportAlert } = require('../lib/email');

const router = express.Router();

const VALID_DASHBOARDS = new Set([
  'infrastructure', 'environment', 'housing', 'health',
  'watershed', 'food', 'surveillance', 'civic', 'land_development',
]);
const VALID_SEVERITIES = new Set(['critical','serious','moderate','minor','monitoring']);

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

// GET /api/watch/land-intelligence/reports  (public)
router.get('/land-intelligence/reports', async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const result = await pool.query(
      `SELECT * FROM land_development_reports
       ORDER BY created_at DESC
       LIMIT $1`,
      [Math.min(parseInt(limit) || 20, 50)]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/watch/land-intelligence/trigger  (admin)
router.post('/land-intelligence/trigger', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const { runLandIntelligence } = require('../lib/landIntelligence');
    runLandIntelligence().catch(e => console.error('[land-intel] manual trigger error:', e.message));
    res.json({ status: 'triggered' });
  } catch (err) {
    next(err);
  }
});

// GET /api/watch/anomalies  (public)
router.get('/anomalies', async (req, res, next) => {
  try {
    const { severity, reviewed, limit = 50 } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;

    if (severity) { conditions.push(`severity = $${i++}`); params.push(severity); }
    if (reviewed !== undefined) { conditions.push(`reviewed = $${i++}`); params.push(reviewed === 'true'); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT * FROM watch_anomalies ${where}
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 1 WHEN 'serious' THEN 2
           WHEN 'moderate' THEN 3 WHEN 'minor' THEN 4 ELSE 5
         END,
         created_at DESC
       LIMIT $${i}`,
      [...params, parseInt(limit)]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
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

    const { title, description, location_label, location_lat, location_lng, source_url, severity, report_type } = req.body;
    if (!title?.trim()) {
      req.files?.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'title is required' });
    }
    if (!severity || !VALID_SEVERITIES.has(severity)) {
      req.files?.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'severity is required (critical, serious, moderate, minor, or monitoring)' });
    }

    const photoUrls = (req.files || []).map(f => `/api/uploads/watch/${f.filename}`);

    const result = await pool.query(
      `INSERT INTO watch_reports
         (user_id, dashboard_type, title, description, location_label,
          location_lat, location_lng, photo_urls, source_url, severity, report_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        req.user.id, dashboard, title.trim(),
        description || null, location_label || null,
        location_lat ? parseFloat(location_lat) : null,
        location_lng ? parseFloat(location_lng) : null,
        photoUrls, source_url || null,
        severity, report_type || null,
      ]
    );

    const row = result.rows[0];
    const response = { ...row, username: req.user.username };

    // Email admin for critical reports
    if (severity === 'critical') {
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        criticalReportAlert({ report: row, username: req.user.username, adminEmail }).catch(e => {
          console.error('[watch] critical alert email failed:', e.message);
        });
      }
    }

    res.status(201).json(response);
  } catch (err) {
    req.files?.forEach(f => fs.unlink(f.path, () => {}));
    next(err);
  }
});

module.exports = router;
