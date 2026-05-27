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

// ── Community-submitted land records ─────────────────────────────────────────

const VALID_RECORD_TYPES = new Set([
  'property_transfer', 'annexation_filing', 'zoning_change', 'planning_decision',
]);

// GET /api/watch/land-intelligence/records  (public)
router.get('/land-intelligence/records', async (req, res, next) => {
  try {
    const { type, limit = 50 } = req.query;
    const params = [Math.min(parseInt(limit) || 50, 100)];
    const where  = type && VALID_RECORD_TYPES.has(type)
      ? `WHERE lr.record_type = $${params.push(type) && params.length}`
      : '';
    const result = await pool.query(
      `SELECT lr.*, u.username AS submitted_by_username
       FROM land_records lr
       JOIN users u ON u.id = lr.submitted_by
       ${where}
       ORDER BY lr.created_at DESC
       LIMIT $1`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/watch/land-intelligence/records  (auth)
router.post('/land-intelligence/records', authenticate, async (req, res, next) => {
  try {
    const {
      record_type, location_label, record_date, source_url, notes,
      // property_transfer
      address, buyer, seller, sale_price,
      // annexation_filing
      area_affected, petitioner,
      // zoning_change
      from_zone, to_zone, requesting_party,
      // planning_decision
      project_name, decision,
    } = req.body;

    if (!record_type || !VALID_RECORD_TYPES.has(record_type))
      return res.status(400).json({ error: 'record_type must be property_transfer, annexation_filing, zoning_change, or planning_decision' });

    // Type-specific required fields
    if (record_type === 'property_transfer' && !address?.trim())
      return res.status(400).json({ error: 'address is required for property_transfer' });
    if (record_type === 'annexation_filing' && !area_affected?.trim())
      return res.status(400).json({ error: 'area_affected is required for annexation_filing' });
    if (record_type === 'zoning_change' && (!from_zone?.trim() || !to_zone?.trim()))
      return res.status(400).json({ error: 'from_zone and to_zone are required for zoning_change' });
    if (record_type === 'planning_decision' && !project_name?.trim())
      return res.status(400).json({ error: 'project_name is required for planning_decision' });

    const result = await pool.query(
      `INSERT INTO land_records
         (record_type, submitted_by, location_label, record_date, source_url, notes,
          address, buyer, seller, sale_price,
          area_affected, petitioner,
          from_zone, to_zone, requesting_party,
          project_name, decision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        record_type, req.user.id,
        location_label || null, record_date || null, source_url || null, notes || null,
        address?.trim() || null, buyer?.trim() || null, seller?.trim() || null,
        sale_price ? parseFloat(sale_price) : null,
        area_affected?.trim() || null, petitioner?.trim() || null,
        from_zone?.trim() || null, to_zone?.trim() || null, requesting_party?.trim() || null,
        project_name?.trim() || null, decision?.trim() || null,
      ]
    );
    res.status(201).json({ ...result.rows[0], submitted_by_username: req.user.username });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/watch/land-intelligence/records/:id/verify  (admin)
router.patch('/land-intelligence/records/:id/verify', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE land_records SET verified = NOT verified WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Record not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/watch/land-intelligence/records/:id  (admin)
router.delete('/land-intelligence/records/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM land_records WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Record not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Public Records Request (PRR) tracker ─────────────────────────────────────

const VALID_PRR_STATUSES = new Set(['pending','acknowledged','partial','fulfilled','denied','appealing']);

// GET /api/watch/land-intelligence/prr  (public)
router.get('/land-intelligence/prr', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT rr.*, u.username AS submitted_by_username
       FROM records_requests rr
       JOIN users u ON u.id = rr.submitted_by
       ORDER BY rr.created_at DESC
       LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/watch/land-intelligence/prr  (admin)
router.post('/land-intelligence/prr', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const { agency, records_sought, submitted_date, status, response_due, notes } = req.body;
    if (!agency?.trim())        return res.status(400).json({ error: 'agency is required' });
    if (!records_sought?.trim()) return res.status(400).json({ error: 'records_sought is required' });
    const resolvedStatus = VALID_PRR_STATUSES.has(status) ? status : 'pending';
    const result = await pool.query(
      `INSERT INTO records_requests
         (submitted_by, agency, records_sought, submitted_date, status, response_due, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        req.user.id, agency.trim(), records_sought.trim(),
        submitted_date || null, resolvedStatus,
        response_due || null, notes || null,
      ]
    );
    res.status(201).json({ ...result.rows[0], submitted_by_username: req.user.username });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/watch/land-intelligence/prr/:id  (admin)
router.patch('/land-intelligence/prr/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const { agency, records_sought, submitted_date, status, response_due, notes } = req.body;
    if (status && !VALID_PRR_STATUSES.has(status))
      return res.status(400).json({ error: 'Invalid status' });
    const result = await pool.query(
      `UPDATE records_requests SET
         agency          = COALESCE($1, agency),
         records_sought  = COALESCE($2, records_sought),
         submitted_date  = COALESCE($3::date, submitted_date),
         status          = COALESCE($4, status),
         response_due    = COALESCE($5::date, response_due),
         notes           = COALESCE($6, notes),
         updated_at      = NOW()
       WHERE id = $7 RETURNING *`,
      [
        agency?.trim() || null, records_sought?.trim() || null,
        submitted_date || null, status || null, response_due || null,
        notes || null, req.params.id,
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Request not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/watch/land-intelligence/prr/:id  (admin)
router.delete('/land-intelligence/prr/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM records_requests WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Request not found' });
    res.status(204).end();
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
