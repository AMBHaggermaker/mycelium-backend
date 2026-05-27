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
  'atmospheric_observations',
]);
const VALID_SEVERITIES = new Set(['critical','serious','moderate','minor','monitoring']);
const LAB_DASHBOARDS   = new Set(['environment', 'food']);

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
    const imgTypes = new Set(['image/jpeg','image/png','image/webp','image/gif']);
    const pdfOk    = file.fieldname === 'lab_report' && file.mimetype === 'application/pdf';
    cb(null, imgTypes.has(file.mimetype) || pdfOk);
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

// ── Atmospheric observations ──────────────────────────────────────────────────

const atmosUploadDir = path.resolve('uploads/atmospheric');
const soilUploadDir  = path.resolve('uploads/soil-samples');
fs.mkdirSync(atmosUploadDir, { recursive: true });
fs.mkdirSync(soilUploadDir,  { recursive: true });

const atmosStorage = multer.diskStorage({
  destination: atmosUploadDir,
  filename: (req, file, cb) => { const ext = path.extname(file.originalname).toLowerCase(); cb(null, `${crypto.randomUUID()}${ext}`); },
});
const atmosUpload = multer({
  storage: atmosStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => { cb(null, new Set(['image/jpeg','image/png','image/webp','image/gif']).has(file.mimetype)); },
});

const soilStorage = multer.diskStorage({
  destination: soilUploadDir,
  filename: (req, file, cb) => { const ext = path.extname(file.originalname).toLowerCase(); cb(null, `${crypto.randomUUID()}${ext}`); },
});
const soilUpload = multer({
  storage: soilStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => { cb(null, new Set(['image/jpeg','image/png','image/webp','image/gif','application/pdf']).has(file.mimetype)); },
});

const VALID_ATMOS_TYPES  = new Set(['persistent_contrail','grid_pattern','low_altitude_trail','no_corresponding_flight','unusual_spray_pattern','other']);
const VALID_ATMOS_ALT    = new Set(['low','medium','high']);
const VALID_ATMOS_COND   = new Set(['clear','partly_cloudy','overcast','humid']);
const VALID_ATMOS_TRACK  = new Set(['matched_known_flight','no_match_found','partial_match','did_not_check']);
const VALID_FOIA_STATUS  = new Set(['pending','acknowledged','partial','fulfilled','denied','appealing']);

// GET /api/watch/atmospheric/observations  (public)
router.get('/atmospheric/observations', async (req, res, next) => {
  try {
    const { classification, report_type, limit = 50 } = req.query;
    const conds = []; const params = []; let i = 1;
    if (classification) { conds.push(`ao.classification = $${i++}`); params.push(classification); }
    if (report_type)    { conds.push(`ao.report_type = $${i++}`);    params.push(report_type); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT ao.*, u.username FROM atmospheric_observations ao
       JOIN users u ON u.id = ao.user_id
       ${where} ORDER BY ao.created_at DESC LIMIT $${i}`,
      [...params, Math.min(parseInt(limit) || 50, 100)]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/watch/atmospheric/observations  (auth)
router.post('/atmospheric/observations', authenticate, atmosUpload.array('photos', 5), async (req, res, next) => {
  try {
    const {
      title, description, location_label, location_lat, location_lng, severity, report_type,
      observation_duration_min, estimated_altitude, wind_direction, wind_speed_estimate,
      weather_conditions, checked_flight_tracker, flight_tracking_result, source_url,
    } = req.body;
    if (!title?.trim()) { req.files?.forEach(f => fs.unlink(f.path, ()=>{})); return res.status(400).json({ error: 'title is required' }); }
    if (!severity || !VALID_SEVERITIES.has(severity)) { req.files?.forEach(f => fs.unlink(f.path, ()=>{})); return res.status(400).json({ error: 'severity is required' }); }
    if (!report_type || !VALID_ATMOS_TYPES.has(report_type)) { req.files?.forEach(f => fs.unlink(f.path, ()=>{})); return res.status(400).json({ error: 'report_type is invalid' }); }

    const photoUrls = (req.files || []).map(f => `/api/uploads/atmospheric/${f.filename}`);
    const result = await pool.query(
      `INSERT INTO atmospheric_observations
         (user_id, title, description, location_label, location_lat, location_lng,
          severity, report_type, observation_duration_min, estimated_altitude,
          wind_direction, wind_speed_estimate, weather_conditions,
          checked_flight_tracker, flight_tracking_result, photo_urls, source_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [
        req.user.id, title.trim(), description || null,
        location_label || null,
        location_lat ? parseFloat(location_lat) : null,
        location_lng ? parseFloat(location_lng) : null,
        severity, report_type,
        observation_duration_min ? parseInt(observation_duration_min) : null,
        VALID_ATMOS_ALT.has(estimated_altitude)  ? estimated_altitude  : null,
        wind_direction  || null,
        wind_speed_estimate || null,
        VALID_ATMOS_COND.has(weather_conditions) ? weather_conditions : null,
        checked_flight_tracker === 'true' || checked_flight_tracker === true,
        VALID_ATMOS_TRACK.has(flight_tracking_result) ? flight_tracking_result : null,
        photoUrls, source_url || null,
      ]
    );
    const row = { ...result.rows[0], username: req.user.username };
    res.status(201).json(row);

    // Classify async — don't block response
    const { classifyObservation } = require('../lib/atmosphericIntelligence');
    classifyObservation(row.id).catch(e => console.error('[atmos-intel] classify error:', e.message));
  } catch (err) {
    req.files?.forEach(f => fs.unlink(f.path, ()=>{}));
    next(err);
  }
});

// DELETE /api/watch/atmospheric/observations/:id  (admin)
router.delete('/atmospheric/observations/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM atmospheric_observations WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// GET /api/watch/atmospheric/permits  (public)
router.get('/atmospheric/permits', async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM weather_modification_permits ORDER BY created_at DESC LIMIT 50`);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/watch/atmospheric/permits  (admin)
router.post('/atmospheric/permits', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const { operator, permit_type, area_description, active_from, active_to, compounds_used, source_url, notes } = req.body;
    if (!operator?.trim())          return res.status(400).json({ error: 'operator is required' });
    if (!permit_type?.trim())       return res.status(400).json({ error: 'permit_type is required' });
    if (!area_description?.trim())  return res.status(400).json({ error: 'area_description is required' });
    const result = await pool.query(
      `INSERT INTO weather_modification_permits (operator,permit_type,area_description,active_from,active_to,compounds_used,source_url,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [operator.trim(), permit_type.trim(), area_description.trim(), active_from||null, active_to||null, compounds_used||null, source_url||null, notes||null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/watch/atmospheric/permits/:id  (admin)
router.patch('/atmospheric/permits/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const { operator, permit_type, area_description, active_from, active_to, compounds_used, source_url, notes } = req.body;
    const result = await pool.query(
      `UPDATE weather_modification_permits SET
         operator=COALESCE($1,operator), permit_type=COALESCE($2,permit_type),
         area_description=COALESCE($3,area_description),
         active_from=COALESCE($4::date,active_from), active_to=COALESCE($5::date,active_to),
         compounds_used=COALESCE($6,compounds_used), source_url=COALESCE($7,source_url),
         notes=COALESCE($8,notes), updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [operator?.trim()||null, permit_type?.trim()||null, area_description?.trim()||null,
       active_from||null, active_to||null, compounds_used||null, source_url||null, notes||null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/watch/atmospheric/permits/:id  (admin)
router.delete('/atmospheric/permits/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM weather_modification_permits WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// GET /api/watch/atmospheric/soil-samples  (public)
router.get('/atmospheric/soil-samples', async (req, res, next) => {
  try {
    const { limit = 50 } = req.query;
    const result = await pool.query(
      `SELECT ss.*, u.username FROM soil_samples ss
       JOIN users u ON u.id = ss.user_id
       ORDER BY ss.created_at DESC LIMIT $1`,
      [Math.min(parseInt(limit)||50, 100)]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/watch/atmospheric/soil-samples  (auth)
router.post('/atmospheric/soil-samples', authenticate, soilUpload.single('lab_photo'), async (req, res, next) => {
  try {
    const {
      sample_type, collection_date, location_lat, location_lng, location_label,
      distance_from_obs_miles, direction_from_obs, linked_observation_id,
      lab_name, lab_cert_number,
      aluminum_ppb, barium_ppb, strontium_ppb, silver_ppb, tio2_ppb, pfas_ppb,
    } = req.body;
    const VALID_TYPES = new Set(['soil_surface','soil_deep','rainwater']);
    if (!sample_type || !VALID_TYPES.has(sample_type))
      return res.status(400).json({ error: 'sample_type must be soil_surface, soil_deep, or rainwater' });

    const photoUrl = req.file ? `/api/uploads/soil-samples/${req.file.filename}` : null;
    const num = v => v ? parseFloat(v) : null;

    // Fetch EPA TRI sources asynchronously; use null if unavailable
    let triSources = null;
    if (location_lat && location_lng) {
      const { fetchTRINearby } = require('../lib/atmosphericIntelligence');
      triSources = await (async () => {
        try { return await fetchTRINearby(parseFloat(location_lat), parseFloat(location_lng)); } catch { return null; }
      })();
    }

    const result = await pool.query(
      `INSERT INTO soil_samples
         (user_id, sample_type, collection_date, location_lat, location_lng, location_label,
          distance_from_obs_miles, direction_from_obs, linked_observation_id,
          lab_name, lab_cert_number,
          aluminum_ppb, barium_ppb, strontium_ppb, silver_ppb, tio2_ppb, pfas_ppb,
          photo_url, tri_sources)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [
        req.user.id, sample_type, collection_date||null,
        location_lat ? parseFloat(location_lat) : null,
        location_lng ? parseFloat(location_lng) : null,
        location_label||null,
        distance_from_obs_miles ? parseFloat(distance_from_obs_miles) : null,
        direction_from_obs||null,
        linked_observation_id||null,
        lab_name||null, lab_cert_number||null,
        num(aluminum_ppb), num(barium_ppb), num(strontium_ppb),
        num(silver_ppb), num(tio2_ppb), num(pfas_ppb),
        photoUrl,
        triSources ? JSON.stringify(triSources) : null,
      ]
    );
    const row = { ...result.rows[0], username: req.user.username };
    res.status(201).json(row);

    // Trigger AI compound analysis if elevated readings
    const s = result.rows[0];
    const hasElevated = (s.aluminum_ppb > 50) || (s.barium_ppb > 2) || (s.strontium_ppb > 5) || (s.pfas_ppb > 0.1);
    if (hasElevated) {
      const { analyzeCompoundOrigin } = require('../lib/atmosphericIntelligence');
      analyzeCompoundOrigin(s.id).catch(e => console.error('[atmos-intel] compound analysis error:', e.message));
    }
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, ()=>{});
    next(err);
  }
});

// POST /api/watch/atmospheric/soil-samples/:id/analyze  (admin — re-trigger AI)
router.post('/atmospheric/soil-samples/:id/analyze', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const { analyzeCompoundOrigin } = require('../lib/atmosphericIntelligence');
    analyzeCompoundOrigin(req.params.id).catch(e => console.error('[atmos-intel] reanalyze error:', e.message));
    res.json({ status: 'triggered' });
  } catch (err) { next(err); }
});

// DELETE /api/watch/atmospheric/soil-samples/:id  (admin)
router.delete('/atmospheric/soil-samples/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM soil_samples WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// GET /api/watch/atmospheric/foia  (public)
router.get('/atmospheric/foia', async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT * FROM atmospheric_foia ORDER BY created_at ASC`);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// PATCH /api/watch/atmospheric/foia/:id  (admin)
router.patch('/atmospheric/foia/:id', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const { status, submitted_date, response_due, notes } = req.body;
    if (status && !VALID_FOIA_STATUS.has(status)) return res.status(400).json({ error: 'Invalid status' });
    const result = await pool.query(
      `UPDATE atmospheric_foia SET
         status=COALESCE($1,status),
         submitted_date=COALESCE($2::date,submitted_date),
         response_due=COALESCE($3::date,response_due),
         notes=COALESCE($4,notes),
         updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [status||null, submitted_date||null, response_due||null, notes||null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/watch/:dashboard/reports
router.get('/:dashboard/reports', async (req, res, next) => {
  try {
    const { dashboard } = req.params;
    if (!VALID_DASHBOARDS.has(dashboard)) return res.status(404).json({ error: 'Unknown dashboard' });

    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const result = await pool.query(
      `SELECT wr.*, u.username,
              (SELECT row_to_json(s) FROM soil_test_results s WHERE s.watch_report_id = wr.id LIMIT 1) AS soil_test
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
router.post('/:dashboard/reports',
  authenticate,
  upload.fields([{ name: 'photos', maxCount: 5 }, { name: 'lab_report', maxCount: 1 }]),
  async (req, res, next) => {
  const allFiles = () => {
    const p = req.files?.photos || [];
    const l = req.files?.lab_report || [];
    return [...p, ...l];
  };
  try {
    const { dashboard } = req.params;
    if (!VALID_DASHBOARDS.has(dashboard)) {
      allFiles().forEach(f => fs.unlink(f.path, () => {}));
      return res.status(404).json({ error: 'Unknown dashboard' });
    }

    const { title, description, location_label, location_lat, location_lng,
            source_url, severity, report_type,
            lab_sample_type, lab_collection_date, lab_name, lab_compounds, lab_results } = req.body;

    if (!title?.trim()) {
      allFiles().forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'title is required' });
    }
    if (!severity || !VALID_SEVERITIES.has(severity)) {
      allFiles().forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'severity is required (critical, serious, moderate, minor, or monitoring)' });
    }

    const photoUrls = (req.files?.photos || []).map(f => `/api/uploads/watch/${f.filename}`);

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
    let soilTest = null;

    // Insert lab/soil test results if provided for food or environment dashboards
    if (LAB_DASHBOARDS.has(dashboard) && lab_sample_type) {
      const labReportFile = req.files?.lab_report?.[0];
      const labReportUrl  = labReportFile ? `/api/uploads/watch/${labReportFile.filename}` : null;
      let compounds = [];
      try { compounds = JSON.parse(lab_compounds || '[]'); } catch { compounds = []; }
      let resultsObj = {};
      try { resultsObj = JSON.parse(lab_results || '{}'); } catch { resultsObj = {}; }

      const stResult = await pool.query(
        `INSERT INTO soil_test_results
           (watch_report_id, sample_type, collection_date, lab_name, compounds_tested, results, lab_report_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          row.id, lab_sample_type,
          lab_collection_date || null,
          lab_name || null,
          compounds,
          JSON.stringify(resultsObj),
          labReportUrl,
        ]
      );
      soilTest = stResult.rows[0];
    }

    const response = { ...row, username: req.user.username, soil_test: soilTest };

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
    allFiles().forEach(f => fs.unlink(f.path, () => {}));
    next(err);
  }
});

module.exports = router;
