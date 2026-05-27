const express    = require('express');
const multer     = require('multer');
const jwt        = require('jsonwebtoken');
const pool       = require('../db');
const authenticate   = require('../middleware/auth');
const { uploadToR2, deleteFromR2 } = require('../lib/r2');

const JWT_SECRET = process.env.JWT_SECRET || 'mycelium_jwt_secret_change_in_production';

const DEFAULT_BOARDS = [
  { board_type: 'bulletin',    position: 0 },
  { board_type: 'timeline',    position: 1 },
  { board_type: 'posts',       position: 2 },
  { board_type: 'events',      position: 3 },
  { board_type: 'photos',      position: 4 },
  { board_type: 'circles',     position: 5 },
  { board_type: 'people',      position: 6 },
  { board_type: 'invitations', position: 7 },
  { board_type: 'messages',    position: 8 },
  { board_type: 'chats',       position: 9 },
];

const router = express.Router();

// Use memory storage for R2 uploads (no disk write needed)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype));
  },
});

// ── GET /api/profiles/:username ───────────────────────────────────────────────

router.get('/:username', async (req, res, next) => {
  try {
    const userResult = await pool.query(
      `SELECT id, username, bio, location, website, reliability_score, avatar_url,
              verified, founding_member, created_at,
              mood, mood_emoji, status_text, music_url, music_label,
              background_color, background_gradient, accent_color,
              font_style, layout, banner_image_url, profile_theme,
              pinned_bulletin, bulletin_updated_at, interests,
              is_veteran, veteran_confirmed
       FROM users
       WHERE lower(username) = lower($1) AND deleted_at IS NULL`,
      [req.params.username]
    );
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const u = userResult.rows[0];

    // Posts (latest 30, exclude private)
    const postsResult = await pool.query(
      `SELECT p.*, u2.username, u2.reliability_score, u2.verified AS author_verified,
              u2.founding_member, c.name AS circle_name,
              (SELECT COALESCE(json_agg(pm ORDER BY pm.created_at), '[]') FROM post_media pm WHERE pm.post_id = p.id) AS media
       FROM posts p
       JOIN users u2 ON u2.id = p.user_id
       LEFT JOIN circles c ON c.id = p.circle_id
       WHERE p.user_id = $1 AND p.status != 'cancelled'
       ORDER BY p.created_at DESC LIMIT 30`,
      [u.id]
    );

    // Circles
    const circlesResult = await pool.query(
      `SELECT c.id, c.name, c.description, c.is_private, c.circle_type,
              COUNT(m.user_id)::int AS member_count, cm.role
       FROM circles c
       JOIN circle_members cm ON cm.circle_id = c.id AND cm.user_id = $1
       LEFT JOIN circle_members m ON m.circle_id = c.id
       GROUP BY c.id, cm.role, cm.joined_at
       ORDER BY cm.joined_at DESC LIMIT 20`,
      [u.id]
    );

    // Events (posts of type 'event' user created or has a reservation for)
    const eventsResult = await pool.query(
      `SELECT DISTINCT p.id, p.title, p.type, p.starts_at, p.ends_at,
              p.location, u2.username AS author_username, p.user_id
       FROM posts p
       JOIN users u2 ON u2.id = p.user_id
       WHERE p.type = 'event'
         AND (p.user_id = $1
              OR p.id IN (SELECT post_id FROM reservations WHERE user_id = $1))
       ORDER BY p.starts_at DESC NULLS LAST LIMIT 12`,
      [u.id]
    );

    // Co-participation (shared circles, ordered by connection strength)
    const copartResult = await pool.query(
      `SELECT u2.id, u2.username, u2.avatar_url, u2.verified, u2.founding_member,
              COUNT(*)::int AS shared_circles
       FROM circle_members cm1
       JOIN circle_members cm2 ON cm2.circle_id = cm1.circle_id AND cm2.user_id != $1
       JOIN users u2 ON u2.id = cm2.user_id AND u2.deleted_at IS NULL
       WHERE cm1.user_id = $1
       GROUP BY u2.id, u2.username, u2.avatar_url, u2.verified, u2.founding_member
       ORDER BY shared_circles DESC
       LIMIT 16`,
      [u.id]
    );

    // Photos (all albums)
    const photosResult = await pool.query(
      `SELECT id, url, caption, album_name, is_profile_photo, created_at
       FROM profile_photos WHERE user_id = $1 ORDER BY created_at DESC`,
      [u.id]
    );

    // Albums
    const albumsResult = await pool.query(
      `SELECT * FROM profile_albums WHERE user_id = $1 ORDER BY created_at ASC`,
      [u.id]
    );

    // Wall posts (latest 20)
    const wallResult = await pool.query(
      `SELECT wp.id, wp.content, wp.created_at,
              u2.id AS author_id, u2.username AS author_username,
              u2.avatar_url AS author_avatar_url, u2.verified AS author_verified
       FROM wall_posts wp
       JOIN users u2 ON u2.id = wp.author_id
       WHERE wp.profile_user_id = $1
       ORDER BY wp.created_at DESC LIMIT 20`,
      [u.id]
    );

    res.json({
      user: u,
      posts:        postsResult.rows,
      circles:      circlesResult.rows,
      events:       eventsResult.rows,
      copart:       copartResult.rows,
      photos:       photosResult.rows,
      albums:       albumsResult.rows,
      wall:         wallResult.rows,
    });
  } catch (err) { next(err); }
});

// ── PATCH /api/profiles/customize ─────────────────────────────────────────────

router.patch('/customize', authenticate, async (req, res, next) => {
  try {
    const {
      username, bio, location, website,
      mood, mood_emoji, status_text,
      music_url, music_label,
      background_color, background_gradient, accent_color,
      font_style, layout, profile_theme,
      pinned_bulletin, interests,
    } = req.body;

    const VALID_FONTS   = ['classic','modern','typewriter','editorial'];
    const VALID_LAYOUTS = ['standard','wide','minimal','sidebar'];
    const VALID_THEMES  = ['light','dark'];

    if (font_style   && !VALID_FONTS.includes(font_style))   return res.status(400).json({ error: 'Invalid font_style' });
    if (layout       && !VALID_LAYOUTS.includes(layout))     return res.status(400).json({ error: 'Invalid layout' });
    if (profile_theme && !VALID_THEMES.includes(profile_theme)) return res.status(400).json({ error: 'Invalid profile_theme' });
    if (status_text  && status_text.length > 100) return res.status(400).json({ error: 'status_text max 100 characters' });
    if (pinned_bulletin && pinned_bulletin.length > 500) return res.status(400).json({ error: 'pinned_bulletin max 500 characters' });

    const result = await pool.query(
      `UPDATE users SET
         username          = COALESCE($1,  username),
         bio               = COALESCE($2,  bio),
         location          = COALESCE($3,  location),
         website           = COALESCE($4,  website),
         mood              = COALESCE($5,  mood),
         mood_emoji        = COALESCE($6,  mood_emoji),
         status_text       = COALESCE($7,  status_text),
         music_url         = COALESCE($8,  music_url),
         music_label       = COALESCE($9,  music_label),
         background_color  = COALESCE($10, background_color),
         background_gradient = COALESCE($11, background_gradient),
         accent_color      = COALESCE($12, accent_color),
         font_style        = COALESCE($13, font_style),
         layout            = COALESCE($14, layout),
         profile_theme     = COALESCE($15, profile_theme),
         pinned_bulletin   = COALESCE($16, pinned_bulletin),
         bulletin_updated_at = CASE WHEN $16 IS NOT NULL THEN NOW() ELSE bulletin_updated_at END,
         interests         = COALESCE($17, interests),
         updated_at        = NOW()
       WHERE id = $18
       RETURNING id, username, bio, location, website, avatar_url,
                 mood, mood_emoji, status_text, music_url, music_label,
                 background_color, background_gradient, accent_color,
                 font_style, layout, banner_image_url, profile_theme,
                 pinned_bulletin, bulletin_updated_at, interests`,
      [
        username?.trim() ?? null,
        bio               ?? null,
        location?.trim()  ?? null,
        website?.trim()   ?? null,
        mood              ?? null,
        mood_emoji        ?? null,
        status_text       ?? null,
        music_url         ?? null,
        music_label       ?? null,
        background_color  ?? null,
        background_gradient ?? null,
        accent_color      ?? null,
        font_style        ?? null,
        layout            ?? null,
        profile_theme     ?? null,
        pinned_bulletin   ?? null,
        interests         ? (Array.isArray(interests) ? interests : []) : null,
        req.user.id,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    next(err);
  }
});

// ── POST /api/profiles/upload-photo ──────────────────────────────────────────

router.post('/upload-photo', authenticate, upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const { caption, album_name, is_profile_photo } = req.body;
    const url = await uploadToR2(req.file.buffer, req.file.originalname, 'profile-photos');

    // If setting as profile photo, update users table
    if (is_profile_photo === 'true' || is_profile_photo === true) {
      await pool.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [url, req.user.id]);
      await pool.query(
        'UPDATE profile_photos SET is_profile_photo = false WHERE user_id = $1',
        [req.user.id]
      );
    }

    const result = await pool.query(
      `INSERT INTO profile_photos (user_id, url, caption, album_name, is_profile_photo)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, url, caption || null, album_name || 'General', is_profile_photo === 'true']
    );

    // Update album or create it
    const albumName = album_name || 'General';
    await pool.query(
      `INSERT INTO profile_albums (user_id, name, cover_photo_url, photo_count)
       VALUES ($1,$2,$3,1)
       ON CONFLICT DO NOTHING`,
      [req.user.id, albumName, url]
    );
    await pool.query(
      `UPDATE profile_albums SET photo_count = photo_count + 1,
         cover_photo_url = CASE WHEN cover_photo_url IS NULL THEN $1 ELSE cover_photo_url END
       WHERE user_id = $2 AND name = $3`,
      [url, req.user.id, albumName]
    );

    res.status(201).json({ photo: result.rows[0], url });
  } catch (err) { next(err); }
});

// ── POST /api/profiles/upload-banner ─────────────────────────────────────────

router.post('/upload-banner', authenticate, upload.single('banner'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const url = await uploadToR2(req.file.buffer, req.file.originalname, 'profile-banners');

    // Delete old banner from R2 if it was an R2 URL
    const existing = await pool.query('SELECT banner_image_url FROM users WHERE id = $1', [req.user.id]);
    const oldUrl = existing.rows[0]?.banner_image_url;
    if (oldUrl && !oldUrl.startsWith('/api/')) await deleteFromR2(oldUrl);

    await pool.query(
      'UPDATE users SET banner_image_url = $1, updated_at = NOW() WHERE id = $2',
      [url, req.user.id]
    );
    res.json({ url });
  } catch (err) { next(err); }
});

// ── DELETE /api/profiles/photos/:id ──────────────────────────────────────────

router.delete('/photos/:id', authenticate, async (req, res, next) => {
  try {
    const photo = await pool.query(
      'SELECT * FROM profile_photos WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!photo.rows[0]) return res.status(404).json({ error: 'Photo not found' });

    await deleteFromR2(photo.rows[0].url);
    await pool.query('DELETE FROM profile_photos WHERE id = $1', [req.params.id]);

    // Update album photo_count
    await pool.query(
      `UPDATE profile_albums SET photo_count = GREATEST(0, photo_count - 1)
       WHERE user_id = $1 AND name = $2`,
      [req.user.id, photo.rows[0].album_name]
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── Wall posts ────────────────────────────────────────────────────────────────

// GET /api/profiles/:username/wall
router.get('/:username/wall', async (req, res, next) => {
  try {
    const u = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL', [req.params.username]);
    if (!u.rows[0]) return res.status(404).json({ error: 'User not found' });

    const result = await pool.query(
      `SELECT wp.id, wp.content, wp.created_at,
              u2.id AS author_id, u2.username AS author_username,
              u2.avatar_url AS author_avatar_url, u2.verified AS author_verified
       FROM wall_posts wp
       JOIN users u2 ON u2.id = wp.author_id
       WHERE wp.profile_user_id = $1
       ORDER BY wp.created_at DESC LIMIT 30`,
      [u.rows[0].id]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/profiles/:username/wall
router.post('/:username/wall', authenticate, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });
    if (content.trim().length > 1000) return res.status(400).json({ error: 'Wall post max 1000 characters' });

    const u = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL', [req.params.username]);
    if (!u.rows[0]) return res.status(404).json({ error: 'User not found' });

    const result = await pool.query(
      `INSERT INTO wall_posts (profile_user_id, author_id, content)
       VALUES ($1,$2,$3)
       RETURNING id, content, created_at`,
      [u.rows[0].id, req.user.id, content.trim()]
    );

    res.status(201).json({
      ...result.rows[0],
      author_id: req.user.id,
      author_username: req.user.username,
      author_verified: false,
    });
  } catch (err) { next(err); }
});

// ── GET /api/profiles/:username/boards ───────────────────────────────────────

router.get('/:username/boards', async (req, res, next) => {
  try {
    // Optional auth for owner-only boards
    let authUserId = null;
    try {
      const hdr = req.headers.authorization?.split(' ')[1];
      if (hdr) authUserId = jwt.verify(hdr, JWT_SECRET).id;
    } catch { /* unauthenticated */ }

    const uResult = await pool.query(
      'SELECT id FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL',
      [req.params.username]
    );
    if (!uResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const userId = uResult.rows[0].id;
    const isOwner = authUserId === userId;

    // Board settings
    const settingsResult = await pool.query(
      'SELECT board_type, position, is_visible, background_color, font_color FROM profile_board_settings WHERE user_id = $1 ORDER BY position ASC',
      [userId]
    );
    const savedSettings = settingsResult.rows;
    // Merge with defaults — any board not saved uses default
    const settingsMap = Object.fromEntries(savedSettings.map(s => [s.board_type, s]));
    const settings = DEFAULT_BOARDS.map(d => ({
      ...d, is_visible: true, background_color: null, font_color: null,
      ...settingsMap[d.board_type],
    })).sort((a, b) => a.position - b.position);

    // RSVP events (going / interested / saved)
    const rsvpResult = await pool.query(
      `SELECT p.id, p.title, p.type, p.starts_at, p.ends_at, p.location,
              u2.username AS author_username,
              rsvp.status AS rsvp_status, rsvp.created_at AS rsvped_at,
              (SELECT COUNT(*)::int FROM post_rsvps r WHERE r.post_id = p.id AND r.status = 'going') AS rsvp_going_count
       FROM post_rsvps rsvp
       JOIN posts p ON p.id = rsvp.post_id
       JOIN users u2 ON u2.id = p.user_id
       WHERE rsvp.user_id = $1 AND p.type = 'event'
       ORDER BY p.starts_at DESC NULLS LAST`,
      [userId]
    );

    // Timeline (last 30 activities)
    const timelineResult = await pool.query(
      `(SELECT 'post' AS activity_type, id AS ref_id, title AS label, type AS sub_type,
               NULL AS detail, created_at
        FROM posts WHERE user_id = $1 AND status != 'cancelled' ORDER BY created_at DESC LIMIT 15)
       UNION ALL
       (SELECT 'circle_join', c.id, c.name, NULL, NULL, cm.joined_at
        FROM circle_members cm
        JOIN circles c ON c.id = cm.circle_id
        WHERE cm.user_id = $1 ORDER BY cm.joined_at DESC LIMIT 10)
       UNION ALL
       (SELECT 'rsvp', p.id, p.title, rsvp.status, NULL, rsvp.created_at
        FROM post_rsvps rsvp
        JOIN posts p ON p.id = rsvp.post_id
        WHERE rsvp.user_id = $1 ORDER BY rsvp.created_at DESC LIMIT 10)
       ORDER BY created_at DESC LIMIT 30`,
      [userId]
    );

    // Owner-only: recent message conversations
    let recentMessages = [];
    if (isOwner) {
      const msgResult = await pool.query(
        `SELECT DISTINCT ON (LEAST(m.sender_id, m.recipient_id), GREATEST(m.sender_id, m.recipient_id))
                m.content AS last_message, m.created_at AS last_message_at, m.read,
                CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END AS other_id,
                u2.username AS other_username
         FROM messages m
         JOIN users u2 ON u2.id = CASE WHEN m.sender_id = $1 THEN m.recipient_id ELSE m.sender_id END
         WHERE m.sender_id = $1 OR m.recipient_id = $1
         ORDER BY LEAST(m.sender_id, m.recipient_id), GREATEST(m.sender_id, m.recipient_id),
                  m.created_at DESC
         LIMIT 5`,
        [userId]
      );
      recentMessages = msgResult.rows;
    }

    // Owner-only: recent chat activity
    let recentChats = [];
    if (isOwner) {
      const chatResult = await pool.query(
        `SELECT cr.name AS room_name, cr.slug, cm.content, cm.created_at
         FROM chat_messages cm
         JOIN chat_rooms cr ON cr.id = cm.room_id
         WHERE cm.user_id = $1
         ORDER BY cm.created_at DESC LIMIT 5`,
        [userId]
      );
      recentChats = chatResult.rows;
    }

    res.json({
      settings,
      rsvp_events:     rsvpResult.rows,
      timeline:        timelineResult.rows,
      recent_messages: recentMessages,
      recent_chats:    recentChats,
    });
  } catch (err) { next(err); }
});

// ── PATCH /api/profiles/boards/settings ──────────────────────────────────────

router.patch('/boards/settings', authenticate, async (req, res, next) => {
  try {
    const { boards } = req.body;
    if (!Array.isArray(boards)) return res.status(400).json({ error: 'boards array required' });

    for (const b of boards) {
      if (!b.board_type) continue;
      await pool.query(
        `INSERT INTO profile_board_settings (user_id, board_type, position, is_visible, background_color, font_color)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, board_type) DO UPDATE
           SET position = $3, is_visible = $4, background_color = $5, font_color = $6`,
        [req.user.id, b.board_type, b.position ?? 0, b.is_visible ?? true,
         b.background_color || null, b.font_color || null]
      );
    }
    res.json({ saved: true });
  } catch (err) { next(err); }
});

// DELETE /api/profiles/:username/wall/:postId
router.delete('/:username/wall/:postId', authenticate, async (req, res, next) => {
  try {
    const u = await pool.query('SELECT id FROM users WHERE lower(username) = lower($1)', [req.params.username]);
    if (!u.rows[0]) return res.status(404).json({ error: 'User not found' });

    const wp = await pool.query('SELECT * FROM wall_posts WHERE id = $1', [req.params.postId]);
    if (!wp.rows[0]) return res.status(404).json({ error: 'Post not found' });

    // Owner of profile or author of post or admin can delete
    const canDelete = req.user.id === u.rows[0].id ||
                      req.user.id === wp.rows[0].author_id ||
                      req.user.role === 'admin';
    if (!canDelete) return res.status(403).json({ error: 'Forbidden' });

    await pool.query('DELETE FROM wall_posts WHERE id = $1', [req.params.postId]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
