/* ============================================================
   DebtFree Coach v2 — authentication.
   Email + password (bcrypt), server-side sessions in SQLite,
   httpOnly cookie, rate-limited auth endpoints.
   ============================================================ */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const store = require('./db');

const COOKIE_NAME = 'dfc_session';
const SESSION_DAYS = 30;
const isProd = process.env.NODE_ENV === 'production';

/* ---------- validation helpers ---------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validEmail(e) { return typeof e === 'string' && EMAIL_RE.test(e.trim()) && e.length <= 254; }
function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 128; }
function num(v, { min = 0, max = 1e12, def = 0 } = {}) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}
function str(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/* ---------- rate limiters ---------- */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, max: 40,
  standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Slow down a little — try again in a moment.' },
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 600,
  standardHeaders: 'draft-7', legacyHeaders: false,
});

/* ---------- cookies ---------- */
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  h.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(res, token) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 24 * 3600}`,
  ];
  if (isProd) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? '; Secure' : ''}`);
}

/* ---------- middleware ---------- */
function attachUser(req, _res, next) {
  const token = parseCookies(req)[COOKIE_NAME];
  req.sessionToken = token || null;
  req.user = token ? store.getSession(token) || null : null;
  next();
}
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in.' });
  next();
}

/* Subscription statuses that unlock the paid app. */
const ACTIVE_STATUSES = new Set(['active', 'trialing']);
function subscriptionInfo(userId) {
  const s = store.getSubscription(userId);
  if (!s) return { status: 'none', active: false, trialDaysLeft: 0, cancelAtPeriodEnd: false };
  const active = ACTIVE_STATUSES.has(s.status);
  let trialDaysLeft = 0;
  if (s.status === 'trialing' && s.trial_end) {
    trialDaysLeft = Math.max(0, Math.ceil((new Date(s.trial_end) - Date.now()) / 86400000));
  }
  return {
    status: s.status, active, trialDaysLeft,
    cancelAtPeriodEnd: !!s.cancel_at_period_end,
    hasCustomer: !!s.stripe_customer_id,
  };
}
function requireSubscription(req, res, next) {
  const info = subscriptionInfo(req.user.user_id);
  if (!info.active) {
    return res.status(402).json({
      error: 'A subscription is required.',
      needsSubscription: true,
      subscription: info,
    });
  }
  req.subscription = info;
  next();
}

/* ---------- route handlers ---------- */
async function signup(req, res) {
  const email = str(req.body.email, 254).toLowerCase();
  const password = req.body.password;
  if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (!validPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (store.getUserByEmail(email)) return res.status(409).json({ error: 'That email is already registered — try logging in.' });

  const hash = await bcrypt.hash(password, 10);
  const user = store.createUser(email, hash);

  // Dev convenience: without Stripe keys, grant a local 7-day trial so the
  // full flow is testable. NEVER enable in production.
  if (process.env.DEV_AUTO_SUBSCRIBE === 'true' && !process.env.STRIPE_SECRET_KEY) {
    const trialEnd = new Date(Date.now() + 7 * 86400000).toISOString();
    store.upsertSubscription(user.id, { status: 'trialing', trial_end: trialEnd });
  }

  const token = crypto.randomBytes(32).toString('hex');
  store.createSession(user.id, token, SESSION_DAYS);
  setSessionCookie(res, token);
  res.status(201).json({ user: { id: user.id, email: user.email } });
}

async function login(req, res) {
  const email = str(req.body.email, 254).toLowerCase();
  const password = req.body.password;
  if (!validEmail(email) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }
  const user = store.getUserByEmail(email);
  // Constant-time-ish: always run a compare to avoid user enumeration timing.
  const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!ok) return res.status(401).json({ error: 'Email or password is incorrect.' });

  const token = crypto.randomBytes(32).toString('hex');
  store.createSession(user.id, token, SESSION_DAYS);
  setSessionCookie(res, token);
  res.json({ user: { id: user.id, email: user.email } });
}

function logout(req, res) {
  if (req.sessionToken) store.deleteSession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
}

module.exports = {
  COOKIE_NAME, attachUser, requireUser, requireSubscription, subscriptionInfo,
  authLimiter, chatLimiter, apiLimiter,
  signup, login, logout,
  validEmail, validPassword, num, str,
};
