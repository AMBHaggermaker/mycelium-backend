const express    = require('express');
const multer     = require('multer');
const jwt        = require('jsonwebtoken');
const pool       = require('../db');
const authenticate   = require('../middleware/auth');
const { uploadToR2 } = require('../lib/r2');
const { sendEmail }  = require('../lib/email');

const JWT_SECRET = process.env.JWT_SECRET || 'mycelium_jwt_secret_change_in_production';

const VALID_TYPES = ['bug_report', 'feature_suggestion', 'content_issue', 'general_feedback', 'other'];
const VALID_STATUSES = ['new', 'reviewing', 'in_progress', 'completed', 'wont_fix'];

const TYPE_LABELS = {
  bug_report:         'Bug Report',
  feature_suggestion: 'Feature Suggestion',
  content_issue:      'Content Issue',
  general_feedback:   'General Feedback',
  other:              'Other',
};

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

// Optional auth middleware — attaches req.user if token present, but doesn't reject
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), JWT_SECRET);
    } catch {
      // silently ignore invalid token for optional auth
    }
  }
  next();
}

// Admin-only guard
function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const user = jwt.verify(header.slice(7), JWT_SECRET);
    if (user.role !== 'admin' && user.role !== 'moderator') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── POST /api/feedback ────────────────────────────────────────────────────────
// Requires authentication — all submissions are attributed per the Mycelium Covenant

router.post('/', authenticate, upload.single('screenshot'), async (req, res, next) => {
  try {
    const { type, description } = req.body;

    // Validate
    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    }
    if (!description || description.trim().length < 20) {
      return res.status(400).json({ error: 'description must be at least 20 characters' });
    }

    // Upload screenshot if provided
    let screenshotUrl = null;
    if (req.file) {
      screenshotUrl = await uploadToR2(req.file.buffer, req.file.originalname, 'feedback-screenshots');
    }

    const result = await pool.query(
      `INSERT INTO feedback_submissions
         (id, user_id, is_anonymous, type, description, screenshot_url, status, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, false, $2, $3, $4, 'new', NOW(), NOW())
       RETURNING *`,
      [req.user.id, type, description.trim(), screenshotUrl]
    );
    const submission = result.rows[0];

    // Email notification if FEEDBACK_EMAIL env var is set
    if (process.env.FEEDBACK_EMAIL) {
      const baseUrl = process.env.APP_BASE_URL || 'https://mycelium.unprecedentedtimes.org';
      const submitterLabel = `@${req.user.username}`;
      const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f2ede4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #ddd6c8;">
    <div style="background:#2a5f0a;padding:24px 32px;">
      <p style="color:#c8e6b0;font-size:12px;margin:0 0 6px;letter-spacing:.08em;text-transform:uppercase;">&#x2B21; Mycelium — Feedback</p>
      <h1 style="color:#fff;margin:0;font-size:18px;">New ${TYPE_LABELS[type] || type}</h1>
    </div>
    <div style="padding:28px 32px;">
      <table style="font-size:13px;color:#6b6254;border-collapse:collapse;width:100%;margin-bottom:16px;">
        <tr><td style="padding:4px 0;font-weight:600;width:120px;">Type</td><td>${TYPE_LABELS[type] || type}</td></tr>
        <tr><td style="padding:4px 0;font-weight:600;">Submitted by</td><td>${submitterLabel}</td></tr>
        <tr><td style="padding:4px 0;font-weight:600;">Date</td><td>${new Date().toLocaleString()}</td></tr>
        ${screenshotUrl ? `<tr><td style="padding:4px 0;font-weight:600;">Screenshot</td><td><a href="${screenshotUrl}" style="color:#2a5f0a;">View</a></td></tr>` : ''}
      </table>
      <div style="background:#faf8f4;border-radius:8px;border:1px solid #ddd6c8;padding:16px;margin-bottom:20px;">
        <p style="margin:0;font-size:14px;color:#1a1710;white-space:pre-wrap;">${submission.description}</p>
      </div>
      <div style="text-align:center;">
        <a href="${baseUrl}/admin" style="display:inline-block;background:#2a5f0a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:99px;font-size:14px;font-weight:700;">View in Admin</a>
      </div>
    </div>
  </div>
</body>
</html>`;
      sendEmail({
        to: process.env.FEEDBACK_EMAIL,
        subject: `[Mycelium Feedback] New ${TYPE_LABELS[type] || type}`,
        html,
      }).catch(e => console.error('[feedback] email error:', e.message));
    }

    res.status(201).json({ id: submission.id, message: 'Feedback submitted. Thank you!' });
  } catch (err) { next(err); }
});

// ── GET /api/feedback ─────────────────────────────────────────────────────────
// Admin only — list all feedback with submitter info

router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT fs.*,
              u.username AS submitter_username,
              u.avatar_url AS submitter_avatar
       FROM feedback_submissions fs
       LEFT JOIN users u ON u.id = fs.user_id
       ORDER BY fs.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── PATCH /api/feedback/:id ───────────────────────────────────────────────────
// Admin only — update status and/or admin_notes

router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { status, admin_notes } = req.body;

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    // Fetch existing submission
    const existing = await pool.query('SELECT * FROM feedback_submissions WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Feedback not found' });
    const sub = existing.rows[0];

    const result = await pool.query(
      `UPDATE feedback_submissions SET
         status      = COALESCE($1, status),
         admin_notes = COALESCE($2, admin_notes),
         updated_at  = NOW()
       WHERE id = $3
       RETURNING *`,
      [status || null, admin_notes ?? null, req.params.id]
    );
    const updated = result.rows[0];

    // Send email to user if applicable: status changed to completed/in_progress AND admin_notes set AND non-anon AND user exists
    const newStatus = status || sub.status;
    const notesText = admin_notes ?? sub.admin_notes;
    const statusChanged = status && status !== sub.status;
    const shouldEmail   = statusChanged
      && ['completed', 'in_progress'].includes(newStatus)
      && notesText
      && !sub.is_anonymous
      && sub.user_id;

    if (shouldEmail) {
      try {
        const userRow = await pool.query('SELECT username, email FROM users WHERE id = $1 AND deleted_at IS NULL', [sub.user_id]);
        const u = userRow.rows[0];
        if (u && u.email) {
          const statusLabel = newStatus === 'completed' ? 'Completed' : 'In Progress';
          const baseUrl = process.env.APP_BASE_URL || 'https://mycelium.unprecedentedtimes.org';
          const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f2ede4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #ddd6c8;">
    <div style="background:#2a5f0a;padding:24px 32px;">
      <p style="color:#c8e6b0;font-size:12px;margin:0 0 6px;letter-spacing:.08em;text-transform:uppercase;">&#x2B21; Mycelium — Feedback Update</p>
      <h1 style="color:#fff;margin:0;font-size:18px;">Your feedback is ${statusLabel}</h1>
    </div>
    <div style="padding:28px 32px;">
      <p style="font-size:15px;color:#1a1710;margin:0 0 16px;">
        Hi <strong>${u.username}</strong>, we wanted to give you an update on your feedback submission.
      </p>
      <table style="font-size:13px;color:#6b6254;border-collapse:collapse;width:100%;margin-bottom:16px;">
        <tr><td style="padding:4px 0;font-weight:600;width:120px;">Type</td><td>${TYPE_LABELS[sub.type] || sub.type}</td></tr>
        <tr><td style="padding:4px 0;font-weight:600;">Status</td><td><strong style="color:#2a5f0a;">${statusLabel}</strong></td></tr>
      </table>
      <div style="background:#faf8f4;border-radius:8px;border:1px solid #ddd6c8;padding:16px;margin-bottom:20px;">
        <p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#6b6254;text-transform:uppercase;letter-spacing:.05em;">Admin Note</p>
        <p style="margin:0;font-size:14px;color:#1a1710;white-space:pre-wrap;">${notesText}</p>
      </div>
      <div style="text-align:center;">
        <a href="${baseUrl}" style="display:inline-block;background:#2a5f0a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:99px;font-size:14px;font-weight:700;">Go to Mycelium</a>
      </div>
    </div>
  </div>
</body>
</html>`;
          sendEmail({
            to: u.email,
            subject: `[Mycelium] Your feedback is ${statusLabel}`,
            html,
          }).catch(e => console.error('[feedback] status email error:', e.message));
        }
      } catch (emailErr) {
        console.error('[feedback] failed to send status update email:', emailErr.message);
      }
    }

    res.json(updated);
  } catch (err) { next(err); }
});

// ── DELETE /api/feedback/:id ──────────────────────────────────────────────────
// Admin only

router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM feedback_submissions WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Feedback not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
