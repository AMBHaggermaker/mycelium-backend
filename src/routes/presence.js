const express   = require('express');
const router    = express.Router();
const pool      = require('../db');
const authenticate = require('../middleware/auth');
const ioLib     = require('../lib/io');

// GET /api/presence/online — list of currently visible online users
router.get('/online', authenticate, async (req, res, next) => {
  try {
    res.json(ioLib.getPresenceList(req.user.id));
  } catch (e) { next(e); }
});

// PATCH /api/presence/status — set own presence status
router.patch('/status', authenticate, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['online', 'busy', 'away', 'offline'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    await pool.query('UPDATE users SET presence_status = $1 WHERE id = $2', [status, req.user.id]);
    ioLib.updatePresenceStatus(String(req.user.id), status);
    res.json({ status });
  } catch (e) { next(e); }
});

module.exports = router;
