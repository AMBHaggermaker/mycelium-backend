const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const pool    = require('../db');
const authenticate = require('../middleware/auth');

const router = express.Router();

const uploadDir = path.resolve('uploads/avatars');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype));
  },
});

// GET /api/users/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, username, bio, location, reliability_score, avatar_url, created_at FROM users WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/users/:id
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    if (req.user.id !== req.params.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { bio, location, username } = req.body;
    const result = await pool.query(
      `UPDATE users SET
         bio        = COALESCE($1, bio),
         location   = COALESCE($2, location),
         username   = COALESCE($3, username),
         updated_at = NOW()
       WHERE id = $4
       RETURNING id, username, email, bio, location, reliability_score, avatar_url, created_at`,
      [bio ?? null, location ?? null, username ?? null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    next(err);
  }
});

// POST /api/users/:id/avatar
router.post('/:id/avatar', authenticate, upload.single('avatar'), async (req, res, next) => {
  try {
    if (req.user.id !== req.params.id) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided or unsupported format (jpeg/png/webp/gif only)' });
    }

    // Delete old avatar file if one exists
    const existing = await pool.query('SELECT avatar_url FROM users WHERE id = $1', [req.params.id]);
    const oldUrl = existing.rows[0]?.avatar_url;
    if (oldUrl) {
      const oldPath = path.resolve(oldUrl.replace('/api/', ''));
      fs.unlink(oldPath, () => {});
    }

    const avatarUrl = `/api/uploads/avatars/${req.file.filename}`;
    const result = await pool.query(
      `UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, username, email, bio, location, reliability_score, avatar_url, created_at`,
      [avatarUrl, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    next(err);
  }
});

// GET /api/users/:id/posts
router.get('/:id/posts', async (req, res, next) => {
  try {
    const { type, status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.params.id];
    const conditions = ['p.user_id = $1'];

    if (type) {
      params.push(type);
      conditions.push(`p.type = $${params.length}::post_type`);
    }
    if (status) {
      params.push(status);
      conditions.push(`p.status = $${params.length}::post_status`);
    }

    params.push(parseInt(limit), offset);
    const result = await pool.query(
      `SELECT p.*, u.username, u.reliability_score, c.name AS circle_name,
              (SELECT COALESCE(json_agg(pm ORDER BY pm.created_at), '[]') FROM post_media pm WHERE pm.post_id = p.id) AS media
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN circles c ON c.id = p.circle_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id/circles
router.get('/:id/circles', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.*, cm.role, cm.joined_at,
              COUNT(m.user_id)::int AS member_count
       FROM circles c
       JOIN circle_members cm ON cm.circle_id = c.id AND cm.user_id = $1
       LEFT JOIN circle_members m ON m.circle_id = c.id
       GROUP BY c.id, cm.role, cm.joined_at
       ORDER BY cm.joined_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id/reservations (own only)
router.get('/:id/reservations', authenticate, async (req, res, next) => {
  try {
    if (req.user.id !== req.params.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.params.id];
    let where = 'WHERE r.user_id = $1';

    if (status) {
      params.push(status);
      where += ` AND r.status = $${params.length}::reservation_status`;
    }

    params.push(parseInt(limit), offset);
    const result = await pool.query(
      `SELECT r.*, p.title AS post_title, p.type AS post_type,
              p.location, p.starts_at, p.ends_at, u.username AS post_author
       FROM reservations r
       JOIN posts p ON p.id = r.post_id
       JOIN users u ON u.id = p.user_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
