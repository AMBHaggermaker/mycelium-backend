const express      = require('express');
const pool         = require('../db');
const authenticate = require('../middleware/auth');
const requireRole  = require('../middleware/requireRole');
const Anthropic    = require('@anthropic-ai/sdk');

const router = express.Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentPeriod() {
  const now = new Date();
  const year = now.getFullYear();
  const half = now.getMonth() < 6 ? 'H1' : 'H2';
  return `${year}-${half}`;
}

// ── Bills ─────────────────────────────────────────────────────────────────────

// GET /api/legislature/bills?level=&topic=&status=&limit=
router.get('/bills', async (req, res, next) => {
  try {
    const { level, topic, status, limit = 50 } = req.query;
    const params = [];
    const conditions = [];

    if (level) {
      params.push(level);
      conditions.push(`b.level = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`b.status = $${params.length}`);
    }
    if (topic) {
      params.push(`{${topic}}`);
      conditions.push(`b.topic_tags && $${params.length}::text[]`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit, 10) || 50);

    const { rows } = await pool.query(
      `SELECT
         b.*,
         COALESCE(
           json_agg(
             json_build_object(
               'vote',            rv.vote,
               'rep_id',          r.id,
               'rep_name',        r.name,
               'rep_party',       r.party,
               'rep_chamber',     r.chamber
             )
           ) FILTER (WHERE rv.id IS NOT NULL),
           '[]'
         ) AS votes
       FROM bills b
       LEFT JOIN representative_votes rv ON rv.bill_id = b.id
       LEFT JOIN representatives r ON r.id = rv.representative_id
       ${where}
       GROUP BY b.id
       ORDER BY b.last_action_date DESC NULLS LAST, b.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/legislature/bills  (admin)
router.post('/bills', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const {
      source, bill_number, title, summary, status, topic_tags,
      last_action, last_action_date, level, source_url, state,
    } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO bills
         (source, bill_number, title, summary, status, topic_tags,
          last_action, last_action_date, level, source_url, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        source || 'manual', bill_number, title, summary || null,
        status || 'introduced',
        topic_tags ? (Array.isArray(topic_tags) ? topic_tags : [topic_tags]) : [],
        last_action || null, last_action_date || null,
        level || 'state', source_url || null, state || 'AL',
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/legislature/bills/:id/ai-summary  (admin)
router.post('/bills/:id/ai-summary', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query('SELECT * FROM bills WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Bill not found' });

    const bill = rows[0];
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const client = new Anthropic({ apiKey });
    const prompt = `Summarize this legislation in 2-3 plain English sentences for community members who are not lawyers. Focus on what it would actually do, who it affects, and any concerns. Bill: ${bill.title}. Summary from official source: ${bill.summary || 'No official summary available.'}`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const aiSummary = message.content[0]?.text?.trim() || '';
    const { rows: updated } = await pool.query(
      'UPDATE bills SET ai_summary = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [aiSummary, id]
    );
    res.json(updated[0]);
  } catch (err) {
    next(err);
  }
});

// ── Representatives ───────────────────────────────────────────────────────────

// GET /api/legislature/representatives?level=&chamber=
router.get('/representatives', async (req, res, next) => {
  try {
    const { level, chamber } = req.query;
    const params = [];
    const conditions = [];

    if (level) {
      params.push(level);
      conditions.push(`level = $${params.length}`);
    }
    if (chamber) {
      params.push(chamber);
      conditions.push(`chamber = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT
         r.*,
         ROUND(AVG(cr.rating), 1) AS avg_rating,
         COUNT(cr.id)::int        AS rating_count
       FROM representatives r
       LEFT JOIN community_ratings cr ON cr.representative_id = r.id
       ${where}
       GROUP BY r.id
       ORDER BY r.level, r.chamber, r.name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/legislature/representatives  (admin)
router.post('/representatives', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    const {
      name, level, chamber, district, party, photo_url, state,
      bio, office_phone, contact_url, openstates_id, bioguide_id,
    } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO representatives
         (name, level, chamber, district, party, photo_url, state,
          bio, office_phone, contact_url, openstates_id, bioguide_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (openstates_id) WHERE openstates_id IS NOT NULL
       DO UPDATE SET
         name = EXCLUDED.name, chamber = EXCLUDED.chamber,
         district = EXCLUDED.district, party = EXCLUDED.party,
         photo_url = EXCLUDED.photo_url, bio = EXCLUDED.bio,
         office_phone = EXCLUDED.office_phone, contact_url = EXCLUDED.contact_url,
         updated_at = NOW()
       RETURNING *`,
      [
        name, level || 'state', chamber, district || null, party || null,
        photo_url || null, state || 'AL', bio || null,
        office_phone || null, contact_url || null,
        openstates_id || null, bioguide_id || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/legislature/representatives/:id
router.get('/representatives/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const repResult = await pool.query(
      `SELECT
         r.*,
         ROUND(AVG(cr.rating), 1) AS avg_rating,
         COUNT(cr.id)::int        AS rating_count
       FROM representatives r
       LEFT JOIN community_ratings cr ON cr.representative_id = r.id
       WHERE r.id = $1
       GROUP BY r.id`,
      [id]
    );
    if (!repResult.rows[0]) return res.status(404).json({ error: 'Representative not found' });

    const ratingsResult = await pool.query(
      `SELECT cr.rating, cr.comment, cr.period, cr.created_at, u.username
       FROM community_ratings cr
       JOIN users u ON u.id = cr.user_id
       WHERE cr.representative_id = $1
       ORDER BY cr.created_at DESC
       LIMIT 20`,
      [id]
    );

    const votesResult = await pool.query(
      `SELECT rv.vote, rv.created_at,
              b.bill_number, b.title, b.status, b.id AS bill_id
       FROM representative_votes rv
       JOIN bills b ON b.id = rv.bill_id
       WHERE rv.representative_id = $1
       ORDER BY rv.created_at DESC
       LIMIT 20`,
      [id]
    );

    res.json({
      ...repResult.rows[0],
      ratings:      ratingsResult.rows,
      recent_votes: votesResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/legislature/representatives/:id/rate  (auth)
router.post('/representatives/:id/rate', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;
    const userId = req.user.id;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    const period = currentPeriod();

    const { rows } = await pool.query(
      `INSERT INTO community_ratings (user_id, representative_id, rating, comment, period)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, representative_id, period)
       DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment
       RETURNING *`,
      [userId, id, parseInt(rating, 10), comment || null, period]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── Alerts ────────────────────────────────────────────────────────────────────

// GET /api/legislature/alerts  (auth)
router.get('/alerts', authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM legislative_alerts
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/legislature/alerts  (auth)
router.post('/alerts', authenticate, async (req, res, next) => {
  try {
    const { alert_type, target_id } = req.body;
    if (!alert_type || !target_id) {
      return res.status(400).json({ error: 'alert_type and target_id are required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO legislative_alerts (user_id, alert_type, target_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, alert_type, target_id) DO NOTHING
       RETURNING *`,
      [req.user.id, alert_type, target_id]
    );
    if (!rows[0]) return res.status(200).json({ message: 'Already subscribed' });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/legislature/alerts/:id  (auth)
router.delete('/alerts/:id', authenticate, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM legislative_alerts WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Alert not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Community Vote Records ────────────────────────────────────────────────────

// GET /api/legislature/community-records?body=
router.get('/community-records', async (req, res, next) => {
  try {
    const { body, limit = 50 } = req.query;
    const params = [];
    const conditions = [];

    if (body) {
      params.push(body);
      conditions.push(`cvr.body = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit, 10) || 50);

    const { rows } = await pool.query(
      `SELECT cvr.*, u.username
       FROM community_vote_records cvr
       JOIN users u ON u.id = cvr.user_id
       ${where}
       ORDER BY cvr.vote_date DESC NULLS LAST, cvr.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/legislature/community-records  (auth)
router.post('/community-records', authenticate, async (req, res, next) => {
  try {
    const { body, vote_date, description, outcome, source_url } = req.body;
    if (!body || !description) {
      return res.status(400).json({ error: 'body and description are required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO community_vote_records
         (user_id, body, vote_date, description, outcome, source_url, verified)
       VALUES ($1,$2,$3,$4,$5,$6,false)
       RETURNING *`,
      [
        req.user.id, body, vote_date || null,
        description, outcome || null, source_url || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── Seed (admin) ──────────────────────────────────────────────────────────────

// GET /api/legislature/seed  (admin)
router.get('/seed', authenticate, requireRole('admin'), async (req, res, next) => {
  try {
    // Insert sample representatives
    const repsData = [
      {
        name: 'Dale Strong',
        level: 'federal',
        chamber: 'house',
        district: 'AL-05',
        party: 'Republican',
        state: 'AL',
        bio: 'U.S. Representative for Alabama\'s 5th congressional district, serving North Alabama including Huntsville.',
        contact_url: 'https://dalestrong.house.gov/contact',
        bioguide_id: 'S001220',
      },
      {
        name: 'Tommy Tuberville',
        level: 'federal',
        chamber: 'senate',
        district: 'Alabama',
        party: 'Republican',
        state: 'AL',
        bio: 'U.S. Senator for Alabama.',
        contact_url: 'https://www.tuberville.senate.gov/contact',
        bioguide_id: 'T000278',
      },
      {
        name: 'Doug Jones (former)',
        level: 'federal',
        chamber: 'senate',
        district: 'Alabama',
        party: 'Democrat',
        state: 'AL',
        bio: 'Former U.S. Senator for Alabama (2018–2021).',
        contact_url: null,
        bioguide_id: null,
      },
      {
        name: 'Rex Reynolds',
        level: 'state',
        chamber: 'house',
        district: 'AL House District 10',
        party: 'Republican',
        state: 'AL',
        bio: 'Alabama State Representative for District 10, covering parts of Madison County.',
        contact_url: 'https://www.legislature.state.al.us',
        bioguide_id: null,
      },
      {
        name: 'Arthur Orr',
        level: 'state',
        chamber: 'senate',
        district: 'AL Senate District 3',
        party: 'Republican',
        state: 'AL',
        bio: 'Alabama State Senator for District 3, serving Decatur and parts of north Alabama.',
        contact_url: 'https://www.legislature.state.al.us',
        bioguide_id: null,
      },
    ];

    const repIds = [];
    for (const rep of repsData) {
      const { rows } = await pool.query(
        `INSERT INTO representatives
           (name, level, chamber, district, party, state, bio, contact_url, bioguide_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          rep.name, rep.level, rep.chamber, rep.district, rep.party,
          rep.state, rep.bio, rep.contact_url, rep.bioguide_id,
        ]
      );
      if (rows[0]) repIds.push(rows[0].id);
    }

    // Insert sample bills
    const billsData = [
      {
        source: 'manual',
        bill_number: 'HB-123',
        title: 'Alabama Student Data Privacy Protection Act',
        summary: 'Prohibits the sale or unauthorized sharing of student data collected by educational technology vendors. Requires parental consent for data collection beyond core instructional purposes.',
        status: 'committee',
        topic_tags: ['education', 'surveillance', 'parental_rights'],
        last_action: 'Referred to House Education Committee',
        last_action_date: '2026-03-15',
        level: 'state',
        source_url: 'https://www.legislature.state.al.us',
        state: 'AL',
      },
      {
        source: 'manual',
        bill_number: 'SB-447',
        title: 'Rural Broadband Infrastructure Expansion Act',
        summary: 'Allocates $150 million in state infrastructure funds to expand high-speed internet access to unserved rural communities in Alabama, with priority given to counties with less than 30% broadband coverage.',
        status: 'floor_vote',
        topic_tags: ['housing', 'land_use'],
        last_action: 'Scheduled for Senate floor vote',
        last_action_date: '2026-05-10',
        level: 'state',
        source_url: 'https://www.legislature.state.al.us',
        state: 'AL',
      },
      {
        source: 'manual',
        bill_number: 'HR-2847',
        title: 'Veterans Health Access and Equity Act',
        summary: 'Expands VA healthcare eligibility and creates a federal grant program for community-based veterans health clinics in underserved rural areas.',
        status: 'introduced',
        topic_tags: ['veterans', 'health'],
        last_action: 'Introduced in House Veterans Affairs Committee',
        last_action_date: '2026-02-28',
        level: 'federal',
        source_url: 'https://www.congress.gov',
        state: null,
      },
    ];

    const billIds = [];
    for (const bill of billsData) {
      const { rows } = await pool.query(
        `INSERT INTO bills
           (source, bill_number, title, summary, status, topic_tags,
            last_action, last_action_date, level, source_url, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          bill.source, bill.bill_number, bill.title, bill.summary,
          bill.status, bill.topic_tags, bill.last_action,
          bill.last_action_date, bill.level, bill.source_url, bill.state,
        ]
      );
      if (rows[0]) billIds.push(rows[0].id);
    }

    res.json({
      message: 'Seed complete',
      representatives_inserted: repIds.length,
      bills_inserted: billIds.length,
      rep_ids: repIds,
      bill_ids: billIds,
    });
  } catch (err) {
    next(err);
  }
});

// ── Bill Alert Subscriptions ──────────────────────────────────────────────────

// GET /api/legislature/bill-alerts — get my subscriptions
router.get('/bill-alerts', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM bill_alert_subscriptions WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/legislature/bill-alerts — subscribe to a bill
router.post('/bill-alerts', authenticate, async (req, res, next) => {
  try {
    const { bill_id, bill_title, bill_number } = req.body;
    if (!bill_id) return res.status(400).json({ error: 'bill_id required' });
    const result = await pool.query(
      `INSERT INTO bill_alert_subscriptions (user_id, bill_id, bill_title, bill_number)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, bill_id) DO UPDATE SET bill_title = EXCLUDED.bill_title
       RETURNING *`,
      [req.user.id, bill_id, bill_title || null, bill_number || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/legislature/bill-alerts/:billId — unsubscribe
router.delete('/bill-alerts/:billId', authenticate, async (req, res, next) => {
  try {
    await pool.query(
      `DELETE FROM bill_alert_subscriptions WHERE user_id = $1 AND bill_id = $2`,
      [req.user.id, req.params.billId]
    );
    res.json({ unsubscribed: true });
  } catch (err) { next(err); }
});

module.exports = router;
