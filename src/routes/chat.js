const express = require('express');
const pool = require('../db');
const authenticate = require('../middleware/auth');

const router = express.Router();

// GET /api/chat/rooms
router.get('/rooms', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.*,
         (SELECT created_at FROM chat_messages WHERE room_id = r.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
       FROM chat_rooms r
       WHERE r.is_public = TRUE
       ORDER BY r.pinned DESC, r.created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/rooms
router.post('/rooms', authenticate, async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const slug = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!slug) return res.status(400).json({ error: 'Invalid room name' });

    const result = await pool.query(
      `INSERT INTO chat_rooms (name, slug, description, created_by, is_public)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING *`,
      [name.trim(), slug, description?.trim() || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A room with that name already exists' });
    next(err);
  }
});

// GET /api/chat/rooms/:slug/messages
router.get('/rooms/:slug/messages', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.room_id, m.user_id, m.content, m.created_at, u.username,
              r.slug AS room_slug
       FROM chat_messages m
       JOIN users u ON u.id = m.user_id
       JOIN chat_rooms r ON r.id = m.room_id
       WHERE r.slug = $1
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [req.params.slug]
    );
    res.json(result.rows.reverse());
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/rooms/:slug/report
router.post('/rooms/:slug/report', authenticate, async (req, res, next) => {
  try {
    const room = await pool.query('SELECT id FROM chat_rooms WHERE slug = $1', [req.params.slug]);
    if (!room.rows[0]) return res.status(404).json({ error: 'Room not found' });

    await pool.query(
      `INSERT INTO room_reports (room_id, user_id) VALUES ($1, $2) ON CONFLICT (room_id, user_id) DO NOTHING`,
      [room.rows[0].id, req.user.id]
    );
    await pool.query('UPDATE chat_rooms SET flagged = TRUE WHERE id = $1', [room.rows[0].id]);
    res.json({ reported: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
