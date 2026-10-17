/* ============================================================
   DebtFree Coach v2 — Express server.
   Serves the app, JSON API, and the Stripe webhook endpoint.
   ============================================================ */
'use strict';

/* dotenv is optional: if installed, .env is loaded; otherwise env comes from the shell. */
try { require('dotenv').config(); } catch (_) { /* not installed — skip */ }

const path = require('path');
const express = require('express');
const helmet = require('helmet');

const store = require('./db');
const auth = require('./auth');
const billing = require('./stripe');
const P = require('./shared/payoff');
const { coachReply, CHIPS } = require('./shared/coach');
const { ACADEMY, buildPath } = require('./shared/academy');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

/* ---------- security headers ---------- */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // allow embedding-free simple hosting
}));

/* ---------- Stripe webhook needs the RAW body — mount BEFORE json() ---------- */
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), billing.webhook);

/* ---------- parsers & static ---------- */
app.use(express.json({ limit: '256kb' }));
app.use(auth.apiLimiter);
app.use(auth.attachUser);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

/* ---------- helpers ---------- */
const okProfile = p => p && p.onboarded;
function requireOnboarded(req, res, next) {
  const p = store.getProfile(req.user.user_id);
  if (!okProfile(p)) return res.status(409).json({ error: 'Finish onboarding first.', needsOnboarding: true });
  req.profile = p;
  next();
}
function planFor(userId, extraOverride, strategyOverride) {
  const profile = store.getProfile(userId);
  const debts = store.getDebts(userId).map(d => ({ id: String(d.id), name: d.name, balance: d.balance, apr: d.apr, min: d.min }));
  const extra = extraOverride !== undefined ? extraOverride : profile.extra;
  const strategy = strategyOverride || profile.strategy;
  const sim = P.simulatePayoff(P.activeDebts(debts), extra, strategy);
  return {
    months: sim.stalled ? null : sim.months,
    stalled: sim.stalled,
    interest: Math.round(sim.interest * 100) / 100,
    payoff: sim.payoff, // {debtId: monthNumber}
    totalDebt: Math.round(P.totalDebt(debts) * 100) / 100,
    totalMins: Math.round(P.totalMins(debts) * 100) / 100,
    extra, strategy,
  };
}

/* ============================================================
   AUTH
   ============================================================ */
app.post('/api/auth/signup', auth.authLimiter, auth.signup);
app.post('/api/auth/login', auth.authLimiter, auth.login);
app.post('/api/auth/logout', auth.logout);

/* Current viewer: identity + subscription + onboarding state. */
app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const profile = store.getProfile(req.user.user_id);
  res.json({
    user: { id: req.user.user_id, email: req.user.email },
    subscription: auth.subscriptionInfo(req.user.user_id),
    onboarded: okProfile(profile),
    billingConfigured: billing.configured(),
  });
});

/* ============================================================
   PROFILE / DEBTS / PAYMENTS  (login + active subscription)
   ============================================================ */
app.get('/api/profile', auth.requireUser, auth.requireSubscription, (req, res) => {
  res.json({ profile: store.getProfile(req.user.user_id) });
});

app.put('/api/profile', auth.requireUser, auth.requireSubscription, (req, res) => {
  const b = req.body || {};
  /* Draft autosave from the onboarding wizard: persist whatever is filled so
     far without validation, and never mark onboarding complete. */
  if (b.draft === true) {
    const profile = store.saveDraftProfile(req.user.user_id, {
      name: auth.str(b.name, 80),
      income: auth.num(b.income), expenses: auth.num(b.expenses),
      savings: auth.num(b.savings),
      has401k: ['yes', 'no'].includes(b.has401k) ? b.has401k : 'no',
      match: ['yes', 'no', 'unknown'].includes(b.match) ? b.match : 'unknown',
      goal: ['debtfree', 'home', 'retire', 'savings'].includes(b.goal) ? b.goal : '',
      experience: ['beginner', 'some', 'comfortable'].includes(b.experience) ? b.experience : '',
      extra: auth.num(b.extra),
      strategy: b.strategy === 'snowball' ? 'snowball' : 'avalanche',
    });
    return res.json({ profile });
  }
  const has401k = ['yes', 'no'].includes(b.has401k) ? b.has401k : 'no';
  const match = ['yes', 'no', 'unknown'].includes(b.match) ? b.match : 'unknown';
  const goal = ['debtfree', 'home', 'retire', 'savings'].includes(b.goal) ? b.goal : '';
  const experience = ['beginner', 'some', 'comfortable'].includes(b.experience) ? b.experience : '';
  const strategy = b.strategy === 'snowball' ? 'snowball' : 'avalanche';
  const name = auth.str(b.name, 80);
  if (!name) return res.status(400).json({ error: 'Please tell your coach your name.' });
  const income = auth.num(b.income, { min: 0.01 });
  if (!(income > 0)) return res.status(400).json({ error: 'Enter your monthly take-home pay.' });
  const expenses = auth.num(b.expenses, { min: 0.01 });
  if (!(expenses > 0)) return res.status(400).json({ error: 'Enter your total monthly expenses.' });
  const profile = store.upsertProfile(req.user.user_id, {
    name, income, expenses,
    savings: auth.num(b.savings),
    has401k, match, goal, experience,
    extra: auth.num(b.extra),
    strategy,
  });
  res.json({ profile });
});

function validDebtBody(b) {
  const name = auth.str(b.name, 80) || 'Debt';
  const balance = auth.num(b.balance, { min: 0.01, max: 1e9 });
  const apr = auth.num(b.apr, { min: 0, max: 100 });
  const min = auth.num(b.min, { min: 0.01, max: 1e9 });
  if (!(balance > 0) || !(min > 0)) return { error: 'Each debt needs a balance and a minimum payment above $0.' };
  return { name, balance, apr, min };
}

app.get('/api/debts', auth.requireUser, auth.requireSubscription, (req, res) => {
  res.json({ debts: store.getDebts(req.user.user_id) });
});
app.post('/api/debts', auth.requireUser, auth.requireSubscription, (req, res) => {
  const v = validDebtBody(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  res.status(201).json({ debt: store.addDebt(req.user.user_id, v) });
});
/* Replace the user's whole debt list (onboarding autosave + final submit). */
app.put('/api/debts', auth.requireUser, auth.requireSubscription, (req, res) => {
  const list = (req.body && req.body.debts) || [];
  if (!Array.isArray(list)) return res.status(400).json({ error: 'debts must be an array.' });
  const clean = [];
  for (const d of list) {
    const v = validDebtBody(d || {});
    if (v.error) return res.status(400).json({ error: v.error });
    clean.push(v);
  }
  res.json({ debts: store.replaceDebts(req.user.user_id, clean) });
});
app.put('/api/debts/:id', auth.requireUser, auth.requireSubscription, (req, res) => {
  const v = validDebtBody(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const d = store.updateDebt(req.user.user_id, Number(req.params.id), v);
  if (!d) return res.status(404).json({ error: 'Debt not found.' });
  res.json({ debt: d });
});
app.delete('/api/debts/:id', auth.requireUser, auth.requireSubscription, (req, res) => {
  if (!store.deleteDebt(req.user.user_id, Number(req.params.id))) {
    return res.status(404).json({ error: 'Debt not found.' });
  }
  res.json({ ok: true });
});

/* Log a payment/windfall against one debt. */
app.post('/api/payments', auth.requireUser, auth.requireSubscription, (req, res) => {
  const debtId = Number(req.body.debt_id);
  const amount = auth.num(req.body.amount, { min: 0.01, max: 1e9 });
  if (!Number.isInteger(debtId) || !(amount > 0)) {
    return res.status(400).json({ error: 'Pick a debt and enter an amount above $0.' });
  }
  const debt = store.getDebts(req.user.user_id).find(d => d.id === debtId);
  if (!debt) return res.status(404).json({ error: 'Debt not found.' });
  const newBalance = Math.max(0, Math.round((debt.balance - amount) * 100) / 100);
  store.setDebtBalance(req.user.user_id, debtId, newBalance);
  const logged = store.logPayment(req.user.user_id, debtId, amount, auth.str(req.body.note, 200));
  res.json({ debt: { ...debt, balance: newBalance }, payment: logged, plan: planFor(req.user.user_id) });
});

/* Start over: wipes plan data, keeps the account + subscription. */
app.delete('/api/reset', auth.requireUser, (req, res) => {
  store.resetUserData(req.user.user_id);
  res.json({ ok: true });
});

/* ============================================================
   PLAN / CHAT / ACADEMY  (login + active subscription + onboarded)
   ============================================================ */
app.get('/api/plan', auth.requireUser, auth.requireSubscription, requireOnboarded, (req, res) => {
  const extra = req.query.extra !== undefined ? auth.num(req.query.extra) : undefined;
  const strategy = req.query.strategy === 'snowball' || req.query.strategy === 'avalanche'
    ? req.query.strategy : undefined;
  res.json({ plan: planFor(req.user.user_id, extra, strategy) });
});

app.post('/api/chat', auth.requireUser, auth.requireSubscription, requireOnboarded, auth.chatLimiter, (req, res) => {
  const message = auth.str(req.body.message, 2000);
  if (!message) return res.status(400).json({ error: 'Type a message first.' });
  const debts = store.getDebts(req.user.user_id).map(d => ({
    id: String(d.id), name: d.name, balance: d.balance, apr: d.apr, min: d.min,
  }));
  res.json({ reply: coachReply(message, { profile: req.profile, debts }), chips: CHIPS });
});

app.get('/api/academy', auth.requireUser, auth.requireSubscription, requireOnboarded, (_req, res) => {
  res.json({ lessons: ACADEMY });
});
app.get('/api/path', auth.requireUser, auth.requireSubscription, requireOnboarded, (req, res) => {
  const debts = store.getDebts(req.user.user_id);
  res.json({ path: buildPath(req.profile, debts).map(([title, body]) => ({ title, body })) });
});

/* ============================================================
   BILLING
   ============================================================ */
app.post('/api/billing/checkout', auth.requireUser, billing.createCheckout);
app.post('/api/billing/portal', auth.requireUser, billing.createPortal);
/* Cancel-save flow: downsell offer, cancel at period end, Blueprint OTO. */
app.get('/api/billing/save-offer', auth.requireUser, billing.saveOfferStatus);
app.post('/api/billing/downsell', auth.requireUser, billing.applyDownsell);
app.post('/api/billing/cancel', auth.requireUser, billing.cancelSubscription);
app.post('/api/billing/blueprint-checkout', auth.requireUser, billing.blueprintCheckout);
app.get('/api/billing/blueprint', auth.requireUser, billing.blueprintDownload);
app.get('/api/billing/status', auth.requireUser, (req, res) => {
  res.json({ subscription: auth.subscriptionInfo(req.user.user_id), configured: billing.configured() });
});

/* ---------- health ---------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, billing: billing.configured() }));

/* ============================================================
   ADMIN BACKUP — database snapshot for offsite encrypted backups.
   Protected by the BACKUP_TOKEN env var (constant-time compare).
   Streams a consistent snapshot (VACUUM INTO a temp file) of the
   SQLite database. The fetcher encrypts it before it lands anywhere
   permanent. Registered BEFORE the SPA fallback.
   ============================================================ */
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
app.get('/api/admin/backup', (req, res) => {
  const token = process.env.BACKUP_TOKEN;
  if (!token) return res.status(503).json({ error: 'Backups not configured.' });
  const header = String(req.headers.authorization || '');
  const given = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7)
    : String(req.query.token || '');
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  const tmp = path.join(os.tmpdir(), `dfc-backup-${Date.now()}.db`);
  const cleanup = () => fs.unlink(tmp, () => {});
  try {
    store.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="debtfree-backup.db"');
    const stream = fs.createReadStream(tmp);
    stream.on('close', cleanup);
    stream.on('error', () => { cleanup(); if (!res.headersSent) res.status(500).end(); });
    stream.pipe(res);
  } catch (e) {
    cleanup();
    console.error('Backup failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Backup failed.' });
  }
});

/* ============================================================
   ADMIN — reset test artifacts for a user (cancel-save offer flags
   and Blueprint purchases). Same BACKUP_TOKEN protection as the
   backup endpoint. Returns a test account to pristine state.
   ============================================================ */
app.post('/api/admin/reset-test-state', (req, res) => {
  const token = process.env.BACKUP_TOKEN;
  if (!token) return res.status(503).json({ error: 'Not configured.' });
  const header = String(req.headers.authorization || '');
  const given = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  const userId = Number(req.body && req.body.user_id);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'user_id required.' });
  }
  try {
    const s1 = store.db.prepare('DELETE FROM cancel_save_offers WHERE user_id=?').run(userId);
    const s2 = store.db.prepare('DELETE FROM blueprint_purchases WHERE user_id=?').run(userId);
    res.json({ ok: true, cleared: { save_offers: s1.changes, blueprint_purchases: s2.changes } });
  } catch (e) {
    console.error('reset-test-state failed:', e.message);
    res.status(500).json({ error: 'Reset failed.' });
  }
});

/* ============================================================
   LEGAL PAGES (DRAFT — pending attorney review)
   Served as full pages; must be registered BEFORE the SPA fallback.
   ============================================================ */
app.get('/terms', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'legal', 'terms.html'));
});
app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'legal', 'privacy.html'));
});
app.get('/refunds', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'legal', 'refunds.html'));
});

/* ---------- SPA fallback ---------- */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ---------- errors ---------- */
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`DebtFree Coach v2 listening on http://localhost:${PORT}`);
    console.log(`Billing: ${billing.configured() ? 'Stripe configured' : 'NOT configured — /api/billing/* will return 503 with a clear message'}`);
    console.log(`DEV_AUTO_SUBSCRIBE=${process.env.DEV_AUTO_SUBSCRIBE || 'false'}`);
  });
}

module.exports = app;
