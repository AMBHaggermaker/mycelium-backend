const express = require('express');
const router = express.Router();

// POST /api/donations/create-session
router.post('/create-session', async (req, res, next) => {
  try {
    const { amount } = req.body;

    const dollars = parseFloat(amount);
    if (!dollars || dollars < 1 || dollars > 10000) {
      return res.status(400).json({ error: 'Amount must be between $1 and $10,000.' });
    }

    const key = process.env.STRIPE_SECRET_KEY;
    if (!key || key.startsWith('sk_live_REPLACE') || key.startsWith('sk_test_REPLACE')) {
      return res.status(503).json({ error: 'Donations are not configured yet. Please contact the admin.' });
    }

    const Stripe = require('stripe');
    const stripe = Stripe(key);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(dollars * 100),
            product_data: {
              name: 'Donation to Mycelium',
              description: 'Support free, sovereign community infrastructure in North Alabama.',
            },
          },
          quantity: 1,
        },
      ],
      success_url: 'https://mycelium.unprecedentedtimes.org/donate/thanks',
      cancel_url:  'https://mycelium.unprecedentedtimes.org',
    });

    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
