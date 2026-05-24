const express = require('express');
const pool = require('../db');
const authenticate = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

const router = express.Router();

// All admin routes require authentication
router.use(authenticate);

// ── Moderation queue (moderator+) ────────────────────────────────────────────

// GET /api/admin/moderation
router.get('/moderation', requireRole('moderator', 'admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.title, p.description, p.type, p.status, p.created_at,
              u.username AS author, u.id AS author_id,
              (SELECT COUNT(*)::int FROM post_reports WHERE post_id = p.id) AS report_count,
              (SELECT u2.username FROM post_reports pr2
               JOIN users u2 ON u2.id = pr2.user_id
               WHERE pr2.post_id = p.id ORDER BY pr2.created_at ASC LIMIT 1) AS first_reporter
       FROM posts p
       JOIN users u ON u.id = p.user_id
       WHERE p.content_flagged = TRUE
       ORDER BY p.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/moderation/:postId/clear
router.patch('/moderation/:postId/clear', requireRole('moderator', 'admin'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM post_reports WHERE post_id = $1', [req.params.postId]);
    const result = await pool.query(
      'UPDATE posts SET content_flagged = FALSE WHERE id = $1 RETURNING id',
      [req.params.postId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Post not found' });
    res.json({ cleared: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/moderation/:postId
router.delete('/moderation/:postId', requireRole('moderator', 'admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM posts WHERE id = $1 RETURNING id', [req.params.postId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Post not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── User management (admin only) ─────────────────────────────────────────────

// GET /api/admin/users
router.get('/users', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, role, reliability_score, created_at,
              (SELECT COUNT(*)::int FROM posts WHERE user_id = users.id) AS post_count,
              (SELECT COUNT(*)::int FROM post_reports pr JOIN posts p ON p.id = pr.post_id WHERE p.user_id = users.id) AS flag_count
       FROM users
       ORDER BY created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:userId/role
router.patch('/users/:userId/role', requireRole('admin'), async (req, res, next) => {
  try {
    const { role } = req.body;
    if (!['member', 'moderator', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'role must be member, moderator, or admin' });
    }

    const target = await pool.query('SELECT username FROM users WHERE id = $1', [req.params.userId]);
    if (!target.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (target.rows[0].username === 'AMBHaggermaker') {
      return res.status(403).json({ error: 'The founding account role cannot be changed' });
    }

    const result = await pool.query(
      'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, username, role',
      [role, req.params.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── Chat room management (moderator+) ────────────────────────────────────────

// GET /api/admin/chat-rooms
router.get('/chat-rooms', requireRole('moderator', 'admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.name, r.slug, r.description, r.pinned, r.flagged, r.is_public, r.created_at,
              u.username AS creator,
              (SELECT COUNT(*)::int FROM chat_messages WHERE room_id = r.id) AS message_count,
              (SELECT COUNT(*)::int FROM room_reports WHERE room_id = r.id) AS report_count
       FROM chat_rooms r
       LEFT JOIN users u ON u.id = r.created_by
       ORDER BY r.pinned DESC, r.created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/chat-rooms/:roomId
router.delete('/chat-rooms/:roomId', requireRole('admin'), async (req, res, next) => {
  try {
    const room = await pool.query('SELECT pinned FROM chat_rooms WHERE id = $1', [req.params.roomId]);
    if (!room.rows[0]) return res.status(404).json({ error: 'Room not found' });
    if (room.rows[0].pinned) {
      return res.status(403).json({ error: 'Protected rooms cannot be deleted' });
    }
    await pool.query('DELETE FROM chat_rooms WHERE id = $1', [req.params.roomId]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/chat-rooms/:roomId/flag — toggles the flag; moderators can flag but not unflag
router.patch('/chat-rooms/:roomId/flag', requireRole('moderator', 'admin'), async (req, res, next) => {
  try {
    const room = await pool.query('SELECT flagged FROM chat_rooms WHERE id = $1', [req.params.roomId]);
    if (!room.rows[0]) return res.status(404).json({ error: 'Room not found' });

    const role = req.user?.role || 'member';
    // Moderators can only flag (not unflag); admins can toggle either way
    const newFlagged = role === 'admin' ? !room.rows[0].flagged : true;

    const result = await pool.query(
      'UPDATE chat_rooms SET flagged = $1 WHERE id = $2 RETURNING flagged',
      [newFlagged, req.params.roomId]
    );
    res.json({ flagged: result.rows[0].flagged });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
