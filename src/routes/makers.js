const express      = require('express');
const multer       = require('multer');
const path         = require('path');
const crypto       = require('crypto');
const router       = express.Router();
const pool         = require('../db');
const authenticate = require('../middleware/auth');
const { uploadToR2 } = require('../lib/r2');
const Stripe       = require('stripe');

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://mycelium.unprecedentedtimes.org';

const FOUNDER_USERNAME = 'AMBHaggermaker';

const TIER_QUOTAS = {
  free:     100  * 1024 * 1024,
  basic:    1024 * 1024 * 1024,
  standard: 5  * 1024 * 1024 * 1024,
  pro:      20 * 1024 * 1024 * 1024,
};

const TIER_FILE_LIMITS = {
  free:     { audio: 0,                        video: 0,                         image: 10  * 1024 * 1024 },
  basic:    { audio: 50  * 1024 * 1024,        video: 0,                         image: 10  * 1024 * 1024 },
  standard: { audio: 200 * 1024 * 1024,        video: 500  * 1024 * 1024,        image: 25  * 1024 * 1024 },
  pro:      { audio: 1024 * 1024 * 1024,       video: 2    * 1024 * 1024 * 1024, image: 50  * 1024 * 1024 },
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2.2 * 1024 * 1024 * 1024 }, // 2.2 GB hard limit (covers Pro 2GB video)
});

function workTypeFromMime(mime) {
  if (!mime) return 'other';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || mime.startsWith('text/')) return 'document';
  return 'other';
}

async function getMakerProfile(userId) {
  const r = await pool.query('SELECT * FROM maker_profiles WHERE user_id = $1', [userId]);
  return r.rows[0] || null;
}

// GET /api/makers — list all makers (directory)
router.get('/', async (req, res, next) => {
  try {
    const { category, search, limit = 50, offset = 0 } = req.query;
    const conditions = ["mp.storage_tier != 'free'"];
    const params     = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(mp.maker_name ILIKE $${params.length} OR mp.bio ILIKE $${params.length})`);
    }
    if (category) {
      params.push(category);
      conditions.push(`$${params.length} = ANY(mp.specialties)`);
    }

    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(
      `SELECT mp.id, mp.maker_name, mp.bio, mp.specialties, mp.storage_tier, mp.created_at,
              u.username, u.avatar_url,
              (SELECT json_build_object('id', mw.id, 'title', mw.title, 'work_type', mw.work_type,
                                        'r2_url', mw.r2_url, 'preview_r2_url', mw.preview_r2_url,
                                        'play_count', mw.play_count)
               FROM maker_works mw WHERE mw.maker_id = mp.id
               ORDER BY mw.created_at DESC LIMIT 1) AS featured_work,
              (SELECT COUNT(*) FROM maker_works mw2 WHERE mw2.maker_id = mp.id)::int AS work_count
       FROM maker_profiles mp
       JOIN users u ON u.id = mp.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY mp.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (e) { next(e); }
});

// GET /api/makers/my-profile — current user's maker profile
router.get('/my-profile', authenticate, async (req, res, next) => {
  try {
    const maker = await getMakerProfile(req.user.id);
    if (!maker) return res.status(404).json({ error: 'No maker profile' });
    const quota = TIER_QUOTAS[maker.storage_tier] || TIER_QUOTAS.free;
    res.json({ ...maker, quota_bytes: quota, quota_used_pct: maker.storage_used_bytes / quota });
  } catch (e) { next(e); }
});

// GET /api/makers/works — list works with filters
router.get('/works', async (req, res, next) => {
  try {
    const { category, work_type, maker_id, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params     = [];

    if (category)  { params.push(category);  conditions.push(`mw.category = $${params.length}`); }
    if (work_type) { params.push(work_type); conditions.push(`mw.work_type = $${params.length}`); }
    if (maker_id)  { params.push(parseInt(maker_id)); conditions.push(`mw.maker_id = $${params.length}`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(
      `SELECT mw.*, mp.maker_name, u.username, u.avatar_url
       FROM maker_works mw
       JOIN maker_profiles mp ON mp.id = mw.maker_id
       JOIN users u ON u.id = mp.user_id
       ${where}
       ORDER BY mw.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (e) { next(e); }
});

// GET /api/makers/:username — maker profile by username
router.get('/:username', async (req, res, next) => {
  try {
    const userResult = await pool.query(
      'SELECT id, username, avatar_url, bio FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL',
      [req.params.username]
    );
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const u = userResult.rows[0];

    const makerResult = await pool.query(
      'SELECT * FROM maker_profiles WHERE user_id = $1',
      [u.id]
    );
    if (!makerResult.rows[0]) return res.status(404).json({ error: 'No maker profile' });
    const maker = makerResult.rows[0];

    const works = await pool.query(
      `SELECT * FROM maker_works WHERE maker_id = $1 ORDER BY created_at DESC`,
      [maker.id]
    );

    const quota = TIER_QUOTAS[maker.storage_tier] || TIER_QUOTAS.free;
    res.json({ maker: { ...maker, quota_bytes: quota }, user: u, works: works.rows });
  } catch (e) { next(e); }
});

// POST /api/makers/works/upload — upload a work to R2
router.post('/works/upload', authenticate, upload.single('file'), async (req, res, next) => {
  try {
    const isFounder = req.user.username === FOUNDER_USERNAME;
    const maker = await getMakerProfile(req.user.id);
    if (!maker) return res.status(403).json({ error: 'You need a maker profile to upload' });

    // Founder gets permanent Pro access regardless of subscription state
    const effectiveTier = isFounder ? 'pro' : maker.storage_tier;
    if (effectiveTier === 'free') return res.status(403).json({ error: 'Upgrade to a paid tier to upload works' });

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });

    const work_type = workTypeFromMime(file.mimetype);
    const tierLimits = TIER_FILE_LIMITS[effectiveTier] || TIER_FILE_LIMITS.free;
    const typeLimit  = tierLimits[work_type] ?? tierLimits.image;

    if (typeLimit === 0) return res.status(403).json({ error: `Your tier does not support ${work_type} uploads` });
    if (file.size > typeLimit) return res.status(400).json({ error: `File exceeds ${Math.round(typeLimit / 1024 / 1024)}MB limit for your tier` });

    const quota = TIER_QUOTAS[effectiveTier] || TIER_QUOTAS.free;
    if (!isFounder && maker.storage_used_bytes + file.size > quota) {
      return res.status(400).json({ error: 'Storage quota exceeded. Upgrade your tier or remove existing works.' });
    }

    const { title, description, category, is_free = true, price = 0, tags = '[]', license = 'all_rights_reserved' } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
    if (!category?.trim()) return res.status(400).json({ error: 'Category required' });

    const uuid = crypto.randomUUID();
    const folder = `makers/${req.user.id}/works/${uuid}`;
    const r2Path = await uploadToR2(file.buffer, file.originalname, folder);
    const r2_key = r2Path.replace('/api/media/', '');

    // For audio, store full file URL as preview (no ffmpeg on server)
    const preview_r2_key = work_type === 'audio' ? r2_key : null;
    const preview_r2_url = work_type === 'audio' ? r2Path : null;

    const parsedTags = (() => { try { return JSON.parse(tags); } catch { return []; } })();
    const isFreeVal  = is_free === 'true' || is_free === true;
    const priceVal   = isFreeVal ? 0 : parseFloat(price) || 0;

    // Check title against known copyrighted works list
    const knownMatch = await pool.query(
      'SELECT id FROM known_copyrighted_titles WHERE lower(title) = lower($1)',
      [title.trim()]
    );
    const autoFlagged = knownMatch.rows.length > 0;

    const result = await pool.query(
      `INSERT INTO maker_works
         (maker_id, title, description, category, work_type, r2_key, r2_url,
          file_size_bytes, is_free, price, preview_r2_key, preview_r2_url, tags, license, copyright_flagged)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [maker.id, title.trim(), description || null, category, work_type, r2_key, r2Path,
       file.size, isFreeVal, priceVal, preview_r2_key, preview_r2_url, parsedTags, license, autoFlagged]
    );

    // Update storage used
    await pool.query(
      'UPDATE maker_profiles SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2',
      [file.size, maker.id]
    );

    // Broadcast to activity feed (only if not auto-flagged)
    if (!autoFlagged) {
      try {
        const ioLib = require('../lib/io');
        ioLib.networkActivity('maker_upload', {
          message: `New work by ${maker.maker_name}: ${title.trim()}`,
          work_id: result.rows[0].id,
        });
      } catch { /* non-fatal */ }
    }

    res.status(201).json({ ...result.rows[0], copyright_flagged: autoFlagged });
  } catch (e) { next(e); }
});

// POST /api/makers/works/:id/play — record a play and increment count
router.post('/works/:id/play', async (req, res, next) => {
  try {
    const { duration_seconds, completed, session_id } = req.body;
    await pool.query('UPDATE maker_works SET play_count = play_count + 1 WHERE id = $1', [req.params.id]);

    // Optional auth — record listener if logged in
    let listenerId = null;
    try {
      const jwt = require('jsonwebtoken');
      const hdr = req.headers.authorization?.split(' ')[1];
      if (hdr) listenerId = jwt.verify(hdr, process.env.JWT_SECRET || 'mycelium_jwt_secret_change_in_production').id;
    } catch { /* anonymous */ }

    await pool.query(
      `INSERT INTO maker_work_plays (work_id, listener_id, session_id, play_duration_seconds, completed)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, listenerId, session_id || null,
       duration_seconds ? parseInt(duration_seconds) : 0,
       completed === true]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/makers/:username/metrics — maker's own metrics dashboard (owner + admin only)
router.get('/:username/metrics', authenticate, async (req, res, next) => {
  try {
    const userResult = await pool.query(
      'SELECT id, username FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL',
      [req.params.username]
    );
    if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });
    const targetUser = userResult.rows[0];

    const isOwner = req.user.id === targetUser.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Metrics are private' });

    const makerResult = await pool.query(
      'SELECT * FROM maker_profiles WHERE user_id = $1', [targetUser.id]
    );
    if (!makerResult.rows[0]) return res.status(404).json({ error: 'No maker profile' });
    const maker = makerResult.rows[0];

    const works = await pool.query(
      'SELECT id, title, work_type, play_count, duration_seconds FROM maker_works WHERE maker_id = $1 ORDER BY created_at DESC',
      [maker.id]
    );
    const workIds = works.rows.map(w => w.id);

    if (workIds.length === 0) {
      return res.json({
        works: [],
        totals: { total_plays: 0, unique_listeners: 0, avg_completion_rate: 0, total_downloads: 0, commission_requests: 0 },
        time_series: [],
        geographic: [],
        most_played: null,
        most_completed: null,
      });
    }

    const [playsAgg, downloadsAgg, commissions, timeSeries, mostPlayed, mostCompleted] = await Promise.all([
      // Per-work play stats
      pool.query(
        `SELECT
           work_id,
           COUNT(*)::int                                           AS total_plays,
           COUNT(DISTINCT listener_id)::int                       AS unique_listeners,
           COUNT(DISTINCT CASE WHEN listener_id IS NOT NULL AND
             (SELECT COUNT(*) FROM maker_work_plays p2 WHERE p2.work_id = mwp.work_id AND p2.listener_id = mwp.listener_id) > 1
             THEN listener_id END)::int                           AS return_listeners,
           ROUND(100.0 * SUM(CASE WHEN completed THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0), 1) AS completion_rate
         FROM maker_work_plays mwp
         WHERE work_id = ANY($1)
         GROUP BY work_id`,
        [workIds]
      ),
      // Per-work download counts
      pool.query(
        `SELECT work_id, COUNT(*)::int AS download_count FROM maker_work_downloads WHERE work_id = ANY($1) GROUP BY work_id`,
        [workIds]
      ),
      // Commission requests
      pool.query(
        `SELECT COUNT(*)::int AS total FROM maker_commissions WHERE maker_id = $1`, [maker.id]
      ),
      // 30-day time series
      pool.query(
        `SELECT DATE(created_at)::text AS date, COUNT(*)::int AS plays
         FROM maker_work_plays WHERE work_id = ANY($1) AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY DATE(created_at) ORDER BY date`,
        [workIds]
      ),
      // Most played work
      pool.query(
        `SELECT w.id, w.title, COUNT(*)::int AS plays FROM maker_work_plays p JOIN maker_works w ON w.id = p.work_id
         WHERE w.maker_id = $1 GROUP BY w.id, w.title ORDER BY plays DESC LIMIT 1`, [maker.id]
      ),
      // Most completed work
      pool.query(
        `SELECT w.id, w.title,
           ROUND(100.0 * SUM(CASE WHEN p.completed THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*),0),1) AS completion_rate
         FROM maker_work_plays p JOIN maker_works w ON w.id = p.work_id
         WHERE w.maker_id = $1 AND COUNT(*) > 0
         GROUP BY w.id, w.title HAVING COUNT(*) >= 5 ORDER BY completion_rate DESC LIMIT 1`, [maker.id]
      ),
    ]);

    const playsMap     = Object.fromEntries(playsAgg.rows.map(r => [r.work_id, r]));
    const downloadsMap = Object.fromEntries(downloadsAgg.rows.map(r => [r.work_id, r.download_count]));

    const worksWithStats = works.rows.map(w => ({
      ...w,
      total_plays:       playsMap[w.id]?.total_plays       || 0,
      unique_listeners:  playsMap[w.id]?.unique_listeners  || 0,
      return_listeners:  playsMap[w.id]?.return_listeners  || 0,
      completion_rate:   playsMap[w.id]?.completion_rate   || 0,
      download_count:    downloadsMap[w.id]                || 0,
    }));

    const totalPlays    = worksWithStats.reduce((s, w) => s + w.total_plays, 0);
    const totalDownloads= worksWithStats.reduce((s, w) => s + w.download_count, 0);
    const uniqueSet     = await pool.query(
      `SELECT COUNT(DISTINCT listener_id)::int AS total FROM maker_work_plays WHERE work_id = ANY($1) AND listener_id IS NOT NULL`,
      [workIds]
    );
    const avgCompletion = worksWithStats.length
      ? Math.round(worksWithStats.reduce((s, w) => s + Number(w.completion_rate), 0) / worksWithStats.length)
      : 0;

    res.json({
      works: worksWithStats,
      totals: {
        total_plays:        totalPlays,
        unique_listeners:   uniqueSet.rows[0]?.total || 0,
        avg_completion_rate: avgCompletion,
        total_downloads:    totalDownloads,
        commission_requests: commissions.rows[0]?.total || 0,
      },
      time_series:   timeSeries.rows,
      most_played:   mostPlayed.rows[0] || null,
      most_completed:mostCompleted.rows[0] || null,
    });
  } catch (e) { next(e); }
});

// GET /api/makers/works/:id — single work detail
router.get('/works/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT mw.*, mp.maker_name, mp.bio AS maker_bio, mp.storage_tier,
              u.username, u.avatar_url
       FROM maker_works mw
       JOIN maker_profiles mp ON mp.id = mw.maker_id
       JOIN users u ON u.id = mp.user_id
       WHERE mw.id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Work not found' });
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});

// POST /api/makers/commissions — request a commission
router.post('/commissions', authenticate, async (req, res, next) => {
  try {
    const { maker_id, description, budget } = req.body;
    if (!maker_id || !description?.trim()) return res.status(400).json({ error: 'maker_id and description required' });

    const result = await pool.query(
      `INSERT INTO maker_commissions (requester_id, maker_id, description, budget)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, parseInt(maker_id), description.trim(), budget ? parseFloat(budget) : null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { next(e); }
});

// POST /api/makers/profile — create or update maker profile
router.post('/profile', authenticate, async (req, res, next) => {
  try {
    const { maker_name, bio, specialties = [] } = req.body;
    if (!maker_name?.trim()) return res.status(400).json({ error: 'Maker name required' });

    const existing = await getMakerProfile(req.user.id);
    if (existing) {
      const result = await pool.query(
        `UPDATE maker_profiles SET maker_name = $1, bio = $2, specialties = $3 WHERE user_id = $4 RETURNING *`,
        [maker_name.trim(), bio || null, specialties, req.user.id]
      );
      return res.json(result.rows[0]);
    }

    const result = await pool.query(
      `INSERT INTO maker_profiles (user_id, maker_name, bio, specialties) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, maker_name.trim(), bio || null, specialties]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { next(e); }
});

// PATCH /api/makers/:username/page-settings — save maker page customization
router.patch('/:username/page-settings', authenticate, async (req, res, next) => {
  try {
    const userRes = await pool.query(
      'SELECT id FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL',
      [req.params.username]
    );
    if (!userRes.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (userRes.rows[0].id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const allowed = ['accent', 'font', 'pattern_type', 'pattern_color_primary', 'pattern_color_secondary', 'pattern_scale', 'background_color'];
    const settings = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const result = await pool.query(
      `UPDATE maker_profiles SET page_settings = COALESCE(page_settings, '{}') || $1::jsonb WHERE user_id = $2 RETURNING page_settings`,
      [JSON.stringify(settings), req.user.id]
    );
    res.json(result.rows[0]);
  } catch (e) { next(e); }
});

// POST /api/makers/:username/banner — upload maker page banner image
const bannerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg','image/png','image/webp'].includes(file.mimetype)) });

router.post('/:username/banner', authenticate, bannerUpload.single('banner'), async (req, res, next) => {
  try {
    const userRes = await pool.query(
      'SELECT id FROM users WHERE lower(username) = lower($1) AND deleted_at IS NULL',
      [req.params.username]
    );
    if (!userRes.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (userRes.rows[0].id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });

    const folder = `makers/${req.user.id}/banner`;
    const r2Url = await uploadToR2(file.buffer, 'banner.jpg', folder);
    await pool.query('UPDATE maker_profiles SET banner_url = $1 WHERE user_id = $2', [r2Url, req.user.id]);
    res.json({ banner_url: r2Url });
  } catch (e) { next(e); }
});

// POST /api/makers/subscribe — create Stripe subscription for a tier
router.post('/subscribe', authenticate, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Payment not configured' });
    const { tier } = req.body;

    const priceIds = {
      basic:    process.env.STRIPE_MAKER_BASIC_PRICE_ID,
      standard: process.env.STRIPE_MAKER_STANDARD_PRICE_ID,
      pro:      process.env.STRIPE_MAKER_PRO_PRICE_ID,
    };
    const priceId = priceIds[tier];
    if (!priceId || priceId.startsWith('price_REPLACE')) {
      return res.status(503).json({ error: 'This tier is not yet configured. Please contact the platform admin.' });
    }

    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${APP_BASE_URL}/makers/upload`,
      cancel_url:  `${APP_BASE_URL}/makers/upload`,
      customer_email: userResult.rows[0]?.email,
      metadata: { user_id: String(req.user.id), tier },
    });
    res.json({ checkout_url: session.url });
  } catch (e) { next(e); }
});

module.exports = router;
