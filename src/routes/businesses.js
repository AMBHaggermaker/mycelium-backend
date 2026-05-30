const express  = require('express');
const multer   = require('multer');
const pool     = require('../db');
const authenticate  = require('../middleware/auth');
const { uploadToR2, deleteFromR2 } = require('../lib/r2');
const ioLib    = require('../lib/io');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    cb(null, ['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype)),
});

const VALID_TYPES    = new Set(['independently_owned','locally_owned_franchise','cooperative','nonprofit','sole_proprietor']);
const VALID_CATS     = new Set(['construction','retail','food_beverage','healthcare','legal','creative','trades','technology','childcare','education','agriculture','other']);
const VALID_CONTACT  = new Set(['platform_message','phone','email']);

// ── Directory ─────────────────────────────────────────────────────────────────

// GET /api/businesses
router.get('/', async (req, res, next) => {
  try {
    const { category, type, search, limit = 24, offset = 0 } = req.query;
    const params = [];
    const conds  = ['b.is_active = TRUE'];

    if (category) { params.push(category); conds.push(`b.category = $${params.length}::business_category_enum`); }
    if (type)     { params.push(type);     conds.push(`b.business_type = $${params.length}::business_type_enum`); }
    if (search)   { params.push(`%${search}%`); conds.push(`(b.business_name ILIKE $${params.length} OR b.description ILIKE $${params.length})`); }

    params.push(parseInt(limit), parseInt(offset));
    const result = await pool.query(
      `SELECT b.id, b.business_name, b.business_type, b.category, b.location_label,
              b.description, b.is_verified_local, b.is_active, b.created_at,
              u.username AS owner_username, u.id AS owner_id,
              (SELECT url FROM business_photos WHERE business_id = b.id AND is_cover = TRUE LIMIT 1) AS cover_photo,
              (SELECT COUNT(*)::int FROM thread_messages tm
               JOIN threads t ON t.id = tm.thread_id
               WHERE t.business_id = b.id AND tm.parent_id IS NULL) AS recommendation_count
       FROM businesses b
       JOIN users u ON u.id = b.owner_id
       WHERE ${conds.join(' AND ')}
       ORDER BY b.is_verified_local DESC, b.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/businesses/recently-recommended
router.get('/recently-recommended', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.business_name, b.business_type, b.category, b.location_label,
              b.is_verified_local, u.username AS owner_username,
              (SELECT url FROM business_photos WHERE business_id = b.id AND is_cover = TRUE LIMIT 1) AS cover_photo,
              MAX(tm.created_at) AS last_recommendation_at,
              COUNT(DISTINCT tm.id)::int AS recent_count
       FROM businesses b
       JOIN users u ON u.id = b.owner_id
       JOIN threads t ON t.business_id = b.id
       JOIN thread_messages tm ON tm.thread_id = t.id AND tm.parent_id IS NULL
       WHERE b.is_active = TRUE AND tm.created_at > NOW() - INTERVAL '30 days'
       GROUP BY b.id, u.username
       ORDER BY MAX(tm.created_at) DESC
       LIMIT 6`
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── CRUD ──────────────────────────────────────────────────────────────────────

// POST /api/businesses
router.post('/', authenticate, async (req, res, next) => {
  try {
    const me = await pool.query('SELECT verified, founding_member, role FROM users WHERE id = $1', [req.user.id]);
    const u  = me.rows[0];
    if (!u?.verified && !u?.founding_member && u?.role === 'member') {
      return res.status(403).json({ error: 'Only verified members can create business pages' });
    }

    const { business_name, business_type, category, description, location_label, service_area,
            hours, contact_phone, contact_email, contact_preference, website_url } = req.body;
    if (!business_name?.trim())  return res.status(400).json({ error: 'business_name is required' });
    if (!VALID_TYPES.has(business_type)) return res.status(400).json({ error: 'Invalid business_type' });
    if (!VALID_CATS.has(category))       return res.status(400).json({ error: 'Invalid category' });

    const result = await pool.query(
      `INSERT INTO businesses
         (owner_id, business_name, business_type, category, description, location_label,
          service_area, hours, contact_phone, contact_email, contact_preference, website_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [req.user.id, business_name.trim(), business_type, category, description||null,
       location_label||null, service_area||null, hours||null, contact_phone||null,
       contact_email||null, contact_preference||'platform_message', website_url||null]
    );
    const biz = result.rows[0];

    // Create the recommendation thread scoped to this business
    await pool.query(
      `INSERT INTO threads (title, business_id, created_by) VALUES ($1, $2, $3)`,
      [`Community Recommendations — ${biz.business_name}`, biz.id, req.user.id]
    );

    ioLib.networkActivity('new_business', { business_name: biz.business_name, owner: req.user.username }, 'normal');
    res.status(201).json(biz);
  } catch (err) { next(err); }
});

// GET /api/businesses/:id
router.get('/:id', async (req, res, next) => {
  try {
    const bizRes = await pool.query(
      `SELECT b.*, u.username AS owner_username, u.id AS owner_id, u.avatar_url AS owner_avatar,
              u.verified AS owner_verified, u.founding_member AS owner_founding
       FROM businesses b
       JOIN users u ON u.id = b.owner_id
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!bizRes.rows[0]) return res.status(404).json({ error: 'Business not found' });
    const biz = bizRes.rows[0];

    const [photosRes, servicesRes, threadRes, postsRes, profRes] = await Promise.all([
      pool.query('SELECT * FROM business_photos WHERE business_id = $1 ORDER BY is_cover DESC, created_at ASC', [biz.id]),
      pool.query('SELECT * FROM business_services WHERE business_id = $1 ORDER BY created_at ASC', [biz.id]),
      pool.query(
        `SELECT t.id, t.title,
                COUNT(CASE WHEN tm.parent_id IS NULL THEN 1 END)::int AS recommendation_count
         FROM threads t
         LEFT JOIN thread_messages tm ON tm.thread_id = t.id
         WHERE t.business_id = $1
         GROUP BY t.id, t.title LIMIT 1`,
        [biz.id]
      ),
      pool.query(
        `SELECT p.id, p.title, p.type, p.category, p.created_at, u2.username
         FROM posts p JOIN users u2 ON u2.id = p.user_id
         WHERE p.business_id = $1 AND p.status = 'active'
         ORDER BY p.created_at DESC LIMIT 10`,
        [biz.id]
      ),
      pool.query(
        'SELECT occupation, skills FROM user_professional_profiles WHERE user_id = $1',
        [biz.owner_id]
      ),
    ]);

    res.json({
      ...biz,
      photos:                photosRes.rows,
      services:              servicesRes.rows,
      recommendation_thread: threadRes.rows[0] || null,
      posts:                 postsRes.rows,
      owner_professional:    profRes.rows[0] || null,
    });
  } catch (err) { next(err); }
});

// PATCH /api/businesses/:id
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const biz = await pool.query('SELECT owner_id FROM businesses WHERE id = $1', [req.params.id]);
    if (!biz.rows[0]) return res.status(404).json({ error: 'Business not found' });
    if (biz.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { business_name, business_type, category, description, location_label, service_area,
            hours, contact_phone, contact_email, contact_preference, website_url } = req.body;
    const result = await pool.query(
      `UPDATE businesses SET
         business_name      = COALESCE($1, business_name),
         business_type      = COALESCE($2::business_type_enum, business_type),
         category           = COALESCE($3::business_category_enum, category),
         description        = COALESCE($4, description),
         location_label     = COALESCE($5, location_label),
         service_area       = COALESCE($6, service_area),
         hours              = COALESCE($7, hours),
         contact_phone      = COALESCE($8, contact_phone),
         contact_email      = COALESCE($9, contact_email),
         contact_preference = COALESCE($10::contact_pref_enum, contact_preference),
         website_url        = COALESCE($11, website_url)
       WHERE id = $12 RETURNING *`,
      [business_name||null, business_type||null, category||null, description||null,
       location_label||null, service_area||null, hours||null, contact_phone||null,
       contact_email||null, contact_preference||null, website_url||null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/businesses/:id (soft-deactivate, owner only)
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const biz = await pool.query('SELECT owner_id FROM businesses WHERE id = $1', [req.params.id]);
    if (!biz.rows[0]) return res.status(404).json({ error: 'Business not found' });
    if (biz.rows[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await pool.query(
      'UPDATE businesses SET is_active = FALSE, deleted_at = NOW(), deleted_by = $1 WHERE id = $2',
      [req.user.id, req.params.id]
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── Photos ────────────────────────────────────────────────────────────────────

router.post('/:id/photos', authenticate, upload.single('photo'), async (req, res, next) => {
  try {
    const biz = await pool.query('SELECT owner_id FROM businesses WHERE id = $1', [req.params.id]);
    if (!biz.rows[0]) return res.status(404).json({ error: 'Business not found' });
    if (biz.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!req.file) return res.status(400).json({ error: 'No photo provided' });

    const url = await uploadToR2(req.file.buffer, req.file.originalname, 'businesses');
    if (req.body.is_cover === 'true') {
      await pool.query('UPDATE business_photos SET is_cover = FALSE WHERE business_id = $1', [req.params.id]);
    }
    const result = await pool.query(
      `INSERT INTO business_photos (business_id, url, caption, is_cover) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, url, req.body.caption||null, req.body.is_cover === 'true']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id/photos/:photoId', authenticate, async (req, res, next) => {
  try {
    const biz = await pool.query('SELECT owner_id FROM businesses WHERE id = $1', [req.params.id]);
    if (!biz.rows[0]) return res.status(404).json({ error: 'Business not found' });
    if (biz.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const photo = await pool.query(
      'DELETE FROM business_photos WHERE id = $1 AND business_id = $2 RETURNING url',
      [req.params.photoId, req.params.id]
    );
    if (!photo.rows[0]) return res.status(404).json({ error: 'Photo not found' });
    deleteFromR2(photo.rows[0].url).catch(() => {});
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── Services ──────────────────────────────────────────────────────────────────

router.post('/:id/services', authenticate, async (req, res, next) => {
  try {
    const biz = await pool.query('SELECT owner_id FROM businesses WHERE id = $1', [req.params.id]);
    if (!biz.rows[0]) return res.status(404).json({ error: 'Business not found' });
    if (biz.rows[0].owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const { name, description, price_range } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    const result = await pool.query(
      `INSERT INTO business_services (business_id, name, description, price_range) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, name.trim(), description||null, price_range||null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id/services/:svcId', authenticate, async (req, res, next) => {
  try {
    const biz = await pool.query('SELECT owner_id FROM businesses WHERE id = $1', [req.params.id]);
    if (!biz.rows[0]) return res.status(404).json({ error: 'Business not found' });
    if (biz.rows[0].owner_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM business_services WHERE id = $1 AND business_id = $2', [req.params.svcId, req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── Recommendations ───────────────────────────────────────────────────────────

router.get('/:id/recommendations', async (req, res, next) => {
  try {
    const thread = await pool.query('SELECT id FROM threads WHERE business_id = $1 LIMIT 1', [req.params.id]);
    if (!thread.rows[0]) return res.json({ messages: [] });
    const threadId = thread.rows[0].id;

    const msgs = await pool.query(
      `SELECT tm.id, tm.content, tm.created_at, tm.user_id,
              u.username, u.avatar_url, u.reliability_score, u.verified, u.founding_member
       FROM thread_messages tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.thread_id = $1 AND tm.parent_id IS NULL
       ORDER BY tm.created_at ASC`,
      [threadId]
    );
    const replies = await pool.query(
      `SELECT tm.id, tm.content, tm.created_at, tm.parent_id, tm.user_id,
              u.username, u.avatar_url
       FROM thread_messages tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.thread_id = $1 AND tm.parent_id IS NOT NULL
       ORDER BY tm.created_at ASC`,
      [threadId]
    );
    const replyMap = {};
    replies.rows.forEach(r => {
      if (!replyMap[r.parent_id]) replyMap[r.parent_id] = [];
      replyMap[r.parent_id].push(r);
    });
    res.json({ thread_id: threadId, messages: msgs.rows.map(m => ({ ...m, replies: replyMap[m.id] || [] })) });
  } catch (err) { next(err); }
});

router.post('/:id/recommendations', authenticate, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required' });

    const me = await pool.query('SELECT verified, founding_member, role FROM users WHERE id = $1', [req.user.id]);
    const u  = me.rows[0];
    if (!u?.verified && !u?.founding_member && u?.role === 'member') {
      return res.status(403).json({ error: 'Only verified members can post recommendations' });
    }

    const biz = await pool.query('SELECT owner_id FROM businesses WHERE id = $1 AND is_active = TRUE', [req.params.id]);
    if (!biz.rows[0]) return res.status(404).json({ error: 'Business not found' });
    if (biz.rows[0].owner_id === req.user.id) return res.status(400).json({ error: 'Cannot recommend your own business' });

    const thread = await pool.query('SELECT id FROM threads WHERE business_id = $1 LIMIT 1', [req.params.id]);
    if (!thread.rows[0]) return res.status(404).json({ error: 'Recommendation thread not found' });

    const already = await pool.query(
      'SELECT id FROM thread_messages WHERE thread_id = $1 AND user_id = $2 AND parent_id IS NULL',
      [thread.rows[0].id, req.user.id]
    );
    if (already.rows[0]) return res.status(409).json({ error: 'You have already recommended this business' });

    const result = await pool.query(
      `INSERT INTO thread_messages (thread_id, user_id, content) VALUES ($1,$2,$3) RETURNING *`,
      [thread.rows[0].id, req.user.id, content.trim()]
    );
    ioLib.networkActivity('new_recommendation', { business_id: req.params.id, business_name: biz.rows[0].business_name }, 'normal');

    const full = await pool.query(
      `SELECT tm.*, u2.username, u2.avatar_url, u2.reliability_score, u2.verified, u2.founding_member
       FROM thread_messages tm JOIN users u2 ON u2.id = tm.user_id WHERE tm.id = $1`,
      [result.rows[0].id]
    );
    res.status(201).json({ ...full.rows[0], replies: [] });
  } catch (err) { next(err); }
});

// Owner reply to a recommendation
router.post('/:id/recommendations/:msgId/reply', authenticate, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required' });

    const biz = await pool.query('SELECT owner_id FROM businesses WHERE id = $1', [req.params.id]);
    if (!biz.rows[0]) return res.status(404).json({ error: 'Business not found' });
    if (biz.rows[0].owner_id !== req.user.id) return res.status(403).json({ error: 'Only the business owner can reply' });

    const thread = await pool.query('SELECT id FROM threads WHERE business_id = $1 LIMIT 1', [req.params.id]);
    if (!thread.rows[0]) return res.status(404).json({ error: 'Thread not found' });

    const parent = await pool.query(
      'SELECT id FROM thread_messages WHERE id = $1 AND thread_id = $2 AND parent_id IS NULL',
      [req.params.msgId, thread.rows[0].id]
    );
    if (!parent.rows[0]) return res.status(404).json({ error: 'Recommendation not found' });

    const result = await pool.query(
      `INSERT INTO thread_messages (thread_id, user_id, content, parent_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [thread.rows[0].id, req.user.id, content.trim(), req.params.msgId]
    );
    const full = await pool.query(
      `SELECT tm.*, u.username, u.avatar_url FROM thread_messages tm JOIN users u ON u.id = tm.user_id WHERE tm.id = $1`,
      [result.rows[0].id]
    );
    res.status(201).json(full.rows[0]);
  } catch (err) { next(err); }
});

// Admin delete recommendation (or reply)
router.delete('/:id/recommendations/:msgId', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'moderator') return res.status(403).json({ error: 'Admin only' });
    const thread = await pool.query('SELECT id FROM threads WHERE business_id = $1 LIMIT 1', [req.params.id]);
    if (!thread.rows[0]) return res.status(404).json({ error: 'Thread not found' });
    const del = await pool.query(
      'DELETE FROM thread_messages WHERE id = $1 AND thread_id = $2 RETURNING id',
      [req.params.msgId, thread.rows[0].id]
    );
    if (!del.rows[0]) return res.status(404).json({ error: 'Message not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// PATCH /api/businesses/:id/page-settings — save business page customization
router.patch('/:id/page-settings', authenticate, async (req, res, next) => {
  try {
    const biz = await pool.query('SELECT owner_id FROM businesses WHERE id = $1', [req.params.id]);
    if (!biz.rows[0]) return res.status(404).json({ error: 'Business not found' });
    if (biz.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const allowed = ['accent', 'font', 'pattern_type', 'pattern_color_primary', 'pattern_color_secondary', 'pattern_scale', 'background_color'];
    const settings = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const result = await pool.query(
      `UPDATE businesses SET page_settings = COALESCE(page_settings, '{}') || $1::jsonb WHERE id = $2 RETURNING page_settings`,
      [JSON.stringify(settings), req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/businesses/:id/banner — upload business page banner
const bizBannerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg','image/png','image/webp'].includes(file.mimetype)) });

router.post('/:id/banner', authenticate, bizBannerUpload.single('banner'), async (req, res, next) => {
  try {
    const biz = await pool.query('SELECT owner_id FROM businesses WHERE id = $1', [req.params.id]);
    if (!biz.rows[0]) return res.status(404).json({ error: 'Business not found' });
    if (biz.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });

    const folder = `businesses/${req.params.id}/banner`;
    const r2Url = await uploadToR2(file.buffer, 'banner.jpg', folder);
    await pool.query('UPDATE businesses SET banner_url = $1 WHERE id = $2', [r2Url, req.params.id]);
    res.json({ banner_url: r2Url });
  } catch (err) { next(err); }
});

// GET /api/businesses/owner/:userId — businesses owned by a user
router.get('/owner/:userId', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.business_name, b.business_type, b.category, b.location_label,
              b.is_verified_local, b.is_active, b.created_at,
              (SELECT url FROM business_photos WHERE business_id = b.id AND is_cover = TRUE LIMIT 1) AS cover_photo
       FROM businesses b
       WHERE b.owner_id = $1
       ORDER BY b.is_active DESC, b.created_at DESC`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

module.exports = router;
