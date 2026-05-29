const express      = require('express');
const router       = express.Router();
const pool         = require('../db');
const authenticate = require('../middleware/auth');
const { deleteFromR2 } = require('../lib/r2');

const nodemailer = require('nodemailer');

function getMailer() {
  return nodemailer.createTransport({
    host:   process.env.MAIL_HOST,
    port:   parseInt(process.env.MAIL_PORT || '587'),
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
  });
}

async function notifyMaker(makerEmail, makerName, workTitle, reason) {
  if (!makerEmail || !process.env.MAIL_HOST) return;
  try {
    await getMailer().sendMail({
      from:    process.env.MAIL_FROM,
      to:      makerEmail,
      subject: `Content removal notice — "${workTitle}"`,
      text: `Hello ${makerName},\n\nA copyright claim was filed regarding your work "${workTitle}" on Mycelium. After review, the content has been removed.\n\nReason: ${reason || 'Copyright infringement claim upheld.'}\n\nIf you believe this was a mistake, you may file a counter-notice by returning to the platform. Counter-notices must be submitted within 14 days.\n\nMycelium Platform`,
    });
  } catch (e) {
    console.error('[copyright] mailer error:', e.message);
  }
}

// ── Public: submit a copyright claim ─────────────────────────────────────────

// POST /api/copyright/report
router.post('/report', async (req, res, next) => {
  try {
    const { work_id, claimant_name, claimant_email, original_work_desc } = req.body;
    if (!work_id || !claimant_name?.trim() || !claimant_email?.trim() || !original_work_desc?.trim()) {
      return res.status(400).json({ error: 'All fields required' });
    }

    const workResult = await pool.query('SELECT id, title FROM maker_works WHERE id = $1', [work_id]);
    if (!workResult.rows[0]) return res.status(404).json({ error: 'Work not found' });

    const result = await pool.query(
      `INSERT INTO copyright_claims
         (work_id, claimant_name, claimant_email, original_work_desc, good_faith_statement)
       VALUES ($1,$2,$3,$4,true) RETURNING id`,
      [parseInt(work_id), claimant_name.trim(), claimant_email.trim(), original_work_desc.trim()]
    );

    // Auto-flag the work for admin review
    await pool.query('UPDATE maker_works SET copyright_flagged = true WHERE id = $1', [parseInt(work_id)]);

    res.status(201).json({ id: result.rows[0].id, message: 'Claim submitted. Our team will review it.' });
  } catch (e) { next(e); }
});

// ── Maker: submit counter-notice ─────────────────────────────────────────────

// POST /api/copyright/counter-notice/:claimId
router.post('/counter-notice/:claimId', authenticate, async (req, res, next) => {
  try {
    const { statement } = req.body;
    if (!statement?.trim()) return res.status(400).json({ error: 'Counter-notice statement required' });

    const claimResult = await pool.query(
      `SELECT cc.*, mw.maker_id, mp.user_id
       FROM copyright_claims cc
       JOIN maker_works mw ON mw.id = cc.work_id
       JOIN maker_profiles mp ON mp.id = mw.maker_id
       WHERE cc.id = $1`,
      [req.params.claimId]
    );
    const claim = claimResult.rows[0];
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.user_id !== req.user.id) return res.status(403).json({ error: 'Not your work' });
    if (claim.status !== 'removed') return res.status(400).json({ error: 'Counter-notice only available after removal' });

    await pool.query(
      `UPDATE copyright_claims
       SET counter_notice_text = $1, counter_notice_at = NOW(), counter_notice_status = 'received'
       WHERE id = $2`,
      [statement.trim(), claim.id]
    );
    res.json({ message: 'Counter-notice submitted. Admins will review within 14 days.' });
  } catch (e) { next(e); }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'moderator') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// GET /api/copyright/admin/claims
router.get('/admin/claims', authenticate, adminOnly, async (req, res, next) => {
  try {
    const { status } = req.query;
    const params     = [];
    const conditions = [];
    if (status) { params.push(status); conditions.push(`cc.status = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const result = await pool.query(
      `SELECT cc.*, mw.title AS work_title, mw.r2_key, mw.r2_url, mw.work_type,
              mp.maker_name, u.username AS maker_username, u.email AS maker_email
       FROM copyright_claims cc
       JOIN maker_works mw ON mw.id = cc.work_id
       JOIN maker_profiles mp ON mp.id = mw.maker_id
       JOIN users u ON u.id = mp.user_id
       ${where}
       ORDER BY
         CASE cc.status
           WHEN 'under_review' THEN 0
           WHEN 'pending'      THEN 1
           WHEN 'removed'      THEN 2
           WHEN 'dismissed'    THEN 3
         END,
         cc.created_at DESC`,
      params
    );
    res.json(result.rows);
  } catch (e) { next(e); }
});

// PATCH /api/copyright/admin/claims/:id — update status
router.patch('/admin/claims/:id', authenticate, adminOnly, async (req, res, next) => {
  try {
    const { status, admin_notes } = req.body;
    const valid = ['pending','under_review','removed','dismissed'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const claimResult = await pool.query(
      `SELECT cc.*, mw.r2_key, mw.title AS work_title, mp.user_id, u.email AS maker_email, mp.maker_name
       FROM copyright_claims cc
       JOIN maker_works mw ON mw.id = cc.work_id
       JOIN maker_profiles mp ON mp.id = mw.maker_id
       JOIN users u ON u.id = mp.user_id
       WHERE cc.id = $1`,
      [req.params.id]
    );
    if (!claimResult.rows[0]) return res.status(404).json({ error: 'Claim not found' });
    const claim = claimResult.rows[0];

    if (status === 'removed' && claim.status !== 'removed') {
      // Delete R2 file and unpublish work
      await deleteFromR2(`/api/media/${claim.r2_key}`);
      await pool.query(
        'UPDATE maker_works SET published = false, copyright_flagged = true WHERE id = $1',
        [claim.work_id]
      );
      // Record the R2 key for audit trail
      await pool.query(
        `UPDATE copyright_claims
         SET status = $1, admin_notes = $2, reviewed_by = $3, reviewed_at = NOW(),
             r2_key_at_removal = $4
         WHERE id = $5`,
        [status, admin_notes || null, req.user.id, claim.r2_key, claim.id]
      );
      // Notify maker
      await notifyMaker(claim.maker_email, claim.maker_name, claim.work_title, admin_notes);
    } else {
      await pool.query(
        `UPDATE copyright_claims
         SET status = $1, admin_notes = $2, reviewed_by = $3, reviewed_at = NOW()
         WHERE id = $4`,
        [status, admin_notes || null, req.user.id, claim.id]
      );
      if (status === 'dismissed') {
        await pool.query('UPDATE maker_works SET copyright_flagged = false WHERE id = $1', [claim.work_id]);
      }
    }

    const updated = await pool.query('SELECT * FROM copyright_claims WHERE id = $1', [req.params.id]);
    res.json(updated.rows[0]);
  } catch (e) { next(e); }
});

// PATCH /api/copyright/admin/claims/:id/counter-notice — act on counter-notice
router.patch('/admin/claims/:id/counter-notice', authenticate, adminOnly, async (req, res, next) => {
  try {
    const { counter_notice_status } = req.body;
    if (!['accepted','rejected'].includes(counter_notice_status)) {
      return res.status(400).json({ error: 'Invalid counter_notice_status' });
    }
    await pool.query(
      `UPDATE copyright_claims SET counter_notice_status = $1 WHERE id = $2`,
      [counter_notice_status, req.params.id]
    );
    // If accepted, republish the work
    if (counter_notice_status === 'accepted') {
      const claimRes = await pool.query('SELECT work_id FROM copyright_claims WHERE id = $1', [req.params.id]);
      if (claimRes.rows[0]) {
        await pool.query(
          'UPDATE maker_works SET published = true, copyright_flagged = false WHERE id = $1',
          [claimRes.rows[0].work_id]
        );
      }
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/copyright/admin/flagged — auto-flagged works pending review
router.get('/admin/flagged', authenticate, adminOnly, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT mw.*, mp.maker_name, u.username
       FROM maker_works mw
       JOIN maker_profiles mp ON mp.id = mw.maker_id
       JOIN users u ON u.id = mp.user_id
       WHERE mw.copyright_flagged = true AND mw.published = true
       ORDER BY mw.created_at DESC`
    );
    res.json(result.rows);
  } catch (e) { next(e); }
});

module.exports = router;
