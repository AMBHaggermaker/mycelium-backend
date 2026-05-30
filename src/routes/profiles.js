const express    = require('express');
const multer     = require('multer');
const jwt        = require('jsonwebtoken');
const pool       = require('../db');
const authenticate   = require('../middleware/auth');
const { uploadToR2, deleteFromR2 } = require('../lib/r2');

const JWT_SECRET = process.env.JWT_SECRET || 'mycelium_jwt_secret_change_in_production';

const DEFAULT_BOARDS = [
  { board_type: 'bulletin',     position: 0  },
  { board_type: 'timeline',     position: 1  },
  { board_type: 'posts',        position: 2  },
  { board_type: 'events',       position: 3  },
  { board_type: 'photos',       position: 4  },
  { board_type: 'circles',      position: 5  },
  { board_type: 'people',       position: 6  },
  { board_type: 'professional', position: 7  },
  { board_type: 'my_businesses',position: 8  },
  { board_type: 'invitations',  position: 9  },
  { board_type: 'messages',     position: 10 },
  { board_type: 'chats',        position: 11 },
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

// GET /api/profiles/:username/card — lightweight card data for thumbnails
router.get('/:username/card', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT username, bio AS status_text, avatar_url, banner_image_url AS banner_url,
              accent_color, background_color, mood_emoji, mood AS mood_label,
              font_style, verified AS is_verified, founding_member,
              COALESCE(status_text, pinned_bulletin) AS status_text
       FROM users
       WHERE lower(username) = lower($1) AND deleted_at IS NULL`,
      [req.params.username]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

router.get('/:username', async (req, res, next) => {
  try {
    const userResult = await pool.query(
      `SELECT id, username, bio, location, website, reliability_score, avatar_url,
              verified, founding_member, created_at,
              mood, mood_emoji, status_text, music_url, music_label,
              background_color, background_gradient, accent_color,
              font_style, layout, banner_image_url, profile_theme,
              pinned_bulletin, bulletin_updated_at, interests,
              is_veteran, veteran_confirmed,
              covenant_agreed, covenant_agreed_at,
              background_photo_url, background_overlay_opacity,
              profile_network_settings, profile_stickers,
              pattern_type, pattern_color_primary, pattern_color_secondary,
              pattern_scale, pattern_opacity, wall_privacy
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
              u2.mood_emoji, u2.mood, u2.status_text, u2.pinned_bulletin,
              u2.accent_color,
              COUNT(*)::int AS shared_circles
       FROM circle_members cm1
       JOIN circle_members cm2 ON cm2.circle_id = cm1.circle_id AND cm2.user_id != $1
       JOIN users u2 ON u2.id = cm2.user_id AND u2.deleted_at IS NULL
       WHERE cm1.user_id = $1
       GROUP BY u2.id, u2.username, u2.avatar_url, u2.verified, u2.founding_member,
                u2.mood_emoji, u2.mood, u2.status_text, u2.pinned_bulletin, u2.accent_color
       ORDER BY shared_circles DESC
       LIMIT 30`,
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

    // Wall posts — pinned first, then newest
    const wallResult = await pool.query(
      `SELECT wp.id, wp.content, wp.photo_urls, wp.is_pinned, wp.collage_layout, wp.created_at,
              u2.id AS author_id, u2.username AS author_username,
              u2.avatar_url AS author_avatar_url, u2.verified AS author_verified,
              (SELECT COUNT(*) FROM threads t WHERE t.wall_post_id = wp.id)::int AS reply_count
       FROM wall_posts wp
       JOIN users u2 ON u2.id = wp.author_id
       WHERE wp.profile_user_id = $1
       ORDER BY wp.is_pinned DESC, wp.created_at DESC LIMIT 50`,
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
      background_photo_url, background_overlay_opacity,
      profile_network_settings, profile_stickers,
      pattern_type, pattern_color_primary, pattern_color_secondary,
      pattern_scale, pattern_opacity,
      wall_privacy,
    } = req.body;

    const VALID_WALL_PRIVACY = ['everyone', 'network', 'disabled'];
    const VALID_FONTS    = ['classic','modern','typewriter','editorial'];
    const VALID_LAYOUTS  = ['standard','wide','minimal','sidebar'];
    const VALID_THEMES   = ['light','dark'];
    const VALID_PATTERNS = ['solid','diagonal_stripes','horizontal_stripes','vertical_stripes','grid','dots','checkerboard','zigzag','diamonds','honeycomb','crosshatch','waves','triangles','stars','mycelium'];
    const VALID_SCALES   = ['small','medium','large'];

    if (font_style    && !VALID_FONTS.includes(font_style))       return res.status(400).json({ error: 'Invalid font_style' });
    if (layout        && !VALID_LAYOUTS.includes(layout))         return res.status(400).json({ error: 'Invalid layout' });
    if (profile_theme && !VALID_THEMES.includes(profile_theme))   return res.status(400).json({ error: 'Invalid profile_theme' });
    if (status_text   && status_text.length > 100)                return res.status(400).json({ error: 'status_text max 100 characters' });
    if (pinned_bulletin && pinned_bulletin.length > 500)          return res.status(400).json({ error: 'pinned_bulletin max 500 characters' });
    if (pattern_type  && !VALID_PATTERNS.includes(pattern_type))  return res.status(400).json({ error: 'Invalid pattern_type' });
    if (pattern_scale && !VALID_SCALES.includes(pattern_scale))   return res.status(400).json({ error: 'Invalid pattern_scale' });
    if (wall_privacy  && !VALID_WALL_PRIVACY.includes(wall_privacy)) return res.status(400).json({ error: 'Invalid wall_privacy' });
    if (background_overlay_opacity != null) {
      const v = parseFloat(background_overlay_opacity);
      if (isNaN(v) || v < 0 || v > 0.9) return res.status(400).json({ error: 'background_overlay_opacity must be 0–0.9' });
    }
    if (pattern_opacity != null) {
      const v = parseFloat(pattern_opacity);
      if (isNaN(v) || v < 0 || v > 1) return res.status(400).json({ error: 'pattern_opacity must be 0–1' });
    }

    // background_photo_url: allow explicit null to clear it
    const bgPhotoVal = Object.prototype.hasOwnProperty.call(req.body, 'background_photo_url')
      ? (background_photo_url ?? null)
      : undefined;

    const result = await pool.query(
      `UPDATE users SET
         username                  = COALESCE($1,  username),
         bio                       = COALESCE($2,  bio),
         location                  = COALESCE($3,  location),
         website                   = COALESCE($4,  website),
         mood                      = COALESCE($5,  mood),
         mood_emoji                = COALESCE($6,  mood_emoji),
         status_text               = COALESCE($7,  status_text),
         music_url                 = COALESCE($8,  music_url),
         music_label               = COALESCE($9,  music_label),
         background_color          = COALESCE($10, background_color),
         background_gradient       = COALESCE($11, background_gradient),
         accent_color              = COALESCE($12, accent_color),
         font_style                = COALESCE($13, font_style),
         layout                    = COALESCE($14, layout),
         profile_theme             = COALESCE($15, profile_theme),
         pinned_bulletin           = COALESCE($16, pinned_bulletin),
         bulletin_updated_at       = CASE WHEN $16 IS NOT NULL THEN NOW() ELSE bulletin_updated_at END,
         interests                 = COALESCE($17, interests),
         background_photo_url      = CASE WHEN $18::text IS NOT NULL THEN $18::text ELSE CASE WHEN $19 THEN NULL ELSE background_photo_url END END,
         background_overlay_opacity= COALESCE($20, background_overlay_opacity),
         profile_network_settings  = COALESCE($21, profile_network_settings),
         profile_stickers          = COALESCE($22, profile_stickers),
         pattern_type              = COALESCE($23, pattern_type),
         pattern_color_primary     = COALESCE($24, pattern_color_primary),
         pattern_color_secondary   = COALESCE($25, pattern_color_secondary),
         pattern_scale             = COALESCE($26, pattern_scale),
         pattern_opacity           = COALESCE($27, pattern_opacity),
         wall_privacy              = COALESCE($28, wall_privacy),
         updated_at                = NOW()
       WHERE id = $29
       RETURNING id, username, bio, location, website, avatar_url,
                 mood, mood_emoji, status_text, music_url, music_label,
                 background_color, background_gradient, accent_color,
                 font_style, layout, banner_image_url, profile_theme,
                 pinned_bulletin, bulletin_updated_at, interests,
                 background_photo_url, background_overlay_opacity,
                 profile_network_settings, profile_stickers,
                 pattern_type, pattern_color_primary, pattern_color_secondary,
                 pattern_scale, pattern_opacity`,
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
        // $18: new bg photo url (only if explicitly provided and non-null)
        (bgPhotoVal !== undefined && bgPhotoVal !== null) ? bgPhotoVal : null,
        // $19: explicit clear flag (true = set to NULL)
        (bgPhotoVal === undefined) ? false : (bgPhotoVal === null),
        background_overlay_opacity != null ? parseFloat(background_overlay_opacity) : null,
        profile_network_settings  != null ? JSON.stringify(profile_network_settings)  : null,
        profile_stickers          != null ? JSON.stringify(profile_stickers)           : null,
        pattern_type              ?? null,
        pattern_color_primary     ?? null,
        pattern_color_secondary   ?? null,
        pattern_scale             ?? null,
        pattern_opacity           != null ? parseFloat(pattern_opacity) : null,
        wall_privacy              ?? null,
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

// ── POST /api/profiles/upload-background ─────────────────────────────────────

router.post('/upload-background', authenticate, upload.single('background'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    const url = await uploadToR2(req.file.buffer, req.file.originalname, 'profile-backgrounds');

    // Delete old background from R2 if it was an R2 URL
    const existing = await pool.query('SELECT background_photo_url FROM users WHERE id = $1', [req.user.id]);
    const oldUrl = existing.rows[0]?.background_photo_url;
    if (oldUrl && !oldUrl.startsWith('/api/')) await deleteFromR2(oldUrl).catch(() => {});

    await pool.query(
      'UPDATE users SET background_photo_url = $1, updated_at = NOW() WHERE id = $2',
      [url, req.user.id]
    );
    res.json({ url });
  } catch (err) { next(err); }
});

// ── POST /api/profiles/upload-sticker ────────────────────────────────────────

router.post('/upload-sticker', authenticate, upload.single('sticker'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    if (req.file.size > 500 * 1024) return res.status(400).json({ error: 'Sticker must be under 500KB' });
    const url = await uploadToR2(req.file.buffer, req.file.originalname, 'profile-stickers');
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
router.post('/:username/wall', authenticate, upload.array('photos', 5), async (req, res, next) => {
  try {
    const { content = '', collage_layout = 'single' } = req.body;
    if (!content.trim() && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ error: 'Content or at least one photo is required' });
    }
    if (content.trim().length > 2000) return res.status(400).json({ error: 'Wall post max 2000 characters' });

    const uResult = await pool.query(
      'SELECT id, username, wall_privacy FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL',
      [req.params.username]
    );
    if (!uResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const profileUser = uResult.rows[0];

    // Privacy check
    if (profileUser.wall_privacy === 'disabled') {
      return res.status(403).json({ error: 'This wall is not accepting posts' });
    }
    if (profileUser.wall_privacy === 'network' && req.user.id !== profileUser.id) {
      const shared = await pool.query(
        `SELECT 1 FROM circle_members cm1
         JOIN circle_members cm2 ON cm2.circle_id = cm1.circle_id AND cm2.user_id = $2
         WHERE cm1.user_id = $1 LIMIT 1`,
        [req.user.id, profileUser.id]
      );
      if (!shared.rows.length) {
        return res.status(403).json({ error: 'Only network members can post on this wall' });
      }
    }

    // Upload photos to R2
    const photoUrls = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const url = await uploadToR2(file.buffer, file.originalname, 'wall-photos');
        photoUrls.push(url);
      }
    }

    const VALID_LAYOUTS = ['single','side_by_side','three','grid'];
    const layout = VALID_LAYOUTS.includes(collage_layout) ? collage_layout : 'single';

    const result = await pool.query(
      `INSERT INTO wall_posts (profile_user_id, author_id, content, photo_urls, collage_layout)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, content, photo_urls, is_pinned, collage_layout, created_at`,
      [profileUser.id, req.user.id, content.trim(), photoUrls, layout]
    );
    const wp = result.rows[0];

    // Notify profile owner if someone else posted
    if (req.user.id !== profileUser.id) {
      const ioLib = require('../lib/io');
      const notifMsg = `${req.user.username} posted on your wall`;
      pool.query(
        `INSERT INTO notifications (user_id, type, message, link) VALUES ($1, 'wall_post', $2, $3)`,
        [profileUser.id, notifMsg, `/profile/${profileUser.username}`]
      ).catch(() => {});
      ioLib.toUser(profileUser.id, 'notification', { type: 'wall_post', message: notifMsg, link: `/profile/${profileUser.username}` });
    }

    res.status(201).json({
      ...wp,
      author_id: req.user.id,
      author_username: req.user.username,
      author_verified: false,
      reply_count: 0,
    });
  } catch (err) { next(err); }
});

// PATCH /api/profiles/:username/wall/:postId/pin
router.patch('/:username/wall/:postId/pin', authenticate, async (req, res, next) => {
  try {
    const uResult = await pool.query(
      'SELECT id FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL',
      [req.params.username]
    );
    if (!uResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (req.user.id !== uResult.rows[0].id) return res.status(403).json({ error: 'Only the profile owner can pin posts' });

    const wp = await pool.query('SELECT id, is_pinned FROM wall_posts WHERE id = $1 AND profile_user_id = $2', [req.params.postId, uResult.rows[0].id]);
    if (!wp.rows[0]) return res.status(404).json({ error: 'Post not found' });

    const newPinned = !wp.rows[0].is_pinned;
    // Unpin all others first
    if (newPinned) {
      await pool.query('UPDATE wall_posts SET is_pinned = false WHERE profile_user_id = $1', [uResult.rows[0].id]);
    }
    const updated = await pool.query(
      'UPDATE wall_posts SET is_pinned = $1 WHERE id = $2 RETURNING *',
      [newPinned, req.params.postId]
    );
    res.json(updated.rows[0]);
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
      'SELECT board_type, position, is_visible, background_color, font_color, header_font_color, body_font_color FROM profile_board_settings WHERE user_id = $1 ORDER BY position ASC',
      [userId]
    );
    const savedSettings = settingsResult.rows;
    // Merge with defaults — any board not saved uses default
    const settingsMap = Object.fromEntries(savedSettings.map(s => [s.board_type, s]));
    const settings = DEFAULT_BOARDS.map(d => ({
      ...d, is_visible: true, background_color: null, font_color: null,
      header_font_color: null, body_font_color: null,
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
      `(SELECT 'post' AS activity_type, id AS ref_id, title AS label, type::text AS sub_type,
               NULL::text AS detail, created_at
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
        `INSERT INTO profile_board_settings (user_id, board_type, position, is_visible, background_color, font_color, header_font_color, body_font_color)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id, board_type) DO UPDATE
           SET position = $3, is_visible = $4, background_color = $5, font_color = $6,
               header_font_color = $7, body_font_color = $8`,
        [req.user.id, b.board_type, b.position ?? 0, b.is_visible ?? true,
         b.background_color || null, b.font_color || null,
         b.header_font_color || null, b.body_font_color || null]
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

// ── Professional board ────────────────────────────────────────────────────────

// GET /api/profiles/:username/professional
router.get('/:username/professional', async (req, res, next) => {
  try {
    const userRes = await pool.query(
      'SELECT id, username, verified, founding_member FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL',
      [req.params.username]
    );
    if (!userRes.rows[0]) return res.status(404).json({ error: 'User not found' });
    const u = userRes.rows[0];

    const [profRes, endorseRes] = await Promise.all([
      pool.query('SELECT * FROM user_professional_profiles WHERE user_id = $1', [u.id]),
      pool.query(
        `SELECT se.skill, se.endorser_id, eu.username AS endorser_username, eu.avatar_url AS endorser_avatar
         FROM skill_endorsements se
         JOIN users eu ON eu.id = se.endorser_id
         WHERE se.endorsed_id = $1`,
        [u.id]
      ),
    ]);

    const endorsementsBySkill = {};
    endorseRes.rows.forEach(e => {
      if (!endorsementsBySkill[e.skill]) endorsementsBySkill[e.skill] = [];
      endorsementsBySkill[e.skill].push({ id: e.endorser_id, username: e.endorser_username, avatar_url: e.endorser_avatar });
    });

    const prof = profRes.rows[0] || {};
    const affiliations = prof.business_affiliations || [];
    let bizDetails = [];
    if (affiliations.length) {
      const ids = affiliations.map(a => a.business_id).filter(Boolean);
      if (ids.length) {
        const br = await pool.query(
          'SELECT id, business_name, business_type, is_verified_local FROM businesses WHERE id = ANY($1) AND is_active = TRUE',
          [ids]
        );
        bizDetails = br.rows;
      }
    }
    const affiliationsWithDetails = affiliations.map(a => ({
      ...a,
      business: bizDetails.find(b => b.id === a.business_id) || null,
    }));

    res.json({
      user:                  u,
      profile:               prof,
      endorsements_by_skill: endorsementsBySkill,
      affiliations:          affiliationsWithDetails,
    });
  } catch (err) { next(err); }
});

// PATCH /api/profiles/professional — upsert professional profile (auth required)
router.patch('/professional', authenticate, async (req, res, next) => {
  try {
    const { occupation, skills, availability, professional_bio, portfolio_urls, business_affiliations } = req.body;
    const result = await pool.query(
      `INSERT INTO user_professional_profiles
         (user_id, occupation, skills, availability, professional_bio, portfolio_urls, business_affiliations)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET
         occupation            = COALESCE($2, user_professional_profiles.occupation),
         skills                = COALESCE($3::text[], user_professional_profiles.skills),
         availability          = COALESCE($4::availability_enum, user_professional_profiles.availability),
         professional_bio      = COALESCE($5, user_professional_profiles.professional_bio),
         portfolio_urls        = COALESCE($6::jsonb, user_professional_profiles.portfolio_urls),
         business_affiliations = COALESCE($7::jsonb, user_professional_profiles.business_affiliations),
         updated_at            = NOW()
       RETURNING *`,
      [
        req.user.id,
        occupation   || null,
        skills       || null,
        availability || null,
        professional_bio || null,
        portfolio_urls        != null ? JSON.stringify(portfolio_urls)        : null,
        business_affiliations != null ? JSON.stringify(business_affiliations) : null,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/profiles/endorse — endorse a skill on another member's profile
router.post('/endorse', authenticate, async (req, res, next) => {
  try {
    const { endorsed_username, skill } = req.body;
    if (!endorsed_username || !skill) return res.status(400).json({ error: 'endorsed_username and skill are required' });

    const target = await pool.query(
      'SELECT id FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL',
      [endorsed_username]
    );
    if (!target.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (target.rows[0].id === req.user.id) return res.status(400).json({ error: 'Cannot self-endorse' });

    const endorser = await pool.query('SELECT verified, founding_member FROM users WHERE id = $1', [req.user.id]);
    const e = endorser.rows[0];
    if (!e?.verified && !e?.founding_member) {
      return res.status(403).json({ error: 'Only verified members can endorse skills' });
    }

    const prof = await pool.query('SELECT skills FROM user_professional_profiles WHERE user_id = $1', [target.rows[0].id]);
    if (!prof.rows[0]?.skills?.includes(skill)) {
      return res.status(400).json({ error: 'That skill is not on their profile' });
    }

    const result = await pool.query(
      `INSERT INTO skill_endorsements (endorser_id, endorsed_id, skill)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *`,
      [req.user.id, target.rows[0].id, skill]
    );
    res.json({ endorsed: true, already_existed: !result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/profiles/endorse/:endorsedId/:skill — remove an endorsement
router.delete('/endorse/:endorsedId/:skill', authenticate, async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM skill_endorsements WHERE endorser_id = $1 AND endorsed_id = $2 AND skill = $3',
      [req.user.id, req.params.endorsedId, decodeURIComponent(req.params.skill)]
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
