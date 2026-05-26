const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const authenticate = require('../middleware/auth');
const crypto = require('crypto');
const { welcomeBackEmail, emailChangeVerification, passwordResetEmail } = require('../lib/email');

const FOUNDER_USERNAME = 'AMBHaggermaker';

const router = express.Router();
const JWT_SECRET    = process.env.JWT_SECRET    || 'mycelium_jwt_secret_change_in_production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role || 'member' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// GET /api/auth/check-email?email=X  (public — used for deleted-account detection)
router.get('/check-email', async (req, res, next) => {
  try {
    const email = req.query.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'email query param required' });

    const active = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND is_active = TRUE',
      [email]
    );
    if (active.rows[0]) return res.json({ status: 'active' });

    const deleted = await pool.query(
      'SELECT id, original_username FROM users WHERE original_email = $1 AND is_active = FALSE',
      [email]
    );
    if (deleted.rows[0]) {
      return res.json({
        status: 'deleted',
        deleted_user_id:   deleted.rows[0].id,
        original_username: deleted.rows[0].original_username,
      });
    }

    res.json({ status: 'none' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { username, email, password, bio, location, invite_token, how_found } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Display name, email, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const emailClean = email.toLowerCase().trim();

    // Block active duplicate
    const active = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND is_active = TRUE',
      [emailClean]
    );
    if (active.rows[0]) {
      return res.status(409).json({ error: 'That email is already registered' });
    }

    // Validate invite token if provided
    let invitation = null;
    if (invite_token) {
      const inv = await pool.query(
        `SELECT i.*, u.username AS inviter_username
         FROM invitations i JOIN users u ON u.id = i.invited_by
         WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()`,
        [invite_token]
      );
      if (!inv.rows[0]) {
        return res.status(400).json({ error: 'This invitation is invalid or has expired' });
      }
      invitation = inv.rows[0];
    }

    const hash = await bcrypt.hash(password, 12);
    const isVerified = !!invitation;

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, bio, location, verified, how_found)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, username, email, role, bio, location, reliability_score, verified,
                 founding_member, created_at`,
      [username.trim(), emailClean, hash,
       bio || null, location?.trim() || null, isVerified, how_found || null]
    );
    const user = result.rows[0];

    if (invitation) {
      await pool.query(
        `UPDATE invitations SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
        [invitation.id]
      );
      await pool.query(
        `INSERT INTO vouches (voucher_id, vouched_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [invitation.invited_by, user.id]
      );
      if (invitation.inviter_username === FOUNDER_USERNAME) {
        await pool.query(`UPDATE users SET founding_member = TRUE WHERE id = $1`, [user.id]);
        user.founding_member = true;
      }
    }

    res.status(201).json({ token: signToken(user), user, via_invite: !!invitation });
  } catch (err) {
    if (err.code === '23505') {
      const field = err.constraint?.includes('email') ? 'email' : 'username';
      return res.status(409).json({ error: `That ${field} is already taken` });
    }
    next(err);
  }
});

// POST /api/auth/restore/:userId — self-service restore of a soft-deleted account via invite
router.post('/restore/:userId', async (req, res, next) => {
  try {
    const { new_password, invite_token } = req.body;
    if (!new_password) return res.status(400).json({ error: 'new_password is required' });
    if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const target = await pool.query(
      'SELECT id, original_username, original_email, is_active FROM users WHERE id = $1 AND is_active = FALSE',
      [req.params.userId]
    );
    if (!target.rows[0]) return res.status(404).json({ error: 'Deleted account not found' });

    const { original_username, original_email } = target.rows[0];
    if (!original_username || !original_email) {
      return res.status(400).json({ error: 'Cannot restore — original account data was not preserved' });
    }

    // Validate invite token if provided
    let invitation = null;
    if (invite_token) {
      const inv = await pool.query(
        `SELECT i.*, u.username AS inviter_username
         FROM invitations i JOIN users u ON u.id = i.invited_by
         WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()`,
        [invite_token]
      );
      if (!inv.rows[0]) {
        return res.status(400).json({ error: 'This invitation is invalid or has expired' });
      }
      invitation = inv.rows[0];
    }

    const hash = await bcrypt.hash(new_password, 12);

    const result = await pool.query(
      `UPDATE users SET
         is_active = TRUE,
         deleted_at = NULL,
         username = original_username,
         email = original_email,
         original_username = NULL,
         original_email = NULL,
         password_hash = $1,
         updated_at = NOW()
       WHERE id = $2
       RETURNING id, username, email, role, bio, location, reliability_score, avatar_url,
                 verified, founding_member, created_at`,
      [hash, req.params.userId]
    );
    const user = result.rows[0];

    if (invitation) {
      await pool.query(
        `UPDATE invitations SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
        [invitation.id]
      );
      await pool.query(
        `INSERT INTO vouches (voucher_id, vouched_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [invitation.invited_by, user.id]
      );
      if (invitation.inviter_username === FOUNDER_USERNAME) {
        await pool.query(`UPDATE users SET founding_member = TRUE WHERE id = $1`, [user.id]);
        user.founding_member = true;
      }
    }

    welcomeBackEmail({ username: user.username, toEmail: user.email }).catch(e => {
      console.error('[restore] welcome back email failed:', e.message);
    });

    res.json({ token: signToken(user), user, restored: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Cannot restore — username or email conflict with an existing account' });
    }
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const result = await pool.query(
      `SELECT id, username, email, role, password_hash, bio, location, reliability_score, avatar_url,
              verified, founding_member, email_pending, created_at, is_active
       FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'This account has been deactivated' });
    }

    const { password_hash, ...safeUser } = user;
    res.json({ token: signToken(safeUser), user: safeUser });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, role, bio, location, reliability_score, avatar_url,
              verified, founding_member, email_pending, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/auth/change-password
router.patch('/change-password', authenticate, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current_password, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.id]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/request-email-change
router.post('/request-email-change', authenticate, async (req, res, next) => {
  try {
    const { current_password, new_email } = req.body;
    if (!current_password || !new_email) {
      return res.status(400).json({ error: 'current_password and new_email are required' });
    }

    const emailClean = new_email.toLowerCase().trim();
    if (emailClean === req.user.email?.toLowerCase()) {
      return res.status(400).json({ error: 'New email is the same as your current email' });
    }

    const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(current_password, userResult.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const taken = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND id != $2 AND is_active = TRUE',
      [emailClean, req.user.id]
    );
    if (taken.rows[0]) {
      return res.status(409).json({ error: 'That email address is already in use' });
    }

    const changeToken  = crypto.randomUUID();
    const expiresAt    = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE users SET email_pending = $1, email_change_token = $2, email_change_expires_at = $3
       WHERE id = $4`,
      [emailClean, changeToken, expiresAt, req.user.id]
    );

    emailChangeVerification({
      username:    req.user.username,
      newEmail:    emailClean,
      changeToken,
      toEmail:     emailClean,
    }).catch(e => console.error('[email-change] verification email failed:', e.message));

    res.json({ ok: true, email_pending: emailClean });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/verify-email-change?token=X  (public — linked from verification email)
router.get('/verify-email-change', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const result = await pool.query(
      `SELECT id, username, email_pending, email_change_expires_at
       FROM users WHERE email_change_token = $1`,
      [token]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Invalid or already-used verification link' });
    }

    const { id, username, email_pending, email_change_expires_at } = result.rows[0];
    if (new Date(email_change_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This verification link has expired. Request a new one from Settings.' });
    }

    await pool.query(
      `UPDATE users SET
         email = email_pending,
         email_pending = NULL,
         email_change_token = NULL,
         email_change_expires_at = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    res.json({ ok: true, email: email_pending, username });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/auth/request-email-change — cancel a pending email change
router.delete('/request-email-change', authenticate, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE users SET email_pending = NULL, email_change_token = NULL, email_change_expires_at = NULL
       WHERE id = $1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password  (public)
router.post('/forgot-password', async (req, res, next) => {
  try {
    const email = req.body.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'email is required' });

    // Always respond 200 to avoid email enumeration
    const result = await pool.query(
      `SELECT id, username FROM users WHERE email = $1 AND is_active = TRUE`,
      [email]
    );
    if (result.rows[0]) {
      const { id, username } = result.rows[0];
      const resetToken  = crypto.randomUUID();
      const expiresAt   = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await pool.query(
        `UPDATE users SET reset_token = $1, reset_expires_at = $2 WHERE id = $3`,
        [resetToken, expiresAt, id]
      );

      passwordResetEmail({ username, resetToken, toEmail: email }).catch(e => {
        console.error('[forgot-password] email failed:', e.message);
      });
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password  (public — uses token from email)
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) {
      return res.status(400).json({ error: 'token and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const result = await pool.query(
      `SELECT id, username, email, reset_expires_at FROM users WHERE reset_token = $1 AND is_active = TRUE`,
      [token]
    );
    if (!result.rows[0]) {
      return res.status(400).json({ error: 'Invalid or already-used reset link' });
    }
    const { id, username, email, reset_expires_at } = result.rows[0];
    if (new Date(reset_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This reset link has expired. Please request a new one.' });
    }

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query(
      `UPDATE users SET password_hash = $1, reset_token = NULL, reset_expires_at = NULL, updated_at = NOW()
       WHERE id = $2`,
      [hash, id]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
