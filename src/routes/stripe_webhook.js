const express = require('express');
const router  = express.Router();
const Stripe  = require('stripe');
const pool    = require('../db');

// IMPORTANT: This route must use express.raw() — registered in index.js before express.json()
// Stripe needs the raw body to verify the webhook signature.

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const TIER_BY_PRICE = () => ({
  [process.env.STRIPE_MAKER_BASIC_PRICE_ID]:    'basic',
  [process.env.STRIPE_MAKER_STANDARD_PRICE_ID]: 'standard',
  [process.env.STRIPE_MAKER_PRO_PRICE_ID]:      'pro',
});

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).send('Stripe not configured');

  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId  = session.metadata?.user_id;
      const tier    = session.metadata?.tier;
      const courseId = session.metadata?.course_id;

      if (tier && userId && session.mode === 'subscription') {
        // Activate maker tier
        const subId = session.subscription;
        const sub   = await stripe.subscriptions.retrieve(subId);
        const expiresAt = new Date(sub.current_period_end * 1000).toISOString();

        const existing = await pool.query('SELECT id FROM maker_profiles WHERE user_id = $1', [userId]);
        if (existing.rows[0]) {
          await pool.query(
            `UPDATE maker_profiles
             SET storage_tier = $1, stripe_subscription_id = $2, tier_expires_at = $3
             WHERE user_id = $4`,
            [tier, subId, expiresAt, userId]
          );
        } else {
          const userRes = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
          await pool.query(
            `INSERT INTO maker_profiles (user_id, maker_name, storage_tier, stripe_subscription_id, tier_expires_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [userId, userRes.rows[0]?.username || 'Maker', tier, subId, expiresAt]
          );
        }
      }

      if (courseId && userId && session.mode === 'payment') {
        // Course purchase — enroll the user
        await pool.query(
          'INSERT INTO pro_dev_enrollments (user_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [userId, courseId]
        );
        await pool.query(
          'UPDATE pro_dev_courses SET enrollment_count = enrollment_count + 1 WHERE id = $1',
          [courseId]
        );
      }
    }

    if (event.type === 'customer.subscription.updated') {
      const sub    = event.data.object;
      const priceId = sub.items?.data[0]?.price?.id;
      const newTier = TIER_BY_PRICE()[priceId];
      if (!newTier) return res.json({ received: true });

      const expiresAt = new Date(sub.current_period_end * 1000).toISOString();
      await pool.query(
        `UPDATE maker_profiles SET storage_tier = $1, tier_expires_at = $2
         WHERE stripe_subscription_id = $3`,
        [newTier, expiresAt, sub.id]
      );
    }

    if (event.type === 'customer.subscription.deleted') {
      // Subscription cancelled — revert to free tier, preserve files
      const sub = event.data.object;
      await pool.query(
        `UPDATE maker_profiles
         SET storage_tier = 'free', stripe_subscription_id = NULL, tier_expires_at = NULL
         WHERE stripe_subscription_id = $1`,
        [sub.id]
      );
    }

    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const subId   = invoice.subscription;
      if (subId) {
        await pool.query(
          `UPDATE maker_profiles SET storage_tier = 'free'
           WHERE stripe_subscription_id = $1`,
          [subId]
        );
      }
    }
  } catch (e) {
    console.error('[stripe-webhook] handler error:', e.message);
  }

  res.json({ received: true });
});

module.exports = router;
