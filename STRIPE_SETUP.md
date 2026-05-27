# Stripe Setup Guide — Mycelium + Unprecedented Times

## Overview

This guide covers three things:
1. Activating the Stripe donation button on the Mycelium platform
2. Connecting Stripe to the Ghost newsletter for paid memberships
3. Injecting the donation widget into the Unprecedented Times Ghost site

---

## Part 1 — Create Your Stripe Account and Get API Keys

1. Go to [https://dashboard.stripe.com](https://dashboard.stripe.com) and sign in or create an account
2. Navigate to **Developers → API keys**
3. Copy your **Publishable key** (starts with `pk_live_...`)
4. Copy your **Secret key** (starts with `sk_live_...`) — never share this
5. Fill in `C:\mycelium\.env`:
   ```
   STRIPE_PUBLISHABLE_KEY=pk_live_...
   STRIPE_SECRET_KEY=sk_live_...
   ```
6. Fill in `C:\mycelium-app\.env`:
   ```
   VITE_STRIPE_PUBLISHABLE_KEY=pk_live_...
   ```
7. Run `pm2 reload mycelium-api --update-env` to apply backend changes
8. Rebuild the frontend: `cd C:\mycelium-app && npm run build`

---

## Part 2 — Create a Stripe Donation Payment Link

A hosted payment link requires no backend code — Stripe handles the checkout page.

1. In Stripe dashboard, go to **Payment Links** (left sidebar)
2. Click **+ New** or **Create payment link**
3. Add a product:
   - Product name: **Donation — Support Mycelium**
   - Price type: **Customer chooses price** (recommended for donations)
   - Or set a fixed amount (e.g. $5, $10, $25)
4. Customize the confirmation page message
5. Click **Create link** — copy the URL (e.g. `https://buy.stripe.com/xxxx`)

**Activate the donation button in Mycelium:**

6. Open `C:\mycelium-app\.env` and paste the URL:
   ```
   VITE_STRIPE_DONATION_LINK=https://buy.stripe.com/xxxx
   ```
7. Rebuild the frontend: `cd C:\mycelium-app && npm run build`

The Donate button on the Feed page and Merch page will now link to the Stripe checkout.

---

## Part 3 — Connect Stripe to Ghost for Paid Newsletter Memberships

Ghost has native Stripe integration for member subscriptions (free + paid tiers).

### Steps in Ghost Admin

1. Go to [https://unprecedentedtimes.org/ghost](https://unprecedentedtimes.org/ghost) and sign in
2. Navigate to **Settings → Memberships** (left sidebar)
3. Under **Stripe**, click **Connect with Stripe**
4. You will be redirected to Stripe to authorize Ghost
5. Sign in to Stripe and authorize the connection
6. Return to Ghost — you should see "Connected" with your Stripe account name

### Configure Membership Tiers

7. In **Settings → Memberships**, set up your tiers:
   - **Free tier**: readers who sign up for the newsletter at no cost
   - **Monthly paid tier**: set a monthly price (e.g. $5/month)
   - **Annual paid tier**: set a yearly price (e.g. $50/year)
8. Customize the portal text and welcome emails under **Settings → Portal**

### Make Content Members-Only

9. When writing a post, use the **Access** dropdown to set:
   - **Public** — visible to everyone
   - **Members only** — requires free signup
   - **Paid members only** — requires paid subscription
10. Add a paywall divider in the editor with the `/` command: **Paywall**

### Test the Flow

11. In Stripe dashboard, use test mode first (toggle top-left)
12. Use a test card: `4242 4242 4242 4242` with any future expiry and any CVC
13. Confirm subscriptions appear in Stripe → Customers

---

## Part 4 — Ghost Donation Widget (Code Injection)

To add the donation button widget to every page on unprecedentedtimes.org:

1. Go to **Settings → Code Injection** in Ghost Admin
2. Paste the following into the **Site Footer** box:

```html
<!-- Mycelium Donation Widget -->
<style>
  #mycelium-donate-widget {
    position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 9999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #mycelium-donate-widget a.donate-fab,
  #mycelium-donate-widget button.donate-fab {
    display: inline-flex; align-items: center; gap: .5rem;
    background: #16a34a; color: #fff; border: none;
    padding: .65rem 1.15rem; border-radius: 9999px;
    font-size: .9rem; font-weight: 600; cursor: pointer;
    text-decoration: none; box-shadow: 0 4px 16px rgba(0,0,0,.2);
    transition: background .2s, transform .1s;
  }
  #mycelium-donate-widget a.donate-fab:hover,
  #mycelium-donate-widget button.donate-fab:hover { background: #15803d; transform: translateY(-1px); }
  #mycelium-donate-widget .donate-tooltip {
    position: absolute; bottom: calc(100% + .5rem); right: 0;
    background: #1f2937; color: #f9fafb; padding: .6rem .85rem;
    border-radius: .5rem; font-size: .8rem; white-space: nowrap;
    box-shadow: 0 4px 12px rgba(0,0,0,.25); pointer-events: none;
  }
  #mycelium-donate-widget .donate-tooltip::after {
    content: ''; position: absolute; top: 100%; right: 1.2rem;
    border: 6px solid transparent; border-top-color: #1f2937;
  }
</style>

<div id="mycelium-donate-widget">
  <!-- STEP 1: When you have your Stripe payment link, replace the <button> below
       with: <a class="donate-fab" href="https://buy.stripe.com/YOUR_LINK" target="_blank">💛 Support Us</a>
       and remove the <button> and the tooltip <div>. -->
  <button class="donate-fab" onclick="document.getElementById('donate-tip').style.display='block';setTimeout(()=>document.getElementById('donate-tip').style.display='none',3000)">
    💛 Support Us
  </button>
  <div class="donate-tooltip" id="donate-tip" style="display:none">Coming soon — donations launching shortly!</div>
</div>
```

3. Click **Save**

**When your Stripe payment link is ready:**

Replace the `<button>` + tooltip block with a simple `<a>` tag:
```html
<a class="donate-fab" href="https://buy.stripe.com/YOUR_LINK" target="_blank" rel="noopener">
  💛 Support Us
</a>
```

---

## Part 5 — Webhooks (for future backend Stripe events)

If you add backend Stripe event handling (subscriptions, refunds, etc.):

1. Go to Stripe → **Developers → Webhooks**
2. Click **Add endpoint**
3. URL: `https://mycelium.unprecedentedtimes.org/api/stripe/webhook`
4. Select events to listen to (e.g. `checkout.session.completed`, `customer.subscription.updated`)
5. Copy the **Signing secret** (starts with `whsec_...`)
6. Add to `C:\mycelium\.env`:
   ```
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```
7. Run `pm2 reload mycelium-api --update-env`

---

## Summary Checklist

- [ ] Stripe account created and API keys copied to `.env` files
- [ ] Payment link created and `VITE_STRIPE_DONATION_LINK` filled in `mycelium-app/.env`
- [ ] Frontend rebuilt after adding donation link
- [ ] Ghost connected to Stripe via Settings → Memberships → Connect Stripe
- [ ] Ghost membership tiers configured
- [ ] Ghost Code Injection donation widget pasted into Site Footer
- [ ] Ghost widget updated with real Stripe link (replace `<button>` with `<a>`)
- [ ] Webhook endpoint configured (when ready for backend events)
