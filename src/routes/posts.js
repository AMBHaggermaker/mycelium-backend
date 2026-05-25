const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const pool    = require('../db');
const authenticate = require('../middleware/auth');

const router = express.Router();

const uploadDir = path.resolve('uploads/posts');
fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

const VALID_CATEGORIES = new Set(['jobs_services', 'goods_supplies', 'community']);

const AUTO_URGENT_TAGS = new Set([
  'hunger', 'food crisis', 'shelter', 'homeless', 'crisis',
  'mental health crisis', 'child', 'children', 'medical', 'emergency',
]);

function isAutoUrgent(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some(t => AUTO_URGENT_TAGS.has(t.toLowerCase().trim()));
}

const NSFW_PATTERN = /\b(porn(?:ography)?|xxx|nudes?|naked|onlyfans|escort|prostitut\w*|camgirl|stripper|penis|vagina|fuck\w*|pussy|cocks?|dicks?|tits?|boobs?|nipples?)\b/i;

const mediaStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const uploadMedia = multer({
  storage: mediaStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype)),
});

const MEDIA_SQL = `(SELECT COALESCE(json_agg(pm ORDER BY pm.created_at), '[]') FROM post_media pm WHERE pm.post_id = p.id) AS media`;

const PRIORITY_SCORE_SQL = `
  CASE
    WHEN p.auto_urgent THEN
      2.0 + CASE WHEN p.is_urgent THEN
        CASE WHEN u.reliability_score > 3.0 THEN 1.0 ELSE 0.5 END
      ELSE 0.0 END
    WHEN p.is_urgent THEN
      CASE WHEN u.reliability_score > 3.0 THEN 1.0 ELSE 0.5 END
    ELSE 0.0
  END`;

const SORT_ORDER = {
  recent:           `p.created_at DESC`,
  urgent:           `(${PRIORITY_SCORE_SQL}) DESC, p.created_at DESC`,
  least_responded:  `COALESCE(p.reserved_count, 0) ASC, p.created_at DESC`,
  expiring:         `COALESCE(p.expires_at, p.ends_at) ASC NULLS LAST, p.created_at DESC`,
};

// GET /api/posts
router.get('/', async (req, res, next) => {
  try {
    const { type, circle_id, status, tags, category, subcategory, sort = 'recent', page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = [];

    if (type)       { params.push(type);                                  conditions.push(`p.type = $${params.length}::post_type`); }
    if (circle_id)  { params.push(circle_id);                             conditions.push(`p.circle_id = $${params.length}`); }
    if (status)     { params.push(status);                                conditions.push(`p.status = $${params.length}::post_status`); }
    if (tags)       { params.push(tags.split(',').map(t => t.trim()));    conditions.push(`p.tags && $${params.length}::text[]`); }
    if (category)   { params.push(category);                              conditions.push(`p.category = $${params.length}`); }
    if (subcategory){ params.push(subcategory);                           conditions.push(`p.subcategory ILIKE $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = SORT_ORDER[sort] || SORT_ORDER.recent;
    params.push(parseInt(limit), offset);

    const result = await pool.query(
      `SELECT p.*, u.username, u.reliability_score, c.name AS circle_name,
              ${PRIORITY_SCORE_SQL} AS priority_score,
              ${MEDIA_SQL}
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN circles c ON c.id = p.circle_id
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/posts
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { type, title, description, circle_id, capacity, location, starts_at, ends_at,
            tags, category, subcategory, is_urgent, expires_at } = req.body;
    if (!type || !title) return res.status(400).json({ error: 'type and title are required' });
    if (!['need', 'offer', 'event'].includes(type)) return res.status(400).json({ error: 'type must be need, offer, or event' });
    if (type === 'event' && !starts_at) return res.status(400).json({ error: 'starts_at is required for events' });
    if (category && !VALID_CATEGORIES.has(category)) return res.status(400).json({ error: 'Invalid category' });

    const text = `${title} ${description || ''}`;
    if (NSFW_PATTERN.test(text)) {
      return res.status(422).json({ error: 'This platform does not allow adult content. Please keep posts appropriate for all community members.' });
    }

    if (circle_id) {
      const member = await pool.query(
        'SELECT 1 FROM circle_members WHERE circle_id = $1 AND user_id = $2',
        [circle_id, req.user.id]
      );
      if (!member.rows.length) return res.status(403).json({ error: 'Must be a circle member to post there' });
    }

    const parsedTags = Array.isArray(tags) ? tags : (tags || []);
    const autoUrgent = isAutoUrgent(parsedTags);
    const userUrgent = is_urgent === true || is_urgent === 'true';

    const result = await pool.query(
      `INSERT INTO posts (type, title, description, user_id, circle_id, capacity, location,
                          starts_at, ends_at, tags, category, subcategory, is_urgent, auto_urgent, expires_at)
       VALUES ($1::post_type, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *, '[]'::json AS media`,
      [type, title.trim(), description || null, req.user.id, circle_id || null,
       capacity || null, location || null, starts_at || null, ends_at || null,
       parsedTags, category || null, subcategory?.trim() || null,
       userUrgent, autoUrgent, expires_at || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/posts/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.*, u.username, u.reliability_score, u.bio AS author_bio, c.name AS circle_name, ${MEDIA_SQL}
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN circles c ON c.id = p.circle_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Post not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/posts/:id
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT user_id FROM posts WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Post not found' });
    if (existing.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { title, description, capacity, location, starts_at, ends_at, status,
            tags, category, subcategory, is_urgent, expires_at } = req.body;
    if (category !== undefined && category !== null && !VALID_CATEGORIES.has(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const parsedTags = tags !== undefined ? (Array.isArray(tags) ? tags : tags) : undefined;
    const autoUrgent = parsedTags !== undefined ? isAutoUrgent(parsedTags) : undefined;
    const userUrgent = is_urgent !== undefined ? (is_urgent === true || is_urgent === 'true') : undefined;

    const result = await pool.query(
      `UPDATE posts SET
         title       = COALESCE($1, title),
         description = COALESCE($2, description),
         capacity    = COALESCE($3, capacity),
         location    = COALESCE($4, location),
         starts_at   = COALESCE($5, starts_at),
         ends_at     = COALESCE($6, ends_at),
         status      = COALESCE($7::post_status, status),
         tags        = COALESCE($8::text[], tags),
         category    = COALESCE($9, category),
         subcategory = COALESCE($10, subcategory),
         is_urgent   = COALESCE($11, is_urgent),
         auto_urgent = COALESCE($12, auto_urgent),
         expires_at  = COALESCE($13, expires_at),
         updated_at  = NOW()
       WHERE id = $14
       RETURNING *`,
      [title, description, capacity, location, starts_at, ends_at, status,
       parsedTags !== undefined ? parsedTags : null,
       category || null, subcategory?.trim() || null,
       userUrgent !== undefined ? userUrgent : null,
       autoUrgent !== undefined ? autoUrgent : null,
       expires_at !== undefined ? expires_at : null,
       req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/posts/:id
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT user_id FROM posts WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Post not found' });
    if (result.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/posts/:id/media
router.post('/:id/media', authenticate, uploadMedia.array('media', 5), async (req, res, next) => {
  try {
    const post = await pool.query('SELECT user_id FROM posts WHERE id = $1', [req.params.id]);
    if (!post.rows[0]) {
      req.files?.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(404).json({ error: 'Post not found' });
    }
    if (post.rows[0].user_id !== req.user.id) {
      req.files?.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!req.files?.length) return res.status(400).json({ error: 'No files provided' });

    const inserted = await Promise.all(
      req.files.map(f =>
        pool.query(
          `INSERT INTO post_media (post_id, url, mime_type, original_name, size_bytes)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [req.params.id, `/api/uploads/posts/${f.filename}`, f.mimetype, f.originalname, f.size]
        ).then(r => r.rows[0])
      )
    );
    res.status(201).json(inserted);
  } catch (err) {
    req.files?.forEach(f => fs.unlink(f.path, () => {}));
    next(err);
  }
});

// POST /api/posts/:id/report
router.post('/:id/report', authenticate, async (req, res, next) => {
  try {
    const post = await pool.query('SELECT id, user_id FROM posts WHERE id = $1', [req.params.id]);
    if (!post.rows[0]) return res.status(404).json({ error: 'Post not found' });
    if (post.rows[0].user_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot report your own post' });
    }

    await pool.query(
      `INSERT INTO post_reports (post_id, user_id, reason) VALUES ($1, $2, $3)
       ON CONFLICT (post_id, user_id) DO NOTHING`,
      [req.params.id, req.user.id, req.body.reason || null]
    );
    await pool.query('UPDATE posts SET content_flagged = TRUE WHERE id = $1', [req.params.id]);
    res.json({ reported: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/posts/:id/media/:mediaId
router.delete('/:id/media/:mediaId', authenticate, async (req, res, next) => {
  try {
    const post = await pool.query('SELECT user_id FROM posts WHERE id = $1', [req.params.id]);
    if (!post.rows[0]) return res.status(404).json({ error: 'Post not found' });
    if (post.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const media = await pool.query(
      'DELETE FROM post_media WHERE id = $1 AND post_id = $2 RETURNING *',
      [req.params.mediaId, req.params.id]
    );
    if (!media.rows[0]) return res.status(404).json({ error: 'Media not found' });

    const filePath = path.resolve(media.rows[0].url.replace('/api/', ''));
    fs.unlink(filePath, () => {});
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
