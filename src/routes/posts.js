const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const pool    = require('../db');
const authenticate = require('../middleware/auth');
const ioLib   = require('../lib/io');

const JWT_SECRET = process.env.JWT_SECRET || 'mycelium_jwt_secret_change_in_production';

const router = express.Router();

const uploadDir = path.resolve('uploads/posts');
fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

const VALID_CATEGORIES = new Set(['jobs_services', 'goods_supplies', 'community']);

const AUTO_URGENT_TAGS = new Set([
  'hunger', 'food crisis', 'shelter', 'homeless', 'crisis',
  'mental health crisis', 'child', 'children', 'medical', 'emergency',
]);

function isAutoUrgent(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some(t => AUTO_URGENT_TAGS.has(t.toLowerCase().trim()));
}

const NSFW_PATTERN = /\b(porn(?:ography)?|xxx|nudes?|naked|onlyfans|escort|prostitut\w*|camgirl|stripper|penis|vagina|fuck\w*|pussy|cocks?|dicks?|tits?|boobs?|nipples?)\b/i;

const mediaStorage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const uploadMedia = multer({
  storage: mediaStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.has(file.mimetype)),
});

const MEDIA_SQL = `(SELECT COALESCE(json_agg(pm ORDER BY pm.created_at), '[]') FROM post_media pm WHERE pm.post_id = p.id) AS media`;

const PRIORITY_SCORE_SQL = `
  CASE
    WHEN p.auto_urgent THEN
      2.0 + CASE WHEN p.is_urgent THEN
        CASE WHEN u.reliability_score > 3.0 THEN 1.0 ELSE 0.5 END
      ELSE 0.0 END
    WHEN p.is_urgent THEN
      CASE WHEN u.reliability_score > 3.0 THEN 1.0 ELSE 0.5 END
    ELSE 0.0
  END`;

const SORT_ORDER = {
  recent:           `p.created_at DESC`,
  urgent:           `(${PRIORITY_SCORE_SQL}) DESC, p.created_at DESC`,
  least_responded:  `COALESCE(p.reserved_count, 0) ASC, p.created_at DESC`,
  expiring:         `COALESCE(p.expires_at, p.ends_at) ASC NULLS LAST, p.created_at DESC`,
};

// GET /api/posts
router.get('/', async (req, res, next) => {
  // Optional auth — include user's RSVP status on event posts if logged in
  let authUserId = null;
  try {
    const hdr = req.headers.authorization?.split(' ')[1];
    if (hdr) authUserId = jwt.verify(hdr, JWT_SECRET).id;
  } catch { /* unauthenticated */ }

  try {
    const { type, circle_id, status, tags, category, subcategory, sort = 'recent', page = 1, limit = 20, feed_tab, commerce_type: ctFilter } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = [];

    // Always exclude non-active and expired posts from the public feed
    conditions.push(`p.status = 'active'`);
    conditions.push(`(p.expires_at IS NULL OR p.expires_at > NOW())`);

    if (type)       { params.push(type);                                  conditions.push(`p.type = $${params.length}::post_type`); }
    if (circle_id)  { params.push(circle_id);                             conditions.push(`p.circle_id = $${params.length}`); }
    if (tags)       { params.push(tags.split(',').map(t => t.trim()));    conditions.push(`p.tags && $${params.length}::text[]`); }
    if (category)   { params.push(category);                              conditions.push(`p.category = $${params.length}`); }
    if (subcategory){ params.push(subcategory);                           conditions.push(`p.subcategory ILIKE $${params.length}`); }
    if (ctFilter)   { params.push(ctFilter);                              conditions.push(`p.commerce_type = $${params.length}`); }

    if (feed_tab === 'community') {
      conditions.push(`(p.commerce_type IS NULL OR p.commerce_type = 'exchange')`);
      conditions.push(`(p.auto_urgent = FALSE AND p.is_urgent = FALSE)`);
    } else if (feed_tab === 'commerce') {
      conditions.push(`p.commerce_type = 'commerce'`);
    } else if (feed_tab === 'urgent') {
      conditions.push(`(p.auto_urgent = TRUE OR p.is_urgent = TRUE OR p.commerce_type = 'urgent')`);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const orderBy = SORT_ORDER[sort] || SORT_ORDER.recent;
    params.push(parseInt(limit), offset);

    const rsvpJoin = authUserId
      ? `LEFT JOIN post_rsvps my_rsvp ON my_rsvp.post_id = p.id AND my_rsvp.user_id = '${authUserId}'`
      : '';
    const rsvpSelect = authUserId ? `, my_rsvp.status AS my_rsvp` : '';
    const rsvpCountSelect = `
      , (SELECT COUNT(*) FROM post_rsvps r WHERE r.post_id = p.id AND r.status = 'going')::int      AS rsvp_going_count
      , (SELECT COUNT(*) FROM post_rsvps r WHERE r.post_id = p.id AND r.status = 'interested')::int AS rsvp_interested_count
      , (SELECT COUNT(*) FROM post_rsvps r WHERE r.post_id = p.id AND r.status = 'saved')::int      AS rsvp_saved_count`;

    const result = await pool.query(
      `SELECT p.*, u.username, u.reliability_score, u.verified AS author_verified,
              u.founding_member, c.name AS circle_name,
              b.business_name,
              ${PRIORITY_SCORE_SQL} AS priority_score,
              ${MEDIA_SQL}
              ${rsvpCountSelect}
              ${rsvpSelect}
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN circles c ON c.id = p.circle_id
       LEFT JOIN businesses b ON b.id = p.business_id
       ${rsvpJoin}
       ${where}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/posts
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { type, title, description, circle_id, capacity, location, starts_at, ends_at,
            tags, category, subcategory, is_urgent, expires_at, commerce_type, price, business_id } = req.body;
    if (!type || !title) return res.status(400).json({ error: 'type and title are required' });
    if (!['need', 'offer', 'event'].includes(type)) return res.status(400).json({ error: 'type must be need, offer, or event' });
    if (type === 'event' && !starts_at) return res.status(400).json({ error: 'starts_at is required for events' });
    if (category && !VALID_CATEGORIES.has(category)) return res.status(400).json({ error: 'Invalid category' });
    const VALID_COMMERCE = new Set(['exchange', 'commerce', 'urgent']);
    if (commerce_type && !VALID_COMMERCE.has(commerce_type)) return res.status(400).json({ error: 'Invalid commerce_type' });

    const text = `${title} ${description || ''}`;
    if (NSFW_PATTERN.test(text)) {
      return res.status(422).json({ error: 'This platform does not allow adult content. Please keep posts appropriate for all community members.' });
    }

    if (circle_id) {
      const member = await pool.query(
        'SELECT 1 FROM circle_members WHERE circle_id = $1 AND user_id = $2',
        [circle_id, req.user.id]
      );
      if (!member.rows.length) return res.status(403).json({ error: 'Must be a circle member to post there' });
    }

    const parsedTags = Array.isArray(tags) ? tags : (tags || []);
    const autoUrgent = isAutoUrgent(parsedTags);
    const userUrgent = is_urgent === true || is_urgent === 'true';
    const resolvedCommerceType = autoUrgent ? 'urgent' : (commerce_type || null);

    const result = await pool.query(
      `INSERT INTO posts (type, title, description, user_id, circle_id, capacity, location,
                          starts_at, ends_at, tags, category, subcategory, is_urgent, auto_urgent,
                          expires_at, commerce_type, price, business_id)
       VALUES ($1::post_type, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *, '[]'::json AS media`,
      [type, title.trim(), description || null, req.user.id, circle_id || null,
       capacity || null, location || null, starts_at || null, ends_at || null,
       parsedTags, category || null, subcategory?.trim() || null,
       userUrgent, autoUrgent, expires_at || null, resolvedCommerceType,
       price != null ? parseFloat(price) : null, business_id || null]
    );
    const p = result.rows[0];
    ioLib.networkActivity('new_post', {
      title:    p.title,
      type:     p.type,
      category: p.category,
      location: p.location,
      username: req.user.username,
    }, (p.auto_urgent || p.is_urgent) ? 'urgent' : 'normal');

    res.status(201).json(p);
  } catch (err) {
    next(err);
  }
});

// GET /api/posts/my-posts — all posts by the authenticated user (all statuses)
router.get('/my-posts', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
              (SELECT COUNT(*)::int FROM reservations r WHERE r.post_id = p.id AND r.status NOT IN ('cancelled')) AS reservation_count,
              (SELECT COUNT(*)::int FROM post_rsvps r WHERE r.post_id = p.id AND r.status = 'going') AS rsvp_going_count,
              ${MEDIA_SQL}
       FROM posts p
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/posts/:id/complete — mark post as fulfilled (owner only)
router.patch('/:id/complete', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE posts SET status = 'fulfilled', updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, status`,
      [req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Post not found or forbidden' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/posts/:id/extend — extend expiry date (owner only, must not already be expired)
router.patch('/:id/extend', authenticate, async (req, res, next) => {
  try {
    const { expires_at } = req.body;
    if (!expires_at) return res.status(400).json({ error: 'expires_at is required' });
    const newExpiry = new Date(expires_at);
    if (isNaN(newExpiry) || newExpiry <= new Date()) {
      return res.status(400).json({ error: 'expires_at must be a future date' });
    }
    const result = await pool.query(
      `UPDATE posts SET expires_at = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3 AND (expires_at IS NULL OR expires_at > NOW())
       RETURNING id, expires_at`,
      [newExpiry.toISOString(), req.params.id, req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Post not found, forbidden, or already expired' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/posts/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.*, u.username, u.reliability_score, u.verified AS author_verified,
              u.founding_member AS author_founding_member, u.bio AS author_bio,
              u.avatar_url AS author_avatar_url, c.name AS circle_name, b.business_name, ${MEDIA_SQL},
              (SELECT COUNT(*) FROM post_rsvps r WHERE r.post_id = p.id AND r.status = 'going')::int      AS rsvp_going_count,
              (SELECT COUNT(*) FROM post_rsvps r WHERE r.post_id = p.id AND r.status = 'interested')::int AS rsvp_interested_count,
              (SELECT COUNT(*) FROM post_rsvps r WHERE r.post_id = p.id AND r.status = 'saved')::int      AS rsvp_saved_count
       FROM posts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN circles c ON c.id = p.circle_id
       LEFT JOIN businesses b ON b.id = p.business_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Post not found' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/posts/:id/my-reservation
router.get('/:id/my-reservation', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id FROM reservations
       WHERE post_id = $1 AND user_id = $2
         AND status NOT IN ('cancelled','completed')
       LIMIT 1`,
      [req.params.id, req.user.id]
    );
    res.json({ reservation_id: result.rows[0]?.id || null });
  } catch (err) {
    next(err);
  }
});

// GET /api/posts/:id/comments
router.get('/:id/comments', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT pc.id, pc.content, pc.created_at,
              u.id AS user_id, u.username, u.avatar_url,
              u.founding_member, u.verified, u.reliability_score
       FROM post_comments pc
       JOIN users u ON u.id = pc.user_id
       WHERE pc.post_id = $1
       ORDER BY pc.created_at ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/posts/:id/comments
router.post('/:id/comments', authenticate, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
    if (content.trim().length > 2000) return res.status(400).json({ error: 'comment too long (max 2000 chars)' });

    const post = await pool.query('SELECT id FROM posts WHERE id = $1', [req.params.id]);
    if (!post.rows[0]) return res.status(404).json({ error: 'Post not found' });

    const result = await pool.query(
      `INSERT INTO post_comments (post_id, user_id, content)
       VALUES ($1, $2, $3)
       RETURNING id, content, created_at`,
      [req.params.id, req.user.id, content.trim()]
    );
    const row = result.rows[0];
    const u = await pool.query(
      `SELECT username, avatar_url, founding_member, verified, reliability_score FROM users WHERE id = $1`,
      [req.user.id]
    ).then(r => r.rows[0] || {});
    res.status(201).json({
      ...row,
      user_id: req.user.id,
      username:          u.username          || req.user.username,
      avatar_url:        u.avatar_url        || null,
      founding_member:   u.founding_member   || false,
      verified:          u.verified          || false,
      reliability_score: u.reliability_score || 5,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/posts/:id
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const existing = await pool.query('SELECT user_id FROM posts WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Post not found' });
    if (existing.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { title, description, capacity, location, starts_at, ends_at, status,
            tags, category, subcategory, is_urgent, expires_at, commerce_type, price } = req.body;
    if (category !== undefined && category !== null && !VALID_CATEGORIES.has(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    const VALID_COMMERCE_PATCH = new Set(['exchange', 'commerce', 'urgent']);
    if (commerce_type !== undefined && commerce_type !== null && !VALID_COMMERCE_PATCH.has(commerce_type)) {
      return res.status(400).json({ error: 'Invalid commerce_type' });
    }

    const parsedTags = tags !== undefined ? (Array.isArray(tags) ? tags : tags) : undefined;
    const autoUrgent = parsedTags !== undefined ? isAutoUrgent(parsedTags) : undefined;
    const userUrgent = is_urgent !== undefined ? (is_urgent === true || is_urgent === 'true') : undefined;

    const result = await pool.query(
      `UPDATE posts SET
         title         = COALESCE($1, title),
         description   = COALESCE($2, description),
         capacity      = COALESCE($3, capacity),
         location      = COALESCE($4, location),
         starts_at     = COALESCE($5, starts_at),
         ends_at       = COALESCE($6, ends_at),
         status        = COALESCE($7::post_status, status),
         tags          = COALESCE($8::text[], tags),
         category      = COALESCE($9, category),
         subcategory   = COALESCE($10, subcategory),
         is_urgent     = COALESCE($11, is_urgent),
         auto_urgent   = COALESCE($12, auto_urgent),
         expires_at    = COALESCE($13, expires_at),
         commerce_type = COALESCE($14, commerce_type),
         price         = COALESCE($15, price),
         updated_at    = NOW()
       WHERE id = $16
       RETURNING *`,
      [title, description, capacity, location, starts_at, ends_at, status,
       parsedTags !== undefined ? parsedTags : null,
       category || null, subcategory?.trim() || null,
       userUrgent !== undefined ? userUrgent : null,
       autoUrgent !== undefined ? autoUrgent : null,
       expires_at !== undefined ? expires_at : null,
       commerce_type !== undefined ? commerce_type : null,
       price != null ? parseFloat(price) : null,
       req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/posts/:id — author, admin, or moderator; cascades to reservations and RSVPs
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT user_id FROM posts WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Post not found' });
    const isOwner = result.rows[0].user_id === req.user.id;
    const isPrivileged = ['admin', 'moderator'].includes(req.user.role);
    if (!isOwner && !isPrivileged) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/posts/:id/media
router.post('/:id/media', authenticate, uploadMedia.array('media', 5), async (req, res, next) => {
  try {
    const post = await pool.query('SELECT user_id FROM posts WHERE id = $1', [req.params.id]);
    if (!post.rows[0]) {
      req.files?.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(404).json({ error: 'Post not found' });
    }
    if (post.rows[0].user_id !== req.user.id) {
      req.files?.forEach(f => fs.unlink(f.path, () => {}));
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!req.files?.length) return res.status(400).json({ error: 'No files provided' });

    const inserted = await Promise.all(
      req.files.map(f =>
        pool.query(
          `INSERT INTO post_media (post_id, url, mime_type, original_name, size_bytes)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [req.params.id, `/api/uploads/posts/${f.filename}`, f.mimetype, f.originalname, f.size]
        ).then(r => r.rows[0])
      )
    );
    res.status(201).json(inserted);
  } catch (err) {
    req.files?.forEach(f => fs.unlink(f.path, () => {}));
    next(err);
  }
});

// POST /api/posts/:id/report
router.post('/:id/report', authenticate, async (req, res, next) => {
  try {
    const post = await pool.query('SELECT id, user_id FROM posts WHERE id = $1', [req.params.id]);
    if (!post.rows[0]) return res.status(404).json({ error: 'Post not found' });
    if (post.rows[0].user_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot report your own post' });
    }

    await pool.query(
      `INSERT INTO post_reports (post_id, user_id, reason) VALUES ($1, $2, $3)
       ON CONFLICT (post_id, user_id) DO NOTHING`,
      [req.params.id, req.user.id, req.body.reason || null]
    );
    await pool.query('UPDATE posts SET content_flagged = TRUE WHERE id = $1', [req.params.id]);
    res.json({ reported: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/posts/:id/media/:mediaId
router.delete('/:id/media/:mediaId', authenticate, async (req, res, next) => {
  try {
    const post = await pool.query('SELECT user_id FROM posts WHERE id = $1', [req.params.id]);
    if (!post.rows[0]) return res.status(404).json({ error: 'Post not found' });
    if (post.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const media = await pool.query(
      'DELETE FROM post_media WHERE id = $1 AND post_id = $2 RETURNING *',
      [req.params.mediaId, req.params.id]
    );
    if (!media.rows[0]) return res.status(404).json({ error: 'Media not found' });

    const filePath = path.resolve(media.rows[0].url.replace('/api/', ''));
    fs.unlink(filePath, () => {});
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── RSVP ─────────────────────────────────────────────────────────────────────

// GET /api/posts/:id/rsvp — current user's RSVP for this post
router.get('/:id/rsvp', authenticate, async (req, res, next) => {
  try {
    const r = await pool.query(
      'SELECT status FROM post_rsvps WHERE post_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ status: r.rows[0]?.status || null });
  } catch (err) { next(err); }
});

// POST /api/posts/:id/rsvp — upsert RSVP
router.post('/:id/rsvp', authenticate, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['going', 'interested', 'saved'].includes(status)) {
      return res.status(400).json({ error: 'status must be going, interested, or saved' });
    }
    const post = await pool.query(
      `SELECT id, title, type FROM posts WHERE id = $1 AND status = 'active'`,
      [req.params.id]
    );
    if (!post.rows[0]) return res.status(404).json({ error: 'Post not found' });

    const r = await pool.query(
      `INSERT INTO post_rsvps (post_id, user_id, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (post_id, user_id) DO UPDATE SET status = $3, created_at = NOW()
       RETURNING *`,
      [req.params.id, req.user.id, status]
    );

    const counts = await pool.query(
      `SELECT status, COUNT(*)::int FROM post_rsvps WHERE post_id = $1 GROUP BY status`,
      [req.params.id]
    );
    const countMap = Object.fromEntries(counts.rows.map(c => [c.status, c.count]));

    if (status === 'going' && post.rows[0].type === 'event') {
      ioLib.networkActivity('rsvp', {
        event_title: post.rows[0].title,
        status,
      }, 'normal');
    }

    res.json({ rsvp: r.rows[0], counts: countMap });
  } catch (err) { next(err); }
});

// DELETE /api/posts/:id/rsvp — remove RSVP
router.delete('/:id/rsvp', authenticate, async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM post_rsvps WHERE post_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    const counts = await pool.query(
      `SELECT status, COUNT(*)::int FROM post_rsvps WHERE post_id = $1 GROUP BY status`,
      [req.params.id]
    );
    const countMap = Object.fromEntries(counts.rows.map(c => [c.status, c.count]));
    res.json({ rsvp: null, counts: countMap });
  } catch (err) { next(err); }
});

module.exports = router;
