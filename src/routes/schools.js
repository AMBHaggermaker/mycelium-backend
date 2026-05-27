const express   = require('express');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const pool      = require('../db');
const authenticate  = require('../middleware/auth');
const requireRole   = require('../middleware/requireRole');

const router = express.Router();

const schoolMediaDir = path.resolve('uploads/school-media');
fs.mkdirSync(schoolMediaDir, { recursive: true });

const schoolUpload = multer({
  storage: multer.diskStorage({
    destination: schoolMediaDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype));
  },
});

// ── School Pages ──────────────────────────────────────────────────────────────

// GET /api/schools
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT sp.*, u.username AS rep_username
       FROM school_pages sp
       LEFT JOIN users u ON u.id = sp.school_rep_user_id
       ORDER BY sp.name ASC`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/schools  (admin only)
router.post('/', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const { name, school_type, address, principal_name, website, phone, school_rep_user_id } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const VALID_TYPES = ['public','private','charter'];
    if (school_type && !VALID_TYPES.includes(school_type)) {
      return res.status(400).json({ error: 'Invalid school_type' });
    }

    const result = await pool.query(
      `INSERT INTO school_pages (name, school_type, address, principal_name, website, phone, school_rep_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        name.trim(), school_type || 'public', address || null,
        principal_name || null, website || null, phone || null,
        school_rep_user_id || null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/schools/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT sp.*, u.username AS rep_username, u.id AS rep_user_id
       FROM school_pages sp
       LEFT JOIN users u ON u.id = sp.school_rep_user_id
       WHERE sp.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'School not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/schools/:id  (admin or that school's rep)
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const school = await pool.query('SELECT * FROM school_pages WHERE id = $1', [req.params.id]);
    if (!school.rows[0]) return res.status(404).json({ error: 'School not found' });

    const isAdmin = req.user.role === 'admin';
    const isRep   = school.rows[0].school_rep_user_id === req.user.id;
    if (!isAdmin && !isRep) return res.status(403).json({ error: 'Forbidden' });

    const { name, school_type, address, principal_name, website, phone, school_rep_user_id } = req.body;

    // school_rep can't reassign the school_rep
    const newRep = isAdmin ? (school_rep_user_id ?? null) : undefined;

    const result = await pool.query(
      `UPDATE school_pages SET
         name              = COALESCE($1, name),
         school_type       = COALESCE($2, school_type),
         address           = COALESCE($3, address),
         principal_name    = COALESCE($4, principal_name),
         website           = COALESCE($5, website),
         phone             = COALESCE($6, phone),
         school_rep_user_id = CASE WHEN $7::boolean THEN $8::uuid ELSE school_rep_user_id END,
         updated_at        = NOW()
       WHERE id = $9 RETURNING *`,
      [
        name ?? null, school_type ?? null, address ?? null,
        principal_name ?? null, website ?? null, phone ?? null,
        newRep !== undefined, newRep, req.params.id,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── School Posts ──────────────────────────────────────────────────────────────

// GET /api/schools/:id/posts
router.get('/:id/posts', async (req, res, next) => {
  try {
    const { type, limit = 40, offset = 0 } = req.query;
    const params = [req.params.id];
    let typeFilter = '';
    if (type) {
      params.push(type);
      typeFilter = `AND sp.post_type = $${params.length}`;
    }
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(
      `SELECT sp.*, u.username AS author_username
       FROM school_posts sp
       JOIN users u ON u.id = sp.author_id
       WHERE sp.school_id = $1
         AND (sp.expires_at IS NULL OR sp.expires_at > NOW())
         ${typeFilter}
       ORDER BY sp.is_urgent DESC, sp.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/schools/:id/posts
router.post('/:id/posts', authenticate, schoolUpload.array('photos', 4), async (req, res, next) => {
  try {
    const school = await pool.query('SELECT * FROM school_pages WHERE id = $1', [req.params.id]);
    if (!school.rows[0]) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(404).json({ error: 'School not found' });
    }

    const isAdmin = req.user.role === 'admin';
    const isRep   = school.rows[0].school_rep_user_id === req.user.id;
    if (!isAdmin && !isRep) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(403).json({ error: 'Only the school representative or admins can post here' });
    }

    const { post_type, title, content, count_only, expires_in_days } = req.body;
    if (!post_type || !title) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'post_type and title are required' });
    }

    const VALID_TYPES = ['announcement','lost_found','volunteer_need','lunch_balance','supply_drive','event'];
    if (!VALID_TYPES.includes(post_type)) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'Invalid post_type' });
    }

    const photoUrls = (req.files || []).map(f => `/api/uploads/school-media/${f.filename}`);

    // Lost & found default 30 days; lunch_balance is urgent automatically
    let expiresAt = null;
    if (post_type === 'lost_found') {
      const d = new Date();
      d.setDate(d.getDate() + (parseInt(expires_in_days) || 30));
      expiresAt = d.toISOString();
    } else if (expires_in_days) {
      const d = new Date();
      d.setDate(d.getDate() + parseInt(expires_in_days));
      expiresAt = d.toISOString();
    }

    const isUrgent = post_type === 'lunch_balance';

    const result = await pool.query(
      `INSERT INTO school_posts
         (school_id, author_id, post_type, title, content, photo_urls, count_only, expires_at, is_urgent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        req.params.id, req.user.id, post_type, title.trim(),
        content || null, photoUrls, count_only ? parseInt(count_only) : null,
        expiresAt, isUrgent,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
    next(err);
  }
});

// DELETE /api/schools/:id/posts/:postId
router.delete('/:id/posts/:postId', authenticate, async (req, res, next) => {
  try {
    const post = await pool.query(
      `SELECT sp.*, sc.school_rep_user_id
       FROM school_posts sp
       JOIN school_pages sc ON sc.id = sp.school_id
       WHERE sp.id = $1 AND sp.school_id = $2`,
      [req.params.postId, req.params.id]
    );
    if (!post.rows[0]) return res.status(404).json({ error: 'Post not found' });

    const isAdmin = req.user.role === 'admin';
    const isRep   = post.rows[0].school_rep_user_id === req.user.id;
    if (!isAdmin && !isRep) return res.status(403).json({ error: 'Forbidden' });

    await pool.query('DELETE FROM school_posts WHERE id = $1', [req.params.postId]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── All lost & found school posts (for cross-school filter) ───────────────────

// GET /api/schools/lost-found/all
router.get('/lost-found/all', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT sp.*, sc.name AS school_name, u.username AS author_username
       FROM school_posts sp
       JOIN school_pages sc ON sc.id = sp.school_id
       JOIN users u ON u.id = sp.author_id
       WHERE sp.post_type = 'lost_found'
         AND (sp.expires_at IS NULL OR sp.expires_at > NOW())
       ORDER BY sp.created_at DESC LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

module.exports = router;
