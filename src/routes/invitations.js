const express = require('express');
const pool = require('../db');
const authenticate = require('../middleware/auth');
const { invitationEmail } = require('../lib/email');

const router = express.Router();

// GET /api/invitations — list my sent invitations
router.get('/', authenticate, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE invitations SET status = 'expired'
       WHERE invited_by = $1 AND status = 'pending' AND expires_at < NOW()`,
      [req.user.id]
    );

    const result = await pool.query(
      `SELECT i.id, i.email, i.personal_note, i.status,
              i.created_at, i.accepted_at, i.expires_at,
              u.username AS accepted_by_username, u.id AS accepted_by_id
       FROM invitations i
       LEFT JOIN users u ON u.id = (
         SELECT id FROM users WHERE email = i.email AND i.status = 'accepted' LIMIT 1
       )
       WHERE i.invited_by = $1
       ORDER BY i.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/invitations — send an invitation
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { email, personal_note } = req.body;
    if (!email?.trim()) return res.status(400).json({ error: 'email is required' });

    const emailClean = email.toLowerCase().trim();

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [emailClean]);
    if (existing.rows[0]) {
      return res.status(409).json({ error: 'That email address already has a Mycelium account' });
    }

    // Only block if there's an active pending invite (not deleted/expired)
    const dupe = await pool.query(
      `SELECT id FROM invitations
       WHERE invited_by = $1 AND email = $2 AND status = 'pending' AND expires_at > NOW()`,
      [req.user.id, emailClean]
    );
    if (dupe.rows[0]) {
      return res.status(409).json({ error: 'You already have an active invitation pending for that email' });
    }

    const result = await pool.query(
      `INSERT INTO invitations (invited_by, email, personal_note)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.user.id, emailClean, personal_note?.trim() || null]
    );
    const invite = result.rows[0];
    console.log(`[invite] created id=${invite.id} token=${invite.token} for=${emailClean} by=${req.user.username}`);

    invitationEmail({
      inviterName:  req.user.username,
      inviteToken:  invite.token,
      personalNote: invite.personal_note,
      toEmail:      invite.email,
    }).then(() => {
      console.log('[invite] email sent OK');
    }).catch(e => {
      console.error('[invite] email failed:', e.message);
    });

    res.status(201).json(invite);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/invitations/:id — delete a pending invitation
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM invitations
       WHERE id = $1 AND invited_by = $2 AND status = 'pending'
       RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Invitation not found or cannot be deleted' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/invitations/:id/resend — regenerate token + reset expiry + resend email
router.post('/:id/resend', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE invitations
       SET token = gen_random_uuid(),
           expires_at = NOW() + INTERVAL '14 days',
           status = 'pending'
       WHERE id = $1 AND invited_by = $2 AND status IN ('pending', 'expired')
       RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Invitation not found or cannot be resent' });
    }
    const invite = result.rows[0];

    invitationEmail({
      inviterName:  req.user.username,
      inviteToken:  invite.token,
      personalNote: invite.personal_note,
      toEmail:      invite.email,
    }).then(() => {
      console.log('[invite] resend email sent OK');
    }).catch(e => {
      console.error('[invite] resend email failed:', e.message);
    });

    res.json(invite);
  } catch (err) {
    next(err);
  }
});

// GET /api/invitations/token/:token — public lookup for acceptance page
router.get('/token/:token', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT i.id, i.email, i.personal_note, i.status, i.created_at, i.expires_at,
              u.id AS inviter_id, u.username AS inviter_username,
              u.bio AS inviter_bio, u.avatar_url AS inviter_avatar
       FROM invitations i
       JOIN users u ON u.id = i.invited_by
       WHERE i.token = $1`,
      [req.params.token]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Invitation not found' });

    const invite = result.rows[0];
    if (invite.status === 'pending' && new Date(invite.expires_at) < new Date()) {
      invite.status = 'expired';
    }

    res.json(invite);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
