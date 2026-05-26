const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const authenticate = require('../middleware/auth');

const FOUNDER_USERNAME = 'AMBHaggermaker';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'mycelium_jwt_secret_change_in_production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role || 'member' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// POST /api/auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { username, email, password, bio, location, invite_token } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
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
      // Ensure the invite email matches (soft check — allow any email for flexibility)
    }

    const hash = await bcrypt.hash(password, 12);
    const isVerified = !!invitation;

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, bio, location, verified)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, email, role, bio, location, reliability_score, verified,
                 founding_member, created_at`,
      [username.trim(), email.toLowerCase().trim(), hash,
       bio || null, location || null, isVerified]
    );
    const user = result.rows[0];

    if (invitation) {
      // Mark invitation accepted
      await pool.query(
        `UPDATE invitations SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
        [invitation.id]
      );

      // Create vouch record
      await pool.query(
        `INSERT INTO vouches (voucher_id, vouched_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [invitation.invited_by, user.id]
      );

      // If vouched by the founder, grant founding_member
      if (invitation.inviter_username === FOUNDER_USERNAME) {
        await pool.query(
          `UPDATE users SET founding_member = TRUE WHERE id = $1`,
          [user.id]
        );
        user.founding_member = true;
      }
    }

    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    if (err.code === '23505') {
      const field = err.constraint?.includes('email') ? 'email' : 'username';
      return res.status(409).json({ error: `That ${field} is already taken` });
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
      `SELECT id, username, email, role, password_hash, bio, location, reliability_score, avatar_url, created_at, is_active
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
              verified, founding_member, created_at
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

module.exports = router;
