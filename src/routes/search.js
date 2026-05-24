const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /api/search?q=&type=posts|circles|users|all&circle_id=&post_type=&category=&subcategory=&limit=
router.get('/', async (req, res, next) => {
  try {
    const { q, type = 'all', circle_id, post_type, category, subcategory, limit = 20 } = req.query;
    if (!q?.trim()) return res.status(400).json({ error: 'q query parameter is required' });

    const results = {};
    const searchTerm = `%${q.trim()}%`;
    const lim = parseInt(limit);

    if (type === 'all' || type === 'posts') {
      const params = [searchTerm];
      const conditions = [
        `(p.title ILIKE $1 OR p.description ILIKE $1 OR p.subcategory ILIKE $1)`,
        `p.status = 'active'`
      ];

      if (circle_id) {
        params.push(circle_id);
        conditions.push(`p.circle_id = $${params.length}`);
      }
      if (post_type) {
        params.push(post_type);
        conditions.push(`p.type = $${params.length}::post_type`);
      }
      if (category) {
        params.push(category);
        conditions.push(`p.category = $${params.length}`);
      }
      if (subcategory) {
        params.push(`%${subcategory}%`);
        conditions.push(`p.subcategory ILIKE $${params.length}`);
      }

      params.push(lim);
      const postResults = await pool.query(
        `SELECT p.id, p.type, p.title, p.description, p.location, p.status,
                p.capacity, p.reserved_count, p.starts_at, p.tags,
                p.category, p.subcategory, p.created_at,
                u.username, u.reliability_score, c.name AS circle_name
         FROM posts p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN circles c ON c.id = p.circle_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY p.created_at DESC
         LIMIT $${params.length}`,
        params
      );
      results.posts = postResults.rows;
    }

    if (type === 'all' || type === 'circles') {
      const circleResults = await pool.query(
        `SELECT c.id, c.name, c.description, c.is_private, c.created_at,
                u.username AS creator_username,
                COUNT(cm.user_id)::int AS member_count
         FROM circles c
         LEFT JOIN users u ON u.id = c.created_by
         LEFT JOIN circle_members cm ON cm.circle_id = c.id
         WHERE (c.name ILIKE $1 OR c.description ILIKE $1) AND c.is_private = FALSE
         GROUP BY c.id, u.username
         ORDER BY member_count DESC, c.created_at DESC
         LIMIT $2`,
        [searchTerm, lim]
      );
      results.circles = circleResults.rows;
    }

    if (type === 'all' || type === 'users') {
      const userResults = await pool.query(
        `SELECT id, username, bio, location, reliability_score, created_at
         FROM users
         WHERE username ILIKE $1 OR bio ILIKE $1
         ORDER BY reliability_score DESC
         LIMIT $2`,
        [searchTerm, lim]
      );
      results.users = userResults.rows;
    }

    res.json(results);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
