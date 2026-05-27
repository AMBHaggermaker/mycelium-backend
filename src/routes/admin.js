const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const authenticate = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { passwordResetEmail } = require('../lib/email');

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
      `SELECT u.id, u.username, u.email, u.role, u.reliability_score, u.is_active, u.deleted_at,
              u.created_at, u.updated_at AS last_active,
              u.location, u.how_found, u.verified,
              u.original_username, u.preserved_display_name, u.founding_member,
              u.covenant_agreed, u.covenant_agreed_at,
              inv_user.username  AS inviter_username,
              (SELECT COUNT(*)::int FROM posts WHERE user_id = u.id) AS post_count,
              (SELECT COUNT(*)::int FROM post_reports pr JOIN posts p ON p.id = pr.post_id WHERE p.user_id = u.id) AS flag_count
       FROM users u
       LEFT JOIN vouches vc ON vc.vouched_id = u.id
       LEFT JOIN users inv_user ON inv_user.id = vc.voucher_id
       ORDER BY u.is_active DESC, u.created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/:userId/profile — full profile summary for side panel
router.get('/users/:userId/profile', requireRole('admin'), async (req, res, next) => {
  try {
    const uid = req.params.userId;

    const [userRes, circlesRes, postsRes, chainRes] = await Promise.all([
      pool.query(
        `SELECT u.id, u.username, u.email, u.bio, u.location, u.how_found,
                u.verified, u.founding_member, u.covenant_agreed, u.covenant_agreed_at,
                u.created_at, u.updated_at AS last_active, u.avatar_url,
                u.reliability_score, u.role, u.is_veteran, u.veteran_confirmed,
                inv_user.username AS inviter_username
         FROM users u
         LEFT JOIN vouches vc ON vc.vouched_id = u.id
         LEFT JOIN users inv_user ON inv_user.id = vc.voucher_id
         WHERE u.id = $1`,
        [uid]
      ),
      pool.query(
        `SELECT c.id, c.name, c.circle_type, cm.role, cm.joined_at
         FROM circle_members cm
         JOIN circles c ON c.id = cm.circle_id
         WHERE cm.user_id = $1
         ORDER BY cm.joined_at ASC`,
        [uid]
      ),
      pool.query(
        `SELECT id, title, type, status, created_at, content
         FROM posts
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [uid]
      ),
      pool.query(
        `WITH RECURSIVE chain(user_id, username, depth) AS (
           SELECT u.id, u.username, 0
           FROM users u WHERE u.id = $1
           UNION ALL
           SELECT v.voucher_id, u.username, c.depth + 1
           FROM chain c
           JOIN vouches v ON v.vouched_id = c.user_id
           JOIN users u ON u.id = v.voucher_id
           WHERE c.depth < 20
         )
         SELECT user_id AS id, username, depth FROM chain ORDER BY depth`,
        [uid]
      ),
    ]);

    if (!userRes.rows[0]) return res.status(404).json({ error: 'User not found' });

    res.json({
      user:         userRes.rows[0],
      circles:      circlesRes.rows,
      posts:        postsRes.rows,
      vouch_chain:  chainRes.rows,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:userId/delete — soft-delete (admin only)
router.patch('/users/:userId/delete', requireRole('admin'), async (req, res, next) => {
  try {
    const target = await pool.query(
      'SELECT username, is_active FROM users WHERE id = $1',
      [req.params.userId]
    );
    if (!target.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (target.rows[0].username === 'AMBHaggermaker') {
      return res.status(403).json({ error: 'The founding account cannot be deleted' });
    }
    if (req.params.userId === req.user.id) {
      return res.status(403).json({ error: 'You cannot delete your own account' });
    }
    if (!target.rows[0].is_active) {
      return res.status(409).json({ error: 'User is already deleted' });
    }

    const anonymizedUsername = `deleted_${req.params.userId.slice(0, 8)}`;
    const anonymizedEmail    = `deleted_${req.params.userId}@deleted.invalid`;

    const result = await pool.query(
      `UPDATE users
       SET original_username      = username,
           original_email         = email,
           preserved_display_name = username,
           is_active    = FALSE,
           deleted_at   = NOW(),
           username     = $1,
           email        = $2,
           password_hash = '',
           bio          = NULL,
           location     = NULL,
           avatar_url   = NULL
       WHERE id = $3
       RETURNING id, username, is_active, deleted_at`,
      [anonymizedUsername, anonymizedEmail, req.params.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/users/:userId/restore — reactivate a soft-deleted account
router.patch('/users/:userId/restore', requireRole('admin'), async (req, res, next) => {
  try {
    const target = await pool.query(
      'SELECT id, original_username, original_email, is_active FROM users WHERE id = $1',
      [req.params.userId]
    );
    if (!target.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (target.rows[0].is_active) return res.status(409).json({ error: 'Account is already active' });

    const { original_username, original_email } = target.rows[0];

    // Best-effort restore: use originals if available, keep anonymized values if not
    const result = await pool.query(
      `UPDATE users SET
         is_active = TRUE,
         deleted_at = NULL,
         username = COALESCE(original_username, username),
         email    = COALESCE(original_email,    email),
         original_username = NULL,
         original_email    = NULL,
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, username, email, role, is_active`,
      [req.params.userId]
    );
    const restored = result.rows[0];

    // Only send welcome-back email if we had the real email address
    if (original_email) {
      const { welcomeBackEmail } = require('../lib/email');
      welcomeBackEmail({ username: restored.username, toEmail: restored.email }).catch(e => {
        console.error('[admin restore] welcome back email failed:', e.message);
      });
    }

    res.json(restored);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Cannot restore — username or email conflict with an existing account' });
    }
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

// PATCH /api/admin/users/:userId/founding-member  — grant or revoke founding member status
router.patch('/users/:userId/founding-member', requireRole('admin'), async (req, res, next) => {
  try {
    const { grant } = req.body; // true = grant, false = revoke
    if (typeof grant !== 'boolean') {
      return res.status(400).json({ error: 'grant must be true or false' });
    }

    const target = await pool.query('SELECT username FROM users WHERE id = $1', [req.params.userId]);
    if (!target.rows[0]) return res.status(404).json({ error: 'User not found' });

    if (!grant && target.rows[0].username === 'AMBHaggermaker') {
      return res.status(403).json({ error: 'The founding account founding member status cannot be revoked' });
    }

    const result = await pool.query(
      'UPDATE users SET founding_member = $1 WHERE id = $2 RETURNING id, username, founding_member',
      [grant, req.params.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:userId/send-password-reset — trigger password reset email
router.post('/users/:userId/send-password-reset', requireRole('admin'), async (req, res, next) => {
  try {
    const target = await pool.query(
      'SELECT id, username, email, is_active FROM users WHERE id = $1',
      [req.params.userId]
    );
    if (!target.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (!target.rows[0].is_active) return res.status(400).json({ error: 'Cannot reset password for a deleted account' });

    const { id, username, email } = target.rows[0];
    const resetToken = crypto.randomUUID();
    const expiresAt  = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query(
      `UPDATE users SET reset_token = $1, reset_expires_at = $2 WHERE id = $3`,
      [resetToken, expiresAt, id]
    );

    await passwordResetEmail({ username, resetToken, toEmail: email });

    res.json({ ok: true });
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

// ── Watch anomaly management (admin only) ────────────────────────────────────

// GET /api/admin/watch-anomalies
router.get('/watch-anomalies', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM watch_anomalies
       ORDER BY reviewed ASC,
         CASE severity WHEN 'critical' THEN 1 WHEN 'serious' THEN 2 WHEN 'moderate' THEN 3 WHEN 'minor' THEN 4 ELSE 5 END,
         created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/watch-anomalies/:id/review
router.patch('/watch-anomalies/:id/review', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE watch_anomalies SET reviewed = TRUE WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Anomaly not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/watch-anomalies/:id
router.delete('/watch-anomalies/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM watch_anomalies WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Anomaly not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Business management (admin only) ─────────────────────────────────────────

// GET /api/admin/businesses
router.get('/businesses', requireRole('admin'), async (req, res, next) => {
  try {
    const showDeleted = req.query.show_deleted === 'true';
    const result = await pool.query(
      `SELECT b.*, u.username AS owner_username,
              (SELECT COUNT(CASE WHEN tm.parent_id IS NULL THEN 1 END)::int
               FROM thread_messages tm JOIN threads t ON t.id = tm.thread_id
               WHERE t.business_id = b.id) AS recommendation_count
       FROM businesses b
       JOIN users u ON u.id = b.owner_id
       ${showDeleted ? '' : 'WHERE b.is_active = TRUE'}
       ORDER BY b.is_verified_local ASC, b.is_active DESC, b.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// PATCH /api/admin/businesses/:id/deactivate
router.patch('/businesses/:id/deactivate', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE businesses SET is_active = FALSE, deleted_at = NOW(), deleted_by = $1
       WHERE id = $2 RETURNING id, business_name, is_active, deleted_at`,
      [req.user.id, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Business not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/admin/businesses/:id/verify
router.patch('/businesses/:id/verify', requireRole('admin'), async (req, res, next) => {
  try {
    const { verified } = req.body;
    const result = await pool.query(
      'UPDATE businesses SET is_verified_local = $1 WHERE id = $2 RETURNING id, business_name, is_verified_local',
      [verified !== false, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Business not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:userId/covenant-agreed — mark covenant agreed for a user (admin only)
router.patch('/users/:userId/covenant-agreed', requireRole('admin'), async (req, res, next) => {
  try {
    const target = await pool.query('SELECT id, username FROM users WHERE id = $1', [req.params.userId]);
    if (!target.rows[0]) return res.status(404).json({ error: 'User not found' });

    const result = await pool.query(
      `UPDATE users SET covenant_agreed = TRUE, covenant_agreed_at = NOW()
       WHERE id = $1
       RETURNING id, username, covenant_agreed, covenant_agreed_at`,
      [req.params.userId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
