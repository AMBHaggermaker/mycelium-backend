const express = require('express');
const pool    = require('../db');
const { sendEmail } = require('../lib/email');

const router = express.Router();

const XRP_ADDRESS = 'rEqYE3DJFfhsD47BarCDA4CCZriiQ5pNV5';

// POST /api/donations/create-session  (Stripe)
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

// POST /api/donations/xrp  — declaration form submission
router.post('/xrp', async (req, res, next) => {
  try {
    const {
      donor_name, donor_email, declared_amount_xrp,
      sender_xrp_address, note, mycelium_username,
    } = req.body;

    // Validation
    if (!donor_name?.trim())
      return res.status(400).json({ error: 'Name is required.' });
    if (!donor_email?.trim())
      return res.status(400).json({ error: 'Email address is required.' });
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(donor_email.trim()))
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    const amount = parseFloat(declared_amount_xrp);
    if (!declared_amount_xrp || isNaN(amount) || amount <= 0)
      return res.status(400).json({ error: 'Amount must be a number greater than 0.' });
    if (!sender_xrp_address?.trim() || sender_xrp_address.trim().length < 12)
      return res.status(400).json({ error: 'Sender XRP address must be at least 12 characters.' });

    const MIN_XRP  = parseFloat(process.env.MINIMUM_XRP_DONATION || '10');
    const status   = amount < MIN_XRP ? 'below_minimum' : 'pending';
    const addr     = sender_xrp_address.trim();
    const addrHigh = `${addr.slice(0, 6)}…${addr.slice(-6)}`;

    const result = await pool.query(
      `INSERT INTO xrp_donations
         (donor_name, donor_email, mycelium_username, declared_amount_xrp,
          sender_xrp_address, note, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, created_at`,
      [
        donor_name.trim(),
        donor_email.trim().toLowerCase(),
        mycelium_username?.trim() || null,
        amount,
        addr,
        note?.trim() || null,
        status,
      ]
    );

    const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'aliciambh82@protonmail.com';

    // ── Admin notification ────────────────────────────────────────────────────
    const belowMinNote = status === 'below_minimum'
      ? `<div style="margin:12px 0;padding:10px 14px;background:#7c2d12;border-left:4px solid #fb923c;border-radius:6px;color:#fed7aa;font-size:13px;">
           ⚠️ <strong>Below minimum threshold (${MIN_XRP} XRP)</strong> — possible dust amount. Do not confirm without manual verification.
         </div>`
      : '';

    sendEmail({
      to: ADMIN_EMAIL,
      subject: `New XRP Donation Declaration — ${amount} XRP from ${donor_name.trim()}`,
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0d0d1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:540px;margin:32px auto;background:#1a1a2e;border:1px solid rgba(0,255,136,0.2);border-radius:12px;overflow:hidden;">
    <div style="background:#0a1f0f;padding:24px 32px;border-bottom:1px solid rgba(0,255,136,0.15);">
      <p style="color:#00ff88;font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin:0 0 6px;">⬡ Mycelium Donations</p>
      <h1 style="color:#f0ece4;margin:0;font-size:20px;">New XRP Donation Declaration</h1>
    </div>
    <div style="padding:28px 32px;color:#f0ece4;">
      ${belowMinNote}
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 0;color:#a8b5a0;width:40%;">Donor name</td><td style="padding:6px 0;font-weight:600;">${donor_name.trim()}</td></tr>
        <tr><td style="padding:6px 0;color:#a8b5a0;">Email</td><td style="padding:6px 0;">${donor_email.trim()}</td></tr>
        ${mycelium_username?.trim() ? `<tr><td style="padding:6px 0;color:#a8b5a0;">Mycelium username</td><td style="padding:6px 0;">@${mycelium_username.trim()}</td></tr>` : ''}
        <tr><td style="padding:6px 0;color:#a8b5a0;">Declared amount</td><td style="padding:6px 0;font-size:18px;font-weight:700;color:#00ff88;">${amount} XRP</td></tr>
        <tr><td style="padding:6px 0;color:#a8b5a0;">Sender address</td>
            <td style="padding:6px 0;font-family:'Courier New',monospace;font-size:12px;">
              <span style="color:#00ff88;font-weight:700;">${addr.slice(0,6)}</span>${addr.slice(6,-6)}<span style="color:#00ff88;font-weight:700;">${addr.slice(-6)}</span>
            </td></tr>
        ${note?.trim() ? `<tr><td style="padding:6px 0;color:#a8b5a0;vertical-align:top;">Note</td><td style="padding:6px 0;font-style:italic;">${note.trim()}</td></tr>` : ''}
        <tr><td style="padding:6px 0;color:#a8b5a0;">Status</td><td style="padding:6px 0;">${status}</td></tr>
      </table>
      <div style="margin:20px 0 0;padding:14px 16px;background:#0d1f14;border:1px solid rgba(0,255,136,0.2);border-radius:8px;font-size:13px;color:#a8b5a0;line-height:1.6;">
        🔐 <strong style="color:#f0ece4;">Verify in Ledger Live before confirming.</strong><br>
        Match the first 6 and last 6 characters of the sender address above against the transaction in your Ledger Live transaction history.
        Destination address should be <span style="color:#00ff88;font-family:'Courier New',monospace;">${XRP_ADDRESS}</span>.
      </div>
    </div>
  </div>
</body></html>`,
    }).catch(e => console.error('[xrp-donation] admin email failed:', e.message));

    // ── Donor confirmation ────────────────────────────────────────────────────
    sendEmail({
      to: donor_email.trim().toLowerCase(),
      subject: 'Thank you for supporting Mycelium',
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f2ede4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #ddd6c8;">
    <div style="background:#0a1f0f;padding:28px 36px;text-align:center;">
      <p style="color:#86efac;font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin:0 0 6px;">⬡ Mycelium</p>
      <h1 style="color:#fff;margin:0;font-size:22px;">Thank you, ${donor_name.trim()}</h1>
    </div>
    <div style="padding:32px 36px;color:#1a1710;">
      <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">
        Your declaration to donate <strong>${amount} XRP</strong> has been received.
        To complete your donation, please send exactly <strong>${amount} XRP</strong> to the Mycelium hardware wallet address below.
      </p>
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px 20px;margin:0 0 20px;text-align:center;">
        <p style="margin:0 0 6px;font-size:12px;color:#166534;text-transform:uppercase;letter-spacing:.08em;">Send to this XRP address</p>
        <p style="margin:0;font-family:'Courier New',monospace;font-size:13px;color:#14532d;word-break:break-all;font-weight:600;">${XRP_ADDRESS}</p>
      </div>
      <p style="font-size:14px;color:#555;margin:0 0 12px;line-height:1.6;">
        ✅ Confirmation may take up to <strong>24 hours</strong> as transactions are manually verified against Ledger Live.
      </p>
      <p style="font-size:14px;color:#555;margin:0 0 20px;line-height:1.6;">
        📋 Please keep the <strong>transaction ID</strong> from your wallet or exchange for your records. You may be asked for it if there is a question about your transaction.
      </p>
      <p style="font-size:14px;color:#555;margin:0;line-height:1.6;">
        Questions? Reply to this email or contact <a href="mailto:aliciambh82@protonmail.com" style="color:#166534;">aliciambh82@protonmail.com</a>.
      </p>
    </div>
    <div style="padding:16px 36px;background:#f8f5f0;border-top:1px solid #e8e2d8;text-align:center;">
      <p style="margin:0;font-size:12px;color:#888;">Mycelium — Community Infrastructure for North Alabama</p>
    </div>
  </div>
</body></html>`,
    }).catch(e => console.error('[xrp-donation] donor email failed:', e.message));

    console.log(`[xrp-donation] declaration saved id=${result.rows[0].id} amount=${amount} status=${status}`);
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
