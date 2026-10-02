# DebtFree Coach v2 💰

A debt-payoff + investing-education web app for the general public.
**$9.99/month after a 7-day free trial** (card collected upfront, first charge after 7 days, cancel during the trial = never charged).

Server-backed: accounts, per-user saved plans, and real Stripe subscription gating — no more access codes. Education-only framing throughout (no specific stocks/funds/tickers).

## Quick start (local, no Stripe needed)

```bash
cd debtfree-coach-v2
npm install
cp .env.example .env   # DEV_AUTO_SUBSCRIBE=true is already set for local testing
npm start
```

Open http://localhost:3000. Sign up — with `DEV_AUTO_SUBSCRIBE=true` and no Stripe keys, signup grants a local 7-day trialing subscription so the entire flow (onboarding → dashboard → coach → academy) works with zero setup. Checkout/portal buttons will show a clear "not configured" message instead of crashing.

> **Production:** set `DEV_AUTO_SUBSCRIBE=false` (or remove it) and provide real Stripe keys.

## Project layout

| File | What it does |
|---|---|
| `server.js` | Express app: security headers, JSON API, static files, SPA fallback |
| `db.js` | SQLite schema + data access (better-sqlite3, zero-config) |
| `auth.js` | Email/password auth (bcrypt), server sessions, rate limits, subscription gating |
| `stripe.js` | Stripe Checkout (7-day trial), billing portal, signature-verified webhooks |
| `shared/payoff.js` | Payoff math engine (UMD: used by Node AND the browser) |
| `shared/coach.js` | Rule-based, data-aware coach replies (UMD) |
| `shared/academy.js` | Investing academy lessons + personalized path (UMD) |
| `public/` | Frontend: landing/pricing, auth, onboarding, app, demo mode |

## Stripe setup (dashboard, test mode first)

1. **Create the product:** Stripe Dashboard → Products → Add product
   - Name: `DebtFree Coach — Monthly`
   - Pricing: **Recurring, $9.99 USD / month**
   - Copy the **Price ID** (starts with `price_`) → `STRIPE_PRICE_ID`
2. **API keys:** Developers → API keys → copy the **Secret key** (test: `sk_test_...`) → `STRIPE_SECRET_KEY`
3. **Webhook endpoint:** Developers → Webhooks → Add endpoint
   - URL: `https://YOUR-APP-URL/webhooks/stripe`
   - Events to enable:
     - `checkout.session.completed` → activates the subscription
     - `customer.subscription.updated` → trial → active, renewals, cancellations scheduled
     - `customer.subscription.deleted` → revokes access
     - `invoice.payment_failed` → flags the account past-due
   - Copy the **Signing secret** (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`
4. **Customer portal:** Settings → Billing → Customer portal → activate, allow customers to cancel subscriptions. (The app links users here for self-serve cancellation.)
5. **Test the full flow locally** with the Stripe CLI:
   ```bash
   stripe listen --forward-to localhost:3000/webhooks/stripe
   ```
   Then sign up in the app and click through Checkout with card `4242 4242 4242 4242`. The webhook will flip the account from "no subscription" to `trialing`.
6. **Go live:** repeat steps 1–4 with **live** keys, set `DEV_AUTO_SUBSCRIBE=false`.

### How the trial works
Checkout is created with `trial_period_days: 7`. Stripe collects the card immediately but doesn't charge until day 7. Webhooks keep the local `subscriptions` table in sync; only statuses `active` and `trialing` can use the app. If the user cancels during the trial, `customer.subscription.deleted` sets status to `canceled` and the app locks.

### Fee reality check ($9.99/mo, US)
- **Stripe:** 2.9% + $0.30 processing + 0.7% Billing = ~$0.66 → **you keep ~$9.33**
- **Gumroad** (alternative): 10% + $0.50 + processing = ~$2.09 → **you keep ~$7.90**
- Stripe is not merchant-of-record; if you sell internationally, consider Stripe Tax.

## Deploy

### Render.com (recommended — `render.yaml` included)
1. Push this folder to a GitHub repo.
2. Render Dashboard → New → Blueprint → point at the repo (reads `render.yaml`).
3. Set the three `sync: false` secrets in the dashboard (live Stripe keys).
4. Update `APP_URL` to your real `https://....onrender.com` URL.
5. Create the Stripe webhook endpoint pointing at `https://<your-url>/webhooks/stripe`.

> **SQLite caveat:** the blueprint attaches a 1 GB persistent disk at `/data` (paid plans). On Render's **free** plan disks aren't available — the database resets on every deploy. For free-tier persistence, swap better-sqlite3 for Turso (libsql) later; the data-access layer is isolated in `db.js`.

### Railway
1. New project → deploy from repo. Railway provides persistent volumes: add one mounted at `/data`.
2. Set env vars: `NODE_ENV=production`, `DB_PATH=/data/debtfree.db`, `APP_URL`, `DEV_AUTO_SUBSCRIBE=false`, plus the three Stripe secrets.
3. Same Stripe webhook URL pattern: `https://<railway-url>/webhooks/stripe`.

### Fly.io
1. `fly launch` (Dockerfile is used automatically) → `fly volumes create dfc_data --size 1` → mount at `/data` in `fly.toml` (`[[mounts]] source="dfc_data" destination="/data"`).
2. `fly secrets set STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... STRIPE_PRICE_ID=... APP_URL=...`
3. Same webhook URL pattern.

## API overview

- `POST /api/auth/signup|login|logout`, `GET /api/me`
- `GET|PUT /api/profile`, `GET|POST /api/debts`, `PUT|DELETE /api/debts/:id`
- `POST /api/payments`, `DELETE /api/reset`
- `GET /api/plan?extra=&strategy=`, `POST /api/chat`, `GET /api/academy`, `GET /api/path`
- `POST /api/billing/checkout`, `POST /api/billing/portal`, `GET /api/billing/status`
- `POST /webhooks/stripe` (raw body, signature-verified)
- `GET /api/health`

Paid endpoints require login + subscription status `active`/`trialing` (HTTP 402 otherwise).

## Security notes

- Passwords hashed with bcrypt (cost 10); sessions are random 256-bit tokens in SQLite, httpOnly + SameSite=Lax cookies (Secure in production).
- Helmet headers incl. a strict CSP (all JS/CSS is same-origin files — no inline scripts).
- Auth endpoints rate-limited; chat rate-limited; global API limiter.
- Webhook signature verification is **required** — requests fail closed without it.
- Never commit `.env` (see `.gitignore`).
- Remaining hardening before real money: add Terms of Service + Privacy Policy pages, get the disclaimers reviewed by a business attorney, and never market it as "financial advice."

## Demo mode

The landing page has **"Try the demo (no account)"** — the full app runs in-memory in the browser (nothing persisted, nothing sent to the server). It uses the exact same engine modules as the server, so demo math always matches subscriber math.
