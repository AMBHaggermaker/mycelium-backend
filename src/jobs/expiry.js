const pool = require('../db');

async function expireOldPosts() {
  try {
    const result = await pool.query(
      `UPDATE posts
       SET status = 'expired', updated_at = NOW()
       WHERE status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at < NOW()
       RETURNING id, title`
    );
    if (result.rowCount > 0) {
      console.log(`[expiry-job] Expired ${result.rowCount} post(s):`,
        result.rows.map(r => `${r.id} "${r.title}"`).join(', '));
    }
  } catch (err) {
    console.error('[expiry-job] Error:', err.message);
  }
}

module.exports = { expireOldPosts };
