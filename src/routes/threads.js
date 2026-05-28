const express = require('express');
const pool = require('../db');
const authenticate = require('../middleware/auth');

const router = express.Router();

// GET /api/threads?circle_id=&post_id=&wall_post_id=&page=&limit=
router.get('/', async (req, res, next) => {
  try {
    const { circle_id, post_id, wall_post_id, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = [];

    if (circle_id) {
      params.push(circle_id);
      conditions.push(`t.circle_id = $${params.length}`);
    }
    if (post_id) {
      params.push(post_id);
      conditions.push(`t.post_id = $${params.length}`);
    }
    if (wall_post_id) {
      params.push(wall_post_id);
      conditions.push(`t.wall_post_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit), offset);

    const result = await pool.query(
      `SELECT t.*, u.username AS creator_username,
              COUNT(tm.id)::int AS message_count,
              MAX(tm.created_at) AS last_message_at
       FROM threads t
       JOIN users u ON u.id = t.created_by
       LEFT JOIN thread_messages tm ON tm.thread_id = t.id
       ${where}
       GROUP BY t.id, u.username
       ORDER BY last_message_at DESC NULLS LAST, t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/threads
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { title, post_id, circle_id, wall_post_id } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!post_id && !circle_id && !wall_post_id) {
      return res.status(400).json({ error: 'post_id, circle_id, or wall_post_id is required' });
    }

    if (circle_id) {
      const member = await pool.query(
        'SELECT 1 FROM circle_members WHERE circle_id = $1 AND user_id = $2',
        [circle_id, req.user.id]
      );
      if (!member.rows.length) {
        return res.status(403).json({ error: 'Must be a circle member to start a thread there' });
      }
    }

    const result = await pool.query(
      `INSERT INTO threads (title, post_id, circle_id, wall_post_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title.trim(), post_id || null, circle_id || null, wall_post_id || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/threads/:id (includes messages)
router.get('/:id', async (req, res, next) => {
  try {
    const threadResult = await pool.query(
      `SELECT t.*, u.username AS creator_username
       FROM threads t
       JOIN users u ON u.id = t.created_by
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!threadResult.rows[0]) return res.status(404).json({ error: 'Thread not found' });

    const messagesResult = await pool.query(
      `SELECT tm.*, u.username, u.reliability_score
       FROM thread_messages tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.thread_id = $1
       ORDER BY tm.created_at ASC`,
      [req.params.id]
    );

    res.json({ ...threadResult.rows[0], messages: messagesResult.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/threads/:id/messages
router.post('/:id/messages', authenticate, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required' });

    const thread = await pool.query('SELECT id FROM threads WHERE id = $1', [req.params.id]);
    if (!thread.rows[0]) return res.status(404).json({ error: 'Thread not found' });

    const result = await pool.query(
      `INSERT INTO thread_messages (thread_id, user_id, content)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, req.user.id, content.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/threads/:id/messages/:messageId
router.patch('/:id/messages/:messageId', authenticate, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required' });

    const result = await pool.query(
      `UPDATE thread_messages SET content = $1, updated_at = NOW()
       WHERE id = $2 AND thread_id = $3 AND user_id = $4
       RETURNING *`,
      [content.trim(), req.params.messageId, req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Message not found or not yours' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/threads/:id/messages/:messageId
router.delete('/:id/messages/:messageId', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM thread_messages WHERE id = $1 AND thread_id = $2 AND user_id = $3 RETURNING id`,
      [req.params.messageId, req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Message not found or not yours' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
