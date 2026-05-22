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

// GET /api/posts
router.get('/', async (req, res, next) => {
  try {
    const { type, circle_id, status, tags, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = [];

    if (type)      { params.push(type);                                 conditions.push(`p.type = $${params.length}::post_type`); }
    if (circle_id) { params.push(circle_id);                            conditions.push(`p.circle_id = $${params.length}`); }
    if (status)    { params.push(status);                               conditions.push(`p.status = $${params.length}::post_status`); }
    if (tags)      { params.push(tags.split(',').map(t => t.trim()));   conditions.push(`p.tags && $${params.length}::text[]`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit), offset);

    const result = await pool.query(
      `SELECT p.*, u.username, u.reliability_score, c.name AS circle_name, ${MEDIA_SQL}
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN circles c ON c.id = p.circle_id
       ${where}
       ORDER BY p.created_at DESC
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
    const { type, title, description, circle_id, capacity, location, starts_at, ends_at, tags } = req.body;
    if (!type || !title) return res.status(400).json({ error: 'type and title are required' });
    if (!['need', 'offer', 'event'].includes(type)) return res.status(400).json({ error: 'type must be need, offer, or event' });
    if (type === 'event' && !starts_at) return res.status(400).json({ error: 'starts_at is required for events' });

    if (circle_id) {
      const member = await pool.query(
        'SELECT 1 FROM circle_members WHERE circle_id = $1 AND user_id = $2',
        [circle_id, req.user.id]
      );
      if (!member.rows.length) return res.status(403).json({ error: 'Must be a circle member to post there' });
    }

    const result = await pool.query(
      `INSERT INTO posts (type, title, description, user_id, circle_id, capacity, location, starts_at, ends_at, tags)
       VALUES ($1::post_type, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *, '[]'::json AS media`,
      [type, title.trim(), description || null, req.user.id, circle_id || null,
       capacity || null, location || null, starts_at || null, ends_at || null, tags || []]
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

    const { title, description, capacity, location, starts_at, ends_at, status, tags } = req.body;
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
         updated_at  = NOW()
       WHERE id = $9
       RETURNING *`,
      [title, description, capacity, location, starts_at, ends_at, status, tags, req.params.id]
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
