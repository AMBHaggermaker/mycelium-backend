const express   = require('express');
const pool      = require('../db');
const authenticate = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

// ── Unread count (for nav badge) ─────────────────────────────────────────────

// GET /api/messages/unread-count
router.get('/unread-count', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM messages
       WHERE recipient_id = $1 AND read = false`,
      [req.user.id]
    );
    res.json({ count: result.rows[0].count });
  } catch (err) { next(err); }
});

// ── Blocked users ─────────────────────────────────────────────────────────────

// GET /api/messages/blocked
router.get('/blocked', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT bu.id, bu.blocked_user_id, u.username, bu.created_at
       FROM blocked_users bu
       JOIN users u ON u.id = bu.blocked_user_id
       WHERE bu.user_id = $1 ORDER BY bu.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/messages/block/:userId
router.post('/block/:userId', async (req, res, next) => {
  try {
    if (req.params.userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }
    const user = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.userId]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });

    await pool.query(
      `INSERT INTO blocked_users (user_id, blocked_user_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`,
      [req.user.id, req.params.userId]
    );
    res.json({ blocked: true });
  } catch (err) { next(err); }
});

// DELETE /api/messages/block/:userId
router.delete('/block/:userId', async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM blocked_users WHERE user_id = $1 AND blocked_user_id = $2',
      [req.user.id, req.params.userId]
    );
    res.json({ unblocked: true });
  } catch (err) { next(err); }
});

// ── Conversations list ────────────────────────────────────────────────────────

// GET /api/messages/conversations
router.get('/conversations', async (req, res, next) => {
  try {
    const result = await pool.query(
      `WITH ranked AS (
         SELECT
           m.*,
           CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END AS other_user_id,
           ROW_NUMBER() OVER (
             PARTITION BY LEAST(m.sender_id::text, m.recipient_id::text),
                          GREATEST(m.sender_id::text, m.recipient_id::text)
             ORDER BY m.created_at DESC
           ) AS rn
         FROM messages m
         WHERE m.sender_id = $1 OR m.recipient_id = $1
       )
       SELECT
         r.other_user_id,
         u.username AS other_username,
         u.avatar_url AS other_avatar_url,
         u.verified AS other_verified,
         r.content AS last_message,
         r.created_at AS last_message_at,
         r.sender_id AS last_sender_id,
         (SELECT COUNT(*)::int FROM messages m2
          WHERE m2.sender_id = r.other_user_id AND m2.recipient_id = $1 AND m2.read = false
         ) AS unread_count
       FROM ranked r
       JOIN users u ON u.id = r.other_user_id
       WHERE r.rn = 1
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── Full thread with a user ───────────────────────────────────────────────────

// GET /api/messages/:userId
router.get('/:userId', async (req, res, next) => {
  try {
    const other = await pool.query(
      'SELECT id, username, avatar_url, verified, founding_member FROM users WHERE id = $1',
      [req.params.userId]
    );
    if (!other.rows[0]) return res.status(404).json({ error: 'User not found' });

    // Mark messages from them as read
    await pool.query(
      `UPDATE messages SET read = true
       WHERE sender_id = $1 AND recipient_id = $2 AND read = false`,
      [req.params.userId, req.user.id]
    );

    const messages = await pool.query(
      `SELECT m.*, u.username AS sender_username, u.avatar_url AS sender_avatar_url
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE (m.sender_id = $1 AND m.recipient_id = $2)
          OR (m.sender_id = $2 AND m.recipient_id = $1)
       ORDER BY m.created_at ASC
       LIMIT 200`,
      [req.user.id, req.params.userId]
    );

    // Check if blocked
    const blocked = await pool.query(
      `SELECT id FROM blocked_users
       WHERE (user_id = $1 AND blocked_user_id = $2)
          OR (user_id = $2 AND blocked_user_id = $1)`,
      [req.user.id, req.params.userId]
    );

    res.json({
      other_user: other.rows[0],
      messages: messages.rows,
      is_blocked: blocked.rows.length > 0,
    });
  } catch (err) { next(err); }
});

// ── Send message ──────────────────────────────────────────────────────────────

// POST /api/messages/:userId
router.post('/:userId', async (req, res, next) => {
  try {
    if (req.params.userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot message yourself' });
    }

    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Message content is required' });
    if (content.trim().length > 5000) return res.status(400).json({ error: 'Message too long (max 5000 chars)' });

    // Check recipient exists
    const recipient = await pool.query(
      'SELECT id, verified FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.params.userId]
    );
    if (!recipient.rows[0]) return res.status(404).json({ error: 'User not found' });

    // Check sender is verified (only verified members can initiate new conversations)
    const sender = await pool.query(
      'SELECT id, verified FROM users WHERE id = $1',
      [req.user.id]
    );
    const existingThread = await pool.query(
      `SELECT id FROM messages
       WHERE (sender_id = $1 AND recipient_id = $2)
          OR (sender_id = $2 AND recipient_id = $1)
       LIMIT 1`,
      [req.user.id, req.params.userId]
    );
    if (!sender.rows[0]?.verified && !existingThread.rows[0]) {
      return res.status(403).json({ error: 'Only verified members can initiate new conversations' });
    }

    // Check not blocked
    const blocked = await pool.query(
      `SELECT id FROM blocked_users
       WHERE (user_id = $1 AND blocked_user_id = $2)
          OR (user_id = $2 AND blocked_user_id = $1)`,
      [req.user.id, req.params.userId]
    );
    if (blocked.rows[0]) {
      return res.status(403).json({ error: 'Messaging is blocked between these users' });
    }

    const result = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, content)
       VALUES ($1,$2,$3)
       RETURNING id, sender_id, recipient_id, content, read, created_at`,
      [req.user.id, req.params.userId, content.trim()]
    );

    const msg = { ...result.rows[0], sender_username: req.user.username };
    res.status(201).json(msg);
  } catch (err) { next(err); }
});

// ── Report message ────────────────────────────────────────────────────────────

// POST /api/messages/:messageId/report
router.post('/:messageId/report', async (req, res, next) => {
  try {
    const msg = await pool.query(
      'SELECT * FROM messages WHERE id = $1 AND recipient_id = $2',
      [req.params.messageId, req.user.id]
    );
    if (!msg.rows[0]) return res.status(404).json({ error: 'Message not found' });

    const { note } = req.body;
    await pool.query(
      'UPDATE messages SET reported = true, report_note = $1 WHERE id = $2',
      [note || null, req.params.messageId]
    );
    res.json({ reported: true });
  } catch (err) { next(err); }
});

module.exports = router;
