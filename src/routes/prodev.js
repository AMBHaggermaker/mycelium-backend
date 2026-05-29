const express      = require('express');
const router       = express.Router();
const pool         = require('../db');
const authenticate = require('../middleware/auth');
const Stripe       = require('stripe');

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://mycelium.unprecedentedtimes.org';

// GET /api/prodev/courses — list with optional filters
router.get('/courses', async (req, res, next) => {
  try {
    const { category, skill_level, format, search, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params     = [];

    if (category)    { params.push(category);    conditions.push(`c.category = $${params.length}`); }
    if (skill_level) { params.push(skill_level); conditions.push(`c.skill_level = $${params.length}`); }
    if (format)      { params.push(format);      conditions.push(`c.format = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(c.title ILIKE $${params.length} OR c.description ILIKE $${params.length})`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(
      `SELECT c.id, c.title, c.description, c.category, c.skill_level, c.format,
              c.price, c.is_free, c.duration_minutes, c.tags, c.enrollment_count, c.created_at,
              u.username AS instructor_username, u.avatar_url AS instructor_avatar
       FROM pro_dev_courses c
       LEFT JOIN users u ON u.id = c.instructor_id
       ${where}
       ORDER BY c.enrollment_count DESC, c.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (e) { next(e); }
});

// GET /api/prodev/courses/:id — course detail with resources
router.get('/courses/:id', async (req, res, next) => {
  try {
    const courseResult = await pool.query(
      `SELECT c.*, u.username AS instructor_username, u.avatar_url AS instructor_avatar, u.bio AS instructor_bio
       FROM pro_dev_courses c
       LEFT JOIN users u ON u.id = c.instructor_id
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!courseResult.rows[0]) return res.status(404).json({ error: 'Course not found' });

    const resources = await pool.query(
      `SELECT id, title, resource_type, url, r2_key, created_at
       FROM pro_dev_resources WHERE course_id = $1 ORDER BY created_at`,
      [req.params.id]
    );

    res.json({ ...courseResult.rows[0], resources: resources.rows });
  } catch (e) { next(e); }
});

// POST /api/prodev/courses — create (verified members only)
router.post('/courses', authenticate, async (req, res, next) => {
  try {
    const userResult = await pool.query('SELECT verified FROM users WHERE id = $1', [req.user.id]);
    if (!userResult.rows[0]?.verified && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only verified members can create courses' });
    }

    const { title, description, category, skill_level = 'beginner', format = 'written',
            price = 0, duration_minutes, tags = [] } = req.body;

    if (!title?.trim()) return res.status(400).json({ error: 'Title required' });
    if (!category?.trim()) return res.status(400).json({ error: 'Category required' });

    const result = await pool.query(
      `INSERT INTO pro_dev_courses
         (title, description, category, skill_level, instructor_id, format, price, is_free, duration_minutes, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [title.trim(), description || null, category, skill_level, req.user.id,
       format, parseFloat(price) || 0, parseFloat(price) === 0, duration_minutes || null, tags]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { next(e); }
});

// POST /api/prodev/courses/:id/enroll
router.post('/courses/:id/enroll', authenticate, async (req, res, next) => {
  try {
    const courseResult = await pool.query('SELECT * FROM pro_dev_courses WHERE id = $1', [req.params.id]);
    if (!courseResult.rows[0]) return res.status(404).json({ error: 'Course not found' });
    const course = courseResult.rows[0];

    // Check already enrolled
    const existing = await pool.query(
      'SELECT id FROM pro_dev_enrollments WHERE user_id = $1 AND course_id = $2',
      [req.user.id, course.id]
    );
    if (existing.rows[0]) return res.json({ enrolled: true, already: true });

    if (!course.is_free && course.price > 0) {
      // Create Stripe checkout session for paid course
      if (!stripe) return res.status(503).json({ error: 'Payment not configured' });
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(course.price * 100),
            product_data: { name: course.title, description: course.description?.slice(0, 200) },
          },
          quantity: 1,
        }],
        success_url: `${APP_BASE_URL}/learn/${course.id}?enrolled=1`,
        cancel_url:  `${APP_BASE_URL}/learn/${course.id}`,
        metadata: { course_id: String(course.id), user_id: String(req.user.id) },
      });
      return res.json({ checkout_url: session.url });
    }

    // Free enroll
    await pool.query(
      'INSERT INTO pro_dev_enrollments (user_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.user.id, course.id]
    );
    await pool.query(
      'UPDATE pro_dev_courses SET enrollment_count = enrollment_count + 1 WHERE id = $1',
      [course.id]
    );
    res.json({ enrolled: true });
  } catch (e) { next(e); }
});

// GET /api/prodev/my-courses
router.get('/my-courses', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.title, c.category, c.skill_level, c.format, c.duration_minutes,
              c.is_free, c.price, c.tags, c.enrollment_count,
              u.username AS instructor_username, u.avatar_url AS instructor_avatar,
              e.enrolled_at, e.completed_at
       FROM pro_dev_enrollments e
       JOIN pro_dev_courses c ON c.id = e.course_id
       LEFT JOIN users u ON u.id = c.instructor_id
       WHERE e.user_id = $1
       ORDER BY e.enrolled_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) { next(e); }
});

module.exports = router;
