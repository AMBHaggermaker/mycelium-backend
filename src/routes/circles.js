const express = require('express');
const pool = require('../db');
const authenticate = require('../middleware/auth');

const router = express.Router();

// GET /api/circles?search=&page=&limit=
router.get('/', async (req, res, next) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let where = 'WHERE c.is_private = FALSE';

    if (search) {
      params.push(`%${search}%`);
      const idx = params.length;
      where += ` AND (c.name ILIKE $${idx} OR c.description ILIKE $${idx})`;
    }

    params.push(parseInt(limit), offset);
    const result = await pool.query(
      `SELECT c.*, u.username AS creator_username,
              COUNT(cm.user_id)::int AS member_count
       FROM circles c
       LEFT JOIN users u ON u.id = c.created_by
       LEFT JOIN circle_members cm ON cm.circle_id = c.id
       ${where}
       GROUP BY c.id, u.username
       ORDER BY member_count DESC, c.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/circles
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { name, description, is_private } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const circleResult = await client.query(
        `INSERT INTO circles (name, description, created_by, is_private)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [name.trim(), description || null, req.user.id, is_private || false]
      );
      const circle = circleResult.rows[0];
      await client.query(
        `INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [circle.id, req.user.id]
      );
      await client.query('COMMIT');
      res.status(201).json(circle);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Circle name already taken' });
    next(err);
  }
});

// GET /api/circles/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.username AS creator_username,
              COUNT(cm.user_id)::int AS member_count
       FROM circles c
       LEFT JOIN users u ON u.id = c.created_by
       LEFT JOIN circle_members cm ON cm.circle_id = c.id
       WHERE c.id = $1
       GROUP BY c.id, u.username`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Circle not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/circles/:id (admin only)
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const membership = await pool.query(
      'SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!membership.rows[0] || membership.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Circle admin access required' });
    }
    const { name, description, is_private } = req.body;
    const result = await pool.query(
      `UPDATE circles SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         is_private  = COALESCE($3, is_private),
         updated_at  = NOW()
       WHERE id = $4 RETURNING *`,
      [name, description, is_private, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Circle name already taken' });
    next(err);
  }
});

// POST /api/circles/:id/join
router.post('/:id/join', authenticate, async (req, res, next) => {
  try {
    const circle = await pool.query('SELECT id, is_private FROM circles WHERE id = $1', [req.params.id]);
    if (!circle.rows[0]) return res.status(404).json({ error: 'Circle not found' });
    if (circle.rows[0].is_private) {
      return res.status(403).json({ error: 'This circle is private' });
    }
    await pool.query(
      `INSERT INTO circle_members (circle_id, user_id, role)
       VALUES ($1, $2, 'member') ON CONFLICT (circle_id, user_id) DO NOTHING`,
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Joined circle successfully' });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/circles/:id/leave
router.delete('/:id/leave', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM circle_members WHERE circle_id = $1 AND user_id = $2 RETURNING role`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'You are not a member of this circle' });
    res.json({ message: 'Left circle successfully' });
  } catch (err) {
    next(err);
  }
});

// GET /api/circles/:id/members
router.get('/:id/members', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.bio, u.reliability_score, cm.role, cm.joined_at
       FROM circle_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.circle_id = $1
       ORDER BY cm.role = 'admin' DESC, cm.joined_at ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/circles/:id/members/:userId (admin: change role)
router.patch('/:id/members/:userId', authenticate, async (req, res, next) => {
  try {
    const membership = await pool.query(
      'SELECT role FROM circle_members WHERE circle_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!membership.rows[0] || membership.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Circle admin access required' });
    }
    const { role } = req.body;
    if (!['admin', 'member'].includes(role)) {
      return res.status(400).json({ error: 'role must be admin or member' });
    }
    const result = await pool.query(
      `UPDATE circle_members SET role = $1 WHERE circle_id = $2 AND user_id = $3 RETURNING *`,
      [role, req.params.id, req.params.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Member not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/circles/:id/posts
router.get('/:id/posts', async (req, res, next) => {
  try {
    const { type, status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.params.id];
    const conditions = ['p.circle_id = $1'];

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
      `SELECT p.*, u.username, u.reliability_score,
              (SELECT COALESCE(json_agg(pm ORDER BY pm.created_at), '[]') FROM post_media pm WHERE pm.post_id = p.id) AS media
       FROM posts p
       JOIN users u ON u.id = p.user_id
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

// GET /api/circles/:id/threads
router.get('/:id/threads', async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const result = await pool.query(
      `SELECT t.*, u.username AS creator_username,
              COUNT(tm.id)::int AS message_count,
              MAX(tm.created_at) AS last_message_at
       FROM threads t
       JOIN users u ON u.id = t.created_by
       LEFT JOIN thread_messages tm ON tm.thread_id = t.id
       WHERE t.circle_id = $1
       GROUP BY t.id, u.username
       ORDER BY last_message_at DESC NULLS LAST, t.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, parseInt(limit), offset]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
