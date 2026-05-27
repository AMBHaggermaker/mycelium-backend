const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const pool     = require('../db');
const authenticate  = require('../middleware/auth');
const requireRole   = require('../middleware/requireRole');

const router = express.Router();

const evidenceDir = path.resolve('uploads/advocate-evidence');
fs.mkdirSync(evidenceDir, { recursive: true });

const evidenceUpload = multer({
  storage: multer.diskStorage({
    destination: evidenceDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.bin';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp','image/gif','application/pdf',
                 'video/mp4','video/quicktime'].includes(file.mimetype);
    cb(null, ok);
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const CASE_RESOURCES = {
  medical_kidnapping: [
    { name: 'HSLDA — Home School Legal Defense Association', url: 'https://hslda.org', note: 'Legal defense for families' },
    { name: 'ParentalRights.org', url: 'https://parentalrights.org', note: 'Parental rights advocacy and legal resources' },
    { name: 'Alabama Legal Services', url: 'https://alsp.org', note: 'Free civil legal aid in Alabama' },
    { name: 'National Parents Organization', url: 'https://nationalparentsorganization.org', note: 'Family law advocacy' },
  ],
  cps_overreach: [
    { name: 'ParentalRights.org', url: 'https://parentalrights.org', note: 'CPS defense resources and legal guidance' },
    { name: 'Family Defense Center', url: 'https://familydefensecenter.net', note: 'Wrongful family separation defense' },
    { name: 'Alabama Legal Services', url: 'https://alsp.org', note: 'Free civil legal aid in Alabama' },
    { name: 'HSLDA', url: 'https://hslda.org', note: 'Guidance for educational rights in CPS cases' },
  ],
  elder_abuse: [
    { name: 'Alabama Adult Protective Services', url: 'https://dhr.alabama.gov/services/adult-protective-services/', note: '(334) 242-1310 — report elder abuse' },
    { name: 'Alabama Elder Abuse Hotline', url: 'tel:18002434940', note: '1-800-243-4940' },
    { name: 'National Center on Elder Abuse', url: 'https://ncea.acl.gov', note: 'Resources and reporting guidance' },
    { name: 'Alabama Legal Services', url: 'https://alsp.org', note: 'Free legal aid for seniors' },
  ],
  psychiatric_hold_abuse: [
    { name: 'Alabama Disabilities Advocacy Program', url: 'https://adap.ua.edu', note: 'Rights protection for Alabamans with disabilities' },
    { name: 'Bazelon Center for Mental Health Law', url: 'https://bazelon.org', note: 'Mental health legal rights' },
    { name: 'National Alliance on Mental Illness (NAMI)', url: 'https://nami.org', note: 'Crisis navigation and legal resources' },
    { name: 'Alabama Legal Services', url: 'https://alsp.org', note: 'Free civil legal aid' },
  ],
  parental_rights_violation: [
    { name: 'ParentalRights.org', url: 'https://parentalrights.org', note: 'Parental rights advocacy' },
    { name: 'HSLDA', url: 'https://hslda.org', note: 'Legal defense for families' },
    { name: 'Family Defense Center', url: 'https://familydefensecenter.net', note: 'Wrongful separation defense' },
    { name: 'Alabama Legal Services', url: 'https://alsp.org', note: 'Free civil legal aid in Alabama' },
  ],
  court_ordered_treatment: [
    { name: 'Alabama Disabilities Advocacy Program', url: 'https://adap.ua.edu', note: 'Rights protection and legal advocacy' },
    { name: 'Bazelon Center for Mental Health Law', url: 'https://bazelon.org', note: 'Mental health law resources' },
    { name: 'American Civil Liberties Union — Alabama', url: 'https://aclualabama.org', note: 'Civil liberties advocacy' },
    { name: 'Alabama Legal Services', url: 'https://alsp.org', note: 'Free civil legal aid' },
  ],
  other: [
    { name: 'Alabama Legal Services', url: 'https://alsp.org', note: 'Free civil legal aid in Alabama' },
    { name: 'Alabama State Bar Lawyer Referral Service', url: 'https://alabar.org', note: '(800) 392-5660' },
    { name: 'American Civil Liberties Union — Alabama', url: 'https://aclualabama.org', note: 'Civil liberties advocacy' },
  ],
};

// ── My cases ──────────────────────────────────────────────────────────────────

// GET /api/advocate/cases
router.get('/cases', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, case_type, institution_name, institution_type, location_label,
              incident_date, summary, status, is_public, family_consent_to_share,
              array_length(evidence_urls,1) AS evidence_count,
              jsonb_array_length(timeline) AS timeline_entries,
              created_at
       FROM advocate_cases WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/advocate/cases
router.post('/cases', authenticate, async (req, res, next) => {
  try {
    const {
      case_type, institution_name, institution_type,
      location_label, incident_date, summary, status,
    } = req.body;

    if (!case_type || !institution_name || !institution_type || !summary) {
      return res.status(400).json({ error: 'case_type, institution_name, institution_type, and summary are required' });
    }

    const VALID_TYPES = ['medical_kidnapping','cps_overreach','elder_abuse',
      'psychiatric_hold_abuse','parental_rights_violation','court_ordered_treatment','other'];
    const VALID_INST  = ['hospital','cps_agency','care_facility','court','other'];
    const VALID_STATUS = ['documenting','legal_action','resolved','withdrawn'];

    if (!VALID_TYPES.includes(case_type))  return res.status(400).json({ error: 'Invalid case_type' });
    if (!VALID_INST.includes(institution_type)) return res.status(400).json({ error: 'Invalid institution_type' });
    if (status && !VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const result = await pool.query(
      `INSERT INTO advocate_cases
         (user_id, case_type, institution_name, institution_type,
          location_label, incident_date, summary, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        req.user.id, case_type, institution_name.trim(), institution_type,
        location_label || null, incident_date || null, summary.trim(),
        status || 'documenting',
      ]
    );

    const newCase = result.rows[0];
    const resources = CASE_RESOURCES[case_type] || CASE_RESOURCES.other;
    res.status(201).json({ case: newCase, resources });
  } catch (err) { next(err); }
});

// GET /api/advocate/cases/:id
router.get('/cases/:id', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM advocate_cases WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Case not found' });
    const c = result.rows[0];
    if (c.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const resources = CASE_RESOURCES[c.case_type] || CASE_RESOURCES.other;
    res.json({ case: c, resources });
  } catch (err) { next(err); }
});

// PATCH /api/advocate/cases/:id
router.patch('/cases/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT * FROM advocate_cases WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Case not found' });
    const c = existing.rows[0];
    if (c.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { summary, location_label, incident_date, status,
            is_public, family_consent_to_share } = req.body;

    const VALID_STATUS = ['documenting','legal_action','resolved','withdrawn'];
    if (status && !VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const result = await pool.query(
      `UPDATE advocate_cases SET
         summary                = COALESCE($1, summary),
         location_label         = COALESCE($2, location_label),
         incident_date          = COALESCE($3, incident_date),
         status                 = COALESCE($4, status),
         is_public              = COALESCE($5, is_public),
         family_consent_to_share = COALESCE($6, family_consent_to_share)
       WHERE id = $7 RETURNING *`,
      [
        summary ?? null, location_label ?? null, incident_date ?? null,
        status ?? null,
        is_public !== undefined ? is_public : null,
        family_consent_to_share !== undefined ? family_consent_to_share : null,
        req.params.id,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/advocate/cases/:id
router.delete('/cases/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT * FROM advocate_cases WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Case not found' });
    if (existing.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await pool.query('DELETE FROM advocate_cases WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// POST /api/advocate/cases/:id/evidence  (upload file)
router.post('/cases/:id/evidence', authenticate, evidenceUpload.single('file'), async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT * FROM advocate_cases WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Case not found' });
    }
    if (existing.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const fileUrl = `/api/uploads/advocate-evidence/${req.file.filename}`;
    const result = await pool.query(
      `UPDATE advocate_cases SET evidence_urls = array_append(evidence_urls, $1)
       WHERE id = $2 RETURNING evidence_urls`,
      [fileUrl, req.params.id]
    );
    res.json({ url: fileUrl, evidence_urls: result.rows[0].evidence_urls });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    next(err);
  }
});

// PATCH /api/advocate/cases/:id/timeline  (add timeline entry)
router.patch('/cases/:id/timeline', authenticate, async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT * FROM advocate_cases WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Case not found' });
    if (existing.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { date, description } = req.body;
    if (!description) return res.status(400).json({ error: 'description is required' });

    const entry = { date: date || new Date().toISOString().slice(0,10), description, added_at: new Date().toISOString() };
    const result = await pool.query(
      `UPDATE advocate_cases
       SET timeline = timeline || $1::jsonb
       WHERE id = $2 RETURNING timeline`,
      [JSON.stringify([entry]), req.params.id]
    );
    res.json({ timeline: result.rows[0].timeline });
  } catch (err) { next(err); }
});

// ── Pattern reports (public, anonymized) ─────────────────────────────────────

// GET /api/advocate/patterns
router.get('/patterns', async (req, res, next) => {
  try {
    const { institution_type, limit = 20, offset = 0 } = req.query;
    const params = [];
    let where = '';
    if (institution_type) {
      params.push(institution_type);
      where = `WHERE institution_type = $${params.length}`;
    }
    params.push(parseInt(limit), parseInt(offset));

    const reports = await pool.query(
      `SELECT apr.*,
              (SELECT json_agg(ir ORDER BY ir.created_at DESC)
               FROM institution_responses ir
               WHERE ir.pattern_report_id = apr.id) AS responses
       FROM advocate_pattern_reports apr
       ${where}
       ORDER BY apr.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(reports.rows);
  } catch (err) { next(err); }
});

// GET /api/advocate/patterns/:id
router.get('/patterns/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT apr.*,
              (SELECT json_agg(ir ORDER BY ir.created_at DESC)
               FROM institution_responses ir
               WHERE ir.pattern_report_id = apr.id) AS responses
       FROM advocate_pattern_reports apr WHERE apr.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Report not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/advocate/patterns/:id/response  (institution submits public response)
router.post('/patterns/:id/response', async (req, res, next) => {
  try {
    const report = await pool.query(
      'SELECT id FROM advocate_pattern_reports WHERE id = $1',
      [req.params.id]
    );
    if (!report.rows[0]) return res.status(404).json({ error: 'Report not found' });

    const { institution_name, response_text, submitted_by, contact_email } = req.body;
    if (!institution_name || !response_text) {
      return res.status(400).json({ error: 'institution_name and response_text are required' });
    }
    if (response_text.length < 50) {
      return res.status(400).json({ error: 'Response must be at least 50 characters' });
    }

    const result = await pool.query(
      `INSERT INTO institution_responses
         (pattern_report_id, institution_name, response_text, submitted_by, contact_email)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, institution_name.trim(), response_text.trim(),
       submitted_by || null, contact_email || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── Resources lookup ──────────────────────────────────────────────────────────

// GET /api/advocate/resources/:case_type
router.get('/resources/:case_type', (req, res) => {
  const resources = CASE_RESOURCES[req.params.case_type];
  if (!resources) return res.status(404).json({ error: 'Unknown case type' });
  res.json(resources);
});

// ── Moral injury reports (First Responders section) ───────────────────────────

// POST /api/advocate/moral-injury
router.post('/moral-injury', authenticate, async (req, res, next) => {
  try {
    const { fr_role, institution_name, institution_type, description, is_anonymous } = req.body;
    if (!fr_role || !description) {
      return res.status(400).json({ error: 'fr_role and description are required' });
    }
    const VALID_ROLES = ['law_enforcement','fire','ems','healthcare','other'];
    if (!VALID_ROLES.includes(fr_role)) return res.status(400).json({ error: 'Invalid fr_role' });

    const result = await pool.query(
      `INSERT INTO moral_injury_reports
         (user_id, fr_role, institution_name, institution_type, description, is_anonymous)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, fr_role, institution_name, institution_type, is_anonymous, created_at`,
      [
        req.user.id, fr_role, institution_name || null, institution_type || null,
        description.trim(), is_anonymous !== false,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/advocate/moral-injury  (own reports)
router.get('/moral-injury', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, fr_role, institution_name, institution_type, is_anonymous, created_at
       FROM moral_injury_reports WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

// GET /api/advocate/admin/cases  (all cases)
router.get('/admin/cases', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ac.*, u.username, u.founding_member, u.verified
       FROM advocate_cases ac
       JOIN users u ON u.id = ac.user_id
       ORDER BY ac.created_at DESC LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

module.exports = router;
