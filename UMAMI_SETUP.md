# Umami Analytics Setup Guide

Privacy-first, no-cookie analytics for the Unprecedented Times platform.

---

## Dashboard

**URL:** https://analytics.unprecedentedtimes.org  
**Default login:** `admin` / `umami`  
**Change the password immediately after first login.**

---

## Cloudflare DNS — Required CNAME Record

In Cloudflare DNS for `unprecedentedtimes.org`, add:

| Type  | Name      | Target                          | Proxy |
|-------|-----------|---------------------------------|-------|
| CNAME | analytics | 3e805a76-6d89-41c0-a991-496a7d380671.cfargotunnel.com | Proxied (orange) |

The tunnel UUID is `3e805a76-6d89-41c0-a991-496a7d380671` (same tunnel as all other subdomains).

---

## Adding Sites in Umami Dashboard

1. Log in at https://analytics.unprecedentedtimes.org
2. Go to **Settings → Websites → Add Website**
3. Add each site:
   - Name: `Mycelium` / Domain: `mycelium.unprecedentedtimes.org`
   - Name: `Lost & Found` / Domain: `lostfound.unprecedentedtimes.org`
   - Name: `HHR` / Domain: `hhr.unprecedentedtimes.org`
   - Name: `Unprecedented Times` / Domain: `unprecedentedtimes.org` (Ghost)
4. Each site gets a unique **Website ID** (UUID)
5. Copy the Website ID for each site

---

## Activating Tracking Scripts

After adding each site in Umami and copying its Website ID:

### Mycelium (`mycelium.unprecedentedtimes.org`)
Edit `C:\mycelium-app\index.html` — replace `REPLACE_WITH_WEBSITE_ID`:
```html
<script defer src="https://analytics.unprecedentedtimes.org/script.js"
  data-website-id="YOUR-UUID-HERE"></script>
```
Then rebuild: `cd C:\mycelium-app && npm run build`

Commit and push:
```
cd C:\mycelium-app
git add index.html dist/index.html
git commit -m "Add Umami tracking"
git push
```

### Lost & Found (`lostfound.unprecedentedtimes.org`)
Edit `C:\lostfound-app\index.html` — replace `REPLACE_WITH_WEBSITE_ID`:
```html
<script defer src="https://analytics.unprecedentedtimes.org/script.js"
  data-website-id="YOUR-UUID-HERE"></script>
```
Then rebuild: `cd C:\lostfound-app && npm run build`

### HHR (`hhr.unprecedentedtimes.org`)
Edit `C:\hhr\index.html` (line ~816) — replace `REPLACE_WITH_WEBSITE_ID`:
```html
<script defer src="https://analytics.unprecedentedtimes.org/script.js"
  data-website-id="YOUR-UUID-HERE"></script>
```
No build needed — the file is served directly.

### Ghost (`unprecedentedtimes.org`)
1. Log in to Ghost Admin: http://localhost:2368/ghost
2. Go to **Settings → Code Injection → Site Header**
3. Paste:
```html
<script defer src="https://analytics.unprecedentedtimes.org/script.js"
  data-website-id="7146d022-b556-48a7-b728-6da03bb70339"></script>
```
4. Click **Save**

---

## Docker Infrastructure

Umami runs as two containers on the `umami-net` Docker network:

| Container | Image            | Purpose           |
|-----------|------------------|-------------------|
| `umami-db`| `postgres:15-alpine` | Dedicated database |
| `umami`   | `ghcr.io/umami-software/umami:postgresql-latest` | App on port 3005 |

Both have `--restart always` — they start automatically with Docker.  
Also added to `C:\Users\User\startup.bat` after the Docker daemon is ready.

**App secret:** `qyyKwfviTBitcKR6Sg5Wh4JIDdEjDguz`  
**DB password:** `umami_pass_2026` (internal to Docker network, not exposed)

---

## Umami Features

- **No cookies** — fully GDPR/CCPA compliant, no consent banner needed
- **Self-hosted** — visitor data stays on your server
- **Tracks:** pageviews, sessions, referrers, browsers, OS, devices, countries
- **Custom events:** call `umami.track('event-name', { props })` from JS
- **Share links:** public dashboards you can share without login

---

## Maintenance

```bash
# View logs
docker logs umami --tail 50

# Restart
docker restart umami

# Update Umami to latest
docker pull ghcr.io/umami-software/umami:postgresql-latest
docker stop umami && docker rm umami
# Re-run with same docker run command from startup.bat
```
