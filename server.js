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
app.get('/api/billing/status', auth.requireUser, (req, res) => {
  res.json({ subscription: auth.subscriptionInfo(req.user.user_id), configured: billing.configured() });
});

/* ---------- health ---------- */
app.get('/api/health', (_req, res) => res.json({ ok: true, billing: billing.configured() }));

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
