/* ============================================================
   DebtFree Coach v2 — SQLite storage (better-sqlite3, zero-config).
   Tables: users, sessions, profiles, debts, payments, subscriptions.
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/debtfree.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  income REAL NOT NULL DEFAULT 0,
  expenses REAL NOT NULL DEFAULT 0,
  savings REAL NOT NULL DEFAULT 0,
  has401k TEXT NOT NULL DEFAULT 'no',
  match TEXT NOT NULL DEFAULT 'unknown',
  goal TEXT NOT NULL DEFAULT '',
  experience TEXT NOT NULL DEFAULT '',
  extra REAL NOT NULL DEFAULT 0,
  strategy TEXT NOT NULL DEFAULT 'avalanche',
  onboarded INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS debts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  balance REAL NOT NULL,
  apr REAL NOT NULL DEFAULT 0,
  min REAL NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_debts_user ON debts(user_id);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  debt_id INTEGER REFERENCES debts(id) ON DELETE SET NULL,
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'none',
  trial_end TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* Prune expired sessions opportunistically (cheap, runs on boot + hourly). */
function pruneSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
}
pruneSessions();
setInterval(pruneSessions, 60 * 60 * 1000).unref();

/* ---- users ---- */
const getUserByEmail = email =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
const getUserById = id =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(id);
function createUser(email, passwordHash) {
  const r = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
    .run(email.toLowerCase(), passwordHash);
  return getUserById(r.lastInsertRowid);
}

/* ---- sessions ---- */
function createSession(userId, token, daysValid = 30) {
  db.prepare(`INSERT INTO sessions (token, user_id, expires_at)
              VALUES (?, ?, datetime('now', '+' || ? || ' days'))`)
    .run(token, userId, daysValid);
}
function getSession(token) {
  return db.prepare(`SELECT s.*, u.email FROM sessions s
                     JOIN users u ON u.id = s.user_id
                     WHERE s.token = ? AND s.expires_at > datetime('now')`).get(token);
}
function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/* ---- profiles ---- */
const getProfile = userId =>
  db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
function upsertProfile(userId, p) {
  db.prepare(`INSERT INTO profiles
      (user_id, name, income, expenses, savings, has401k, match, goal, experience, extra, strategy, onboarded, updated_at)
      VALUES (@user_id, @name, @income, @expenses, @savings, @has401k, @match, @goal, @experience, @extra, @strategy, 1, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        name=excluded.name, income=excluded.income, expenses=excluded.expenses,
        savings=excluded.savings, has401k=excluded.has401k, match=excluded.match,
        goal=excluded.goal, experience=excluded.experience, extra=excluded.extra,
        strategy=excluded.strategy, onboarded=1, updated_at=datetime('now')`)
    .run({ user_id: userId, ...p });
  return getProfile(userId);
}

/* ---- debts ---- */
const getDebts = userId =>
  db.prepare('SELECT * FROM debts WHERE user_id = ? ORDER BY position, id').all(userId);
function addDebt(userId, d) {
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM debts WHERE user_id = ?').get(userId).p;
  const r = db.prepare(`INSERT INTO debts (user_id, name, balance, apr, min, position)
                        VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, d.name, d.balance, d.apr, d.min, pos);
  return db.prepare('SELECT * FROM debts WHERE id = ?').get(r.lastInsertRowid);
}
function updateDebt(userId, id, d) {
  const r = db.prepare(`UPDATE debts SET name=?, balance=?, apr=?, min=?
                        WHERE id=? AND user_id=?`)
    .run(d.name, d.balance, d.apr, d.min, id, userId);
  return r.changes > 0 ? db.prepare('SELECT * FROM debts WHERE id=?').get(id) : null;
}
function deleteDebt(userId, id) {
  return db.prepare('DELETE FROM debts WHERE id=? AND user_id=?').run(id, userId).changes > 0;
}
function setDebtBalance(userId, id, balance) {
  db.prepare('UPDATE debts SET balance=? WHERE id=? AND user_id=?').run(balance, id, userId);
  return db.prepare('SELECT * FROM debts WHERE id=?').get(id);
}

/* ---- payments log ---- */
function logPayment(userId, debtId, amount, note = '') {
  const r = db.prepare('INSERT INTO payments (user_id, debt_id, amount, note) VALUES (?, ?, ?, ?)')
    .run(userId, debtId, amount, note);
  return db.prepare('SELECT * FROM payments WHERE id=?').get(r.lastInsertRowid);
}

/* ---- subscriptions ---- */
const getSubscription = userId =>
  db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId);
function upsertSubscription(userId, s) {
  db.prepare(`INSERT INTO subscriptions
      (user_id, stripe_customer_id, stripe_subscription_id, status, trial_end, current_period_end, cancel_at_period_end, updated_at)
      VALUES (@user_id, @stripe_customer_id, @stripe_subscription_id, @status, @trial_end, @current_period_end, @cancel_at_period_end, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        stripe_customer_id=COALESCE(excluded.stripe_customer_id, stripe_customer_id),
        stripe_subscription_id=COALESCE(excluded.stripe_subscription_id, stripe_subscription_id),
        status=excluded.status, trial_end=excluded.trial_end,
        current_period_end=excluded.current_period_end,
        cancel_at_period_end=excluded.cancel_at_period_end,
        updated_at=datetime('now')`)
    .run({
      user_id: userId,
      stripe_customer_id: s.stripe_customer_id || null,
      stripe_subscription_id: s.stripe_subscription_id || null,
      status: s.status || 'none',
      trial_end: s.trial_end || null,
      current_period_end: s.current_period_end || null,
      cancel_at_period_end: s.cancel_at_period_end ? 1 : 0,
    });
  return getSubscription(userId);
}
function setSubscriptionStatus(userId, status) {
  db.prepare(`INSERT INTO subscriptions (user_id, status) VALUES (?, ?)
              ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, updated_at=datetime('now')`)
    .run(userId, status);
}

/* ---- full reset (profile + debts + payments; keeps account & subscription) ---- */
function resetUserData(userId) {
  const tx = db.transaction(uid => {
    db.prepare('DELETE FROM payments WHERE user_id=?').run(uid);
    db.prepare('DELETE FROM debts WHERE user_id=?').run(uid);
    db.prepare('DELETE FROM profiles WHERE user_id=?').run(uid);
  });
  tx(userId);
}

module.exports = {
  db, getUserByEmail, getUserById, createUser,
  createSession, getSession, deleteSession,
  getProfile, upsertProfile,
  getDebts, addDebt, updateDebt, deleteDebt, setDebtBalance,
  logPayment, getSubscription, upsertSubscription, setSubscriptionStatus,
  resetUserData,
};
