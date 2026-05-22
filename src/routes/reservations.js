const express = require('express');
const pool = require('../db');
const authenticate = require('../middleware/auth');

const router = express.Router();

// GET /api/reservations (own reservations)
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.user.id];
    let where = 'WHERE r.user_id = $1';

    if (status) {
      params.push(status);
      where += ` AND r.status = $${params.length}::reservation_status`;
    }

    params.push(parseInt(limit), offset);
    const result = await pool.query(
      `SELECT r.*, p.title AS post_title, p.type AS post_type,
              p.location, p.starts_at, p.ends_at, p.user_id AS post_owner_id,
              u.username AS post_author
       FROM reservations r
       JOIN posts p ON p.id = r.post_id
       JOIN users u ON u.id = p.user_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/reservations/incoming (reservations on posts I own)
router.get('/incoming', authenticate, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.user.id];
    let where = 'WHERE p.user_id = $1';

    if (status) {
      params.push(status);
      where += ` AND r.status = $${params.length}::reservation_status`;
    }

    params.push(parseInt(limit), offset);
    const result = await pool.query(
      `SELECT r.*, p.title AS post_title, p.type AS post_type, p.location,
              u.username AS reserver_username, u.reliability_score AS reserver_score
       FROM reservations r
       JOIN posts p ON p.id = r.post_id
       JOIN users u ON u.id = r.user_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/reservations
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { post_id, notes } = req.body;
    if (!post_id) return res.status(400).json({ error: 'post_id is required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const postResult = await client.query(
        `SELECT id, user_id, capacity, reserved_count, status
         FROM posts WHERE id = $1 FOR UPDATE`,
        [post_id]
      );
      const post = postResult.rows[0];
      if (!post) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Post not found' });
      }
      if (post.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Post is not active' });
      }
      if (post.user_id === req.user.id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot reserve your own post' });
      }
      if (post.capacity !== null && post.reserved_count >= post.capacity) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Post is at full capacity' });
      }

      const reserveResult = await client.query(
        `INSERT INTO reservations (post_id, user_id, notes)
         VALUES ($1, $2, $3) RETURNING *`,
        [post_id, req.user.id, notes || null]
      );

      if (post.capacity !== null) {
        await client.query(
          `UPDATE posts SET reserved_count = reserved_count + 1 WHERE id = $1`,
          [post_id]
        );
      }

      await client.query('COMMIT');
      res.status(201).json(reserveResult.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'Already reserved this post' });
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/reservations/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.*, p.title AS post_title, p.type AS post_type, p.capacity,
              p.user_id AS post_owner_id, p.location, p.starts_at, p.ends_at,
              u.username AS post_author, ru.username AS reserver_username
       FROM reservations r
       JOIN posts p ON p.id = r.post_id
       JOIN users u ON u.id = p.user_id
       JOIN users ru ON ru.id = r.user_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Reservation not found' });

    const reservation = result.rows[0];
    if (reservation.user_id !== req.user.id && reservation.post_owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(reservation);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/reservations/:id
// Post owner can confirm/complete (with optional rating 1-10)
// Either party can cancel
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const { status, rating } = req.body;
    const validStatuses = ['confirmed', 'cancelled', 'completed'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    if (rating !== undefined) {
      const r = parseFloat(rating);
      if (isNaN(r) || r < 1 || r > 10) {
        return res.status(400).json({ error: 'rating must be between 1 and 10' });
      }
    }

    const existing = await pool.query(
      `SELECT r.*, p.user_id AS post_owner_id, p.capacity
       FROM reservations r
       JOIN posts p ON p.id = r.post_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Reservation not found' });

    const reservation = existing.rows[0];
    const isReserver = reservation.user_id === req.user.id;
    const isPostOwner = reservation.post_owner_id === req.user.id;

    if (!isReserver && !isPostOwner) return res.status(403).json({ error: 'Forbidden' });
    if ((status === 'confirmed' || status === 'completed') && !isPostOwner) {
      return res.status(403).json({ error: 'Only the post owner can confirm or complete reservations' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `UPDATE reservations SET status = $1::reservation_status, updated_at = NOW()
         WHERE id = $2 RETURNING *`,
        [status, req.params.id]
      );

      // Decrement capacity count if cancelling an active reservation
      const wasActive = ['pending', 'confirmed'].includes(reservation.status);
      if (wasActive && status === 'cancelled' && reservation.capacity !== null) {
        await client.query(
          `UPDATE posts SET reserved_count = GREATEST(0, reserved_count - 1) WHERE id = $1`,
          [reservation.post_id]
        );
      }

      // Update reserver reliability score when post owner rates on completion
      if (status === 'completed' && isPostOwner && rating !== undefined) {
        await client.query(
          `UPDATE users
           SET reliability_score = LEAST(10, GREATEST(0, reliability_score * 0.8 + $1 * 0.2)),
               updated_at = NOW()
           WHERE id = $2`,
          [parseFloat(rating), reservation.user_id]
        );
      }

      await client.query('COMMIT');
      res.json(result.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// DELETE /api/reservations/:id (reserver cancels their own)
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `DELETE FROM reservations WHERE id = $1 AND user_id = $2 RETURNING *`,
        [req.params.id, req.user.id]
      );

      if (!result.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Reservation not found or not yours' });
      }

      const deleted = result.rows[0];
      if (['pending', 'confirmed'].includes(deleted.status)) {
        const post = await client.query('SELECT capacity FROM posts WHERE id = $1', [deleted.post_id]);
        if (post.rows[0]?.capacity !== null) {
          await client.query(
            `UPDATE posts SET reserved_count = GREATEST(0, reserved_count - 1) WHERE id = $1`,
            [deleted.post_id]
          );
        }
      }

      await client.query('COMMIT');
      res.status(204).end();
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
