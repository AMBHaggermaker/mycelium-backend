const express = require('express');
const pool    = require('../db');
const ioLib   = require('../lib/io');

const router = express.Router();

// GET /api/activity/today
router.get('/today', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM posts
         WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'active') AS posts_today,
        (SELECT COUNT(*)::int FROM posts
         WHERE created_at > NOW() - INTERVAL '24 hours'
           AND (is_urgent = true OR auto_urgent = true)
           AND status = 'active') AS urgent_today,
        (SELECT COUNT(*)::int FROM users
         WHERE created_at > NOW() - INTERVAL '24 hours' AND deleted_at IS NULL) AS members_today,
        (SELECT COUNT(*)::int FROM post_rsvps
         WHERE created_at > NOW() - INTERVAL '24 hours') AS rsvps_today
    `);
    res.json({ ...result.rows[0], active_now: ioLib.getConnected() });
  } catch (err) { next(err); }
});

module.exports = router;
