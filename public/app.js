/* ============================================================
   DebtFree Coach v2 — frontend.
   Two modes:
     - account: logged-in subscriber, everything via the JSON API
     - demo:    in-memory only (nothing persisted), uses the shared
                engine modules directly — no account needed
   ============================================================ */
'use strict';

const $ = id => document.getElementById(id);
const P = window.DFCPayoff;
const C = window.DFCCoach;
const A = window.DFCAcademy;

let MODE = 'account';            // 'account' | 'demo'
let ME = null;                   // /api/me payload
let PROFILE = null;              // cached full profile (account mode)
let DEBTS = [];                  // cached debts (account mode)
let DEMO = null;                 // {profile, debts, chatBooted} (demo mode)
let appInit = false, obInit = false;

/* ---------------- API client ---------------- */
async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch (_) { /* non-JSON */ }
  if (r.status === 401) { showScreen('screen-landing'); throw new Error('Please log in.'); }
  if (r.status === 402 && data && data.needsSubscription) { showScreen('screen-subscribe'); throw new Error('Subscription required.'); }
  if (!r.ok) throw new Error((data && data.error) || `Request failed (${r.status}).`);
  return data;
}

/* ---------------- screens ---------------- */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}
function switchTab(id) {
  document.querySelector('.nav-btn[data-tab="' + id + '"]').click();
}

/* ============================================================
   BOOT
   ============================================================ */
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  wireStatic();
  const params = new URLSearchParams(location.search);
  try {
    ME = await api('GET', '/api/me');
  } catch (e) { ME = { user: null }; }
  if (params.get('subscribed') === '1') {
    history.replaceState(null, '', '/app');
    try { ME = await api('GET', '/api/me'); } catch (e) { /* keep old */ }
  }
  if (params.get('blueprint') === '1' && params.get('session_id')) {
    const sid = params.get('session_id');
    history.replaceState(null, '', '/app');
    downloadBlueprint(sid).then(ok => {
      if (ok) setTimeout(() => alert('Your Blueprint is downloading.'), 300);
    });
  } else if (params.get('blueprint')) {
    history.replaceState(null, '', '/app');
  }
  if (!ME.user) { showScreen('screen-landing'); return; }
  if (!ME.subscription || !ME.subscription.active) { showScreen('screen-subscribe'); return; }
  if (!ME.onboarded) { showScreen('screen-onboard'); initOnboarding(); return; }
  enterApp();
}

/* Buttons that exist regardless of mode. */
function wireStatic() {
  document.querySelectorAll('.js-start-trial').forEach(b => b.onclick = () => { setAuthMode('signup'); showScreen('screen-auth'); });
  document.querySelectorAll('.js-demo').forEach(b => b.onclick = startDemo);
  $('auth-to-demo').onclick = startDemo;
  document.querySelectorAll('#screen-auth .seg-btn').forEach(b =>
    b.onclick = () => setAuthMode(b.dataset.mode));
  $('auth-submit').onclick = doAuth;
  $('auth-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth(); });
  $('auth-email').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth(); });
  $('btn-checkout').onclick = doCheckout;
  $('btn-logout-1').onclick = doLogout;
}

/* ============================================================
   AUTH
   ============================================================ */
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('#screen-auth .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode));
  $('auth-submit').textContent = mode === 'login' ? 'Log in →' : 'Create account →';
  $('terms-check').classList.toggle('hidden', mode !== 'signup');
  $('auth-error').classList.add('hidden');
}
function authError(msg) {
  const el = $('auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
async function doAuth() {
  const email = $('auth-email').value.trim();
  const password = $('auth-pass').value;
  if (!email || !password) { authError('Enter your email and password.'); return; }
  const body = { email, password };
  if (authMode === 'signup') {
    if (!$('auth-terms').checked) {
      authError('Please read and accept the Terms & Conditions, Privacy Policy, and No-Refund Policy.');
      return;
    }
    body.termsAccepted = true;
  }
  $('auth-submit').disabled = true;
  try {
    await api('POST', '/api/auth/' + authMode, body);
    $('auth-pass').value = '';
    await boot();
  } catch (e) { authError(e.message); }
  $('auth-submit').disabled = false;
}
async function doLogout() {
  try { await api('POST', '/api/auth/logout'); } catch (_) { /* ignore */ }
  location.href = '/';
}

/* ============================================================
   SUBSCRIBE (Stripe Checkout, 7-day trial)
   ============================================================ */
async function doCheckout() {
  $('checkout-error').classList.add('hidden');
  $('btn-checkout').disabled = true;
  try {
    const { url } = await api('POST', '/api/billing/checkout');
    location.href = url;
  } catch (e) {
    // Graceful when Stripe isn't configured (dev without keys).
    const note = $('billing-note');
    note.textContent = e.message;
    note.classList.remove('hidden');
    $('checkout-error').classList.remove('hidden');
    $('checkout-error').textContent = e.message;
  }
  $('btn-checkout').disabled = false;
}

/* ============================================================
   ONBOARDING (shared DOM, both modes)
   ============================================================ */
function initOnboarding() {
  if (obInit) { obGo(1); if (!$('ob-debts').children.length) addDebtRow(); return; }
  obInit = true;
  renderDots(1);
  if (MODE === 'demo') { if (!$('ob-debts').children.length) addDebtRow(); }
  else prefillObDraft(); // resume any saved draft from a previous session
  document.querySelectorAll('.ob-next').forEach(b => b.onclick = () => obNext(+b.dataset.from));
  document.querySelectorAll('.ob-back').forEach(b => b.onclick = () => obGo(+b.dataset.to));
  $('ob-add-debt').onclick = () => addDebtRow();
  document.querySelectorAll('#ob-goals .chip').forEach(c => c.onclick = () => selectOne('#ob-goals', c));
  document.querySelectorAll('#ob-exp .chip').forEach(c => c.onclick = () => selectOne('#ob-exp', c));
  $('ob-finish').onclick = finishOnboarding;
}
/* Restore a previously autosaved onboarding draft (if any). */
async function prefillObDraft() {
  let prof = null, debts = [];
  try {
    const [p, d] = await Promise.all([api('GET', '/api/profile'), api('GET', '/api/debts')]);
    prof = p.profile; debts = (d && d.debts) || [];
  } catch (e) { /* fall through to a blank form */ }
  if (prof) {
    if (prof.name) $('ob-name').value = prof.name;
    if (prof.income) $('ob-income').value = prof.income;
    if (prof.expenses) $('ob-expenses').value = prof.expenses;
    if (prof.savings) $('ob-savings').value = prof.savings;
    if (prof.extra) $('ob-extra').value = prof.extra;
    if (prof.has401k) $('ob-has401k').value = prof.has401k;
    if (prof.match) $('ob-match').value = prof.match;
    if (prof.goal) selectChip('#ob-goals', prof.goal);
    if (prof.experience) selectChip('#ob-exp', prof.experience);
  }
  $('ob-debts').innerHTML = '';
  if (debts.length) debts.forEach(d => addDebtRow(d)); else addDebtRow();
}
function selectChip(sel, val) {
  document.querySelectorAll(sel + ' .chip').forEach(c => c.classList.toggle('sel', c.dataset.val === val));
}
/* Best-effort autosave of the current wizard state (never blocks navigation). */
function collectObDraft() {
  return {
    draft: true,
    name: $('ob-name').value.trim(),
    income: +$('ob-income').value || 0,
    expenses: +$('ob-expenses').value || 0,
    savings: +$('ob-savings').value || 0,
    has401k: $('ob-has401k').value,
    match: $('ob-match').value,
    goal: chipVal('#ob-goals'),
    experience: chipVal('#ob-exp'),
    extra: +$('ob-extra').value || 0,
    strategy: 'avalanche',
  };
}
async function saveObDraft() {
  if (MODE === 'demo') return;
  try {
    await api('PUT', '/api/profile', collectObDraft());
    await api('PUT', '/api/debts', { debts: readDebtRows() });
  } catch (e) { /* draft save is best-effort; final submit validates */ }
}
function selectOne(sel, chip) {
  document.querySelectorAll(sel + ' .chip').forEach(x => x.classList.remove('sel'));
  chip.classList.add('sel');
}
function renderDots(n) {
  $('ob-dots').innerHTML = [1, 2, 3, 4, 5].map(i => `<span class="${i <= n ? 'on' : ''}"></span>`).join('');
}
function obGo(n) {
  document.querySelectorAll('.ob-step').forEach(s => s.classList.toggle('active', +s.dataset.step === n));
  renderDots(n);
  window.scrollTo(0, 0);
}
function obNext(from) {
  if (from === 1) {
    if (!$('ob-name').value.trim()) { alert('Tell your coach your name 🙂'); return; }
    if (+$('ob-income').value <= 0) { alert('Enter your monthly take-home pay.'); return; }
  }
  if (from === 2) {
    if (!readDebtRows().length) { alert('Add at least one debt (balance + minimum payment).'); return; }
  }
  if (from === 3) {
    if (+$('ob-expenses').value <= 0) { alert('Enter your total monthly expenses.'); return; }
  }
  saveObDraft(); // autosave progress so switching devices/browsers never loses it
  obGo(from + 1);
}
function addDebtRow(d) {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const div = document.createElement('div');
  div.className = 'debt-row';
  div.innerHTML =
    `<button class="debt-del" title="Remove">✕</button>
     <label>Nickname<input data-f="name" placeholder="e.g. Chase card" value="${esc(d && d.name)}"></label>
     <div class="grid2">
       <label>Balance ($)<input data-f="balance" type="number" min="0" step="1" placeholder="4200" value="${esc(d && d.balance)}"></label>
       <label>APR (%)<input data-f="apr" type="number" min="0" step="0.01" placeholder="24.99" value="${esc(d && d.apr)}"></label>
     </div>
     <label>Minimum payment ($/mo)<input data-f="min" type="number" min="0" step="1" placeholder="120" value="${esc(d && d.min)}"></label>`;
  div.querySelector('.debt-del').onclick = () => div.remove();
  $('ob-debts').appendChild(div);
}
function readDebtRows() {
  const out = []; let id = 0;
  document.querySelectorAll('#ob-debts .debt-row').forEach(r => {
    const g = f => r.querySelector(`[data-f="${f}"]`).value;
    const balance = +g('balance'), apr = +g('apr'), min = +g('min');
    if (balance > 0 && min > 0)
      out.push({ id: 'd' + (id++), name: (g('name').trim() || 'Debt ' + id), balance, apr: apr || 0, min });
  });
  return out;
}
function chipVal(sel) { const c = document.querySelector(sel + ' .chip.sel'); return c ? c.dataset.val : null; }

async function finishOnboarding() {
  const goal = chipVal('#ob-goals'), exp = chipVal('#ob-exp');
  if (!goal) { alert('Pick your #1 goal.'); return; }
  if (!exp) { alert('Pick your investing experience level.'); return; }
  const profile = {
    name: $('ob-name').value.trim(),
    income: +$('ob-income').value,
    expenses: +$('ob-expenses').value,
    savings: +$('ob-savings').value || 0,
    has401k: $('ob-has401k').value,
    match: $('ob-match').value,
    goal, experience: exp,
    extra: +$('ob-extra').value || 0,
    strategy: 'avalanche',
  };
  const debts = readDebtRows();
  if (MODE === 'demo') {
    DEMO = { profile, debts, chatBooted: false };
    enterApp();
    return;
  }
  $('ob-finish').disabled = true;
  try {
    PROFILE = (await api('PUT', '/api/profile', profile)).profile;
    DEBTS = (await api('PUT', '/api/debts', { debts })).debts; // replace (drafts may already exist)
    ME.onboarded = true;
    enterApp();
  } catch (e) { alert(e.message); }
  $('ob-finish').disabled = false;
}

/* ============================================================
   DEMO MODE — full app, in-memory only, no account
   ============================================================ */
function startDemo() {
  MODE = 'demo';
  DEMO = null;
  // reset onboarding form for a fresh run
  ['ob-name', 'ob-income', 'ob-expenses', 'ob-savings', 'ob-extra'].forEach(id => { $(id).value = ''; });
  $('ob-debts').innerHTML = '';
  document.querySelectorAll('#ob-goals .chip, #ob-exp .chip').forEach(c => c.classList.remove('sel'));
  showScreen('screen-onboard');
  initOnboarding();
}

/* ============================================================
   APP SHELL
   ============================================================ */
function ctx() {
  // unified read context for rendering: {profile, debts}
  return MODE === 'demo'
    ? { profile: DEMO.profile, debts: DEMO.debts }
    : { profile: PROFILE, debts: DEBTS.map(d => ({ id: String(d.id), name: d.name, balance: d.balance, apr: d.apr, min: d.min })) };
}

function enterApp() {
  showScreen('screen-app');
  renderBanner();
  initApp();
  refreshAll();
}

function renderBanner() {
  const b = $('sub-banner');
  b.className = 'sub-banner';
  if (MODE === 'demo') {
    b.classList.add('demo');
    b.innerHTML = `👀 <strong>Demo mode</strong> — nothing is saved. <button class="linklike" id="banner-signup">Sign up to keep your plan</button>`;
    $('banner-signup').onclick = () => { setAuthMode('signup'); showScreen('screen-auth'); };
    return;
  }
  const s = ME.subscription || {};
  if (s.status === 'trialing') {
    b.classList.add('trial');
    b.innerHTML = `🎉 <strong>Free trial:</strong> ${s.trialDaysLeft} day${s.trialDaysLeft === 1 ? '' : 's'} left — then $9.99/mo. Cancel anytime.`;
  } else if (s.status === 'past_due') {
    b.classList.add('pastdue');
    b.innerHTML = `⚠️ <strong>Payment failed.</strong> Update your payment method to keep access. <button class="linklike" id="banner-portal">Manage billing</button>`;
    $('banner-portal').onclick = openPortal;
  } else {
    b.classList.add('hidden');
  }
}

async function refreshAll() {
  if (MODE === 'account') {
    try {
      PROFILE = (await api('GET', '/api/profile')).profile;
      DEBTS = (await api('GET', '/api/debts')).debts;
    } catch (e) { /* banner/redirect handled by api() */ return; }
  }
  await renderDash();
  renderPath();
  renderAcademy();
  resetChat();
}

function initApp() {
  if (appInit) return;
  appInit = true;
  document.querySelectorAll('.nav-btn').forEach(b => b.onclick = () => {
    document.querySelectorAll('.nav-btn').forEach(x => {
      x.classList.remove('active');
      x.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    b.classList.add('active');
    b.setAttribute('aria-selected', 'true');
    $(b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'tab-coach') bootChat();
    window.scrollTo(0, 0);
  });
  // Arrow-key navigation across the tab list (WAI-ARIA tabs pattern)
  const tabBtns = [...document.querySelectorAll('.nav-btn')];
  document.querySelector('.bottom-nav').addEventListener('keydown', e => {
    const i = tabBtns.indexOf(document.activeElement);
    if (i < 0) return;
    let n = null;
    if (e.key === 'ArrowRight') n = (i + 1) % tabBtns.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabBtns.length) % tabBtns.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabBtns.length - 1;
    if (n !== null) { e.preventDefault(); tabBtns[n].focus(); tabBtns[n].click(); }
  });
  document.querySelectorAll('.seg-btn[data-strat]').forEach(b => b.onclick = () => setStrategy(b.dataset.strat));
  let whatifT = null;
  $('whatif-slider').oninput = () => {
    clearTimeout(whatifT);
    whatifT = setTimeout(updateWhatif, 200);
  };
  $('btn-reset').onclick = async () => {
    if (!confirm('Start over? This erases your plan.')) return;
    if (MODE === 'demo') { startDemo(); return; }
    try { await api('DELETE', '/api/reset'); } catch (e) { alert(e.message); return; }
    ME.onboarded = false;
    ['ob-name', 'ob-income', 'ob-expenses', 'ob-savings', 'ob-extra'].forEach(id => { $(id).value = ''; });
    $('ob-debts').innerHTML = '';
    document.querySelectorAll('#ob-goals .chip, #ob-exp .chip').forEach(c => c.classList.remove('sel'));
    showScreen('screen-onboard');
    initOnboarding();
  };
  $('btn-account').onclick = openAccountModal;
  $('acctmodal-close').onclick = () => $('acctmodal').classList.add('hidden');
  $('btn-portal').onclick = openPortal;
  $('btn-cancelflow').onclick = openCancelFlow;
  $('cancelmodal-close').onclick = closeCancelFlow;
  $('cf-keep-1').onclick = closeCancelFlow;
  $('cf-keep-2').onclick = closeCancelFlow;
  $('cf-done-close').onclick = closeCancelFlow;
  $('cf-reason-next').onclick = cfReasonNext;
  $('cf-downsell-monthly').onclick = () => cfApplyDownsell('monthly');
  $('cf-downsell-annual').onclick = () => cfApplyDownsell('annual');
  $('cf-downsell-decline').onclick = () => cfShow('oto');
  $('cf-oto-buy').onclick = cfBuyBlueprint;
  $('cf-oto-decline').onclick = () => cfShow('confirm');
  $('cf-confirm-yes').onclick = cfFinalCancel;
  $('btn-logout-2').onclick = doLogout;
  // payment log modal
  $('btn-log-payment').onclick = () => {
    const { debts } = ctx();
    $('pay-debt').innerHTML = debts.map(d =>
      `<option value="${d.id}">${P.esc(d.name)} — ${P.money(d.balance)}</option>`).join('');
    $('pay-amount').value = '';
    $('paymodal').classList.remove('hidden');
  };
  $('paymodal-close').onclick = () => $('paymodal').classList.add('hidden');
  $('pay-save').onclick = logPayment;
  $('modal-close').onclick = () => $('modal').classList.add('hidden');
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) $('modal').classList.add('hidden'); });
  $('chat-form').onsubmit = e => {
    e.preventDefault();
    const v = $('chat-text').value.trim();
    if (v) { $('chat-text').value = ''; handleUser(v); }
  };
}

async function openPortal() {
  try {
    const { url } = await api('POST', '/api/billing/portal');
    location.href = url;
  } catch (e) { alert(e.message); }
}

/* ---------------- CANCEL-SAVE FLOW ----------------
   reason -> (too_expensive ? downsell offer) -> Blueprint OTO -> confirm.
   The cancel button stays reachable on every step (FTC click-to-cancel). */
let CF = { reason: null, status: null };

function cfShow(step) {
  document.querySelectorAll('#cancelmodal .cf-step').forEach(s =>
    s.classList.toggle('hidden', s.dataset.cf !== step));
}

async function openCancelFlow() {
  $('acctmodal').classList.add('hidden');
  try {
    CF.status = await api('GET', '/api/billing/save-offer');
  } catch (e) { alert(e.message); return; }
  CF.reason = null;
  document.querySelectorAll('input[name="cf-reason"]').forEach(r => { r.checked = false; });
  if (!CF.status.eligible) {
    cfShow('done');
    $('cf-done-title').textContent = 'No active subscription.';
    $('cf-done-text').textContent = 'There is nothing to cancel on this account.';
  } else {
    cfShow('reason');
  }
  $('cancelmodal').classList.remove('hidden');
}

function closeCancelFlow() { $('cancelmodal').classList.add('hidden'); }

function cfReasonNext() {
  const sel = document.querySelector('input[name="cf-reason"]:checked');
  if (!sel) { alert('Pick the closest reason.'); return; }
  CF.reason = sel.value;
  if (CF.reason === 'too_expensive' && CF.status.downsellAvailable && CF.status.downsellConfigured) {
    cfShow('downsell');
  } else {
    cfShow('oto');
  }
}

async function cfApplyDownsell(choice) {
  const btn = choice === 'monthly' ? $('cf-downsell-monthly') : $('cf-downsell-annual');
  btn.disabled = true;
  try {
    await api('POST', '/api/billing/downsell', { choice });
    CF.status.downsellAvailable = false;
    cfShow('done');
    $('cf-done-title').textContent = choice === 'monthly' ? "You're staying at $7.99/mo." : "You're on the annual plan.";
    $('cf-done-text').textContent = "Your discount is applied. Thanks for sticking with us — let's kill that debt.";
    try { ME = await api('GET', '/api/me'); } catch (e) { /* keep old */ }
  } catch (e) { alert(e.message); }
  btn.disabled = false;
}

async function cfBuyBlueprint() {
  const btn = $('cf-oto-buy');
  btn.disabled = true;
  try {
    const { url } = await api('POST', '/api/billing/blueprint-checkout');
    location.href = url;
  } catch (e) { alert(e.message); btn.disabled = false; }
}

async function cfFinalCancel() {
  const btn = $('cf-confirm-yes');
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/billing/cancel', { reason: CF.reason || 'other' });
    cfShow('done');
    $('cf-done-title').textContent = 'Subscription canceled.';
    const when = r.cancelAt
      ? new Date(r.cancelAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'the end of your billing period';
    $('cf-done-text').textContent = `You keep full access until ${when}. No charge after that.`;
    try { ME = await api('GET', '/api/me'); } catch (e) { /* keep old */ }
  } catch (e) { alert(e.message); }
  btn.disabled = false;
}

async function downloadBlueprint(sessionId) {
  try {
    const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
    const r = await fetch(`/api/billing/blueprint${q}`, { credentials: 'same-origin' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'Download failed.');
    }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'debt-free-date-blueprint.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return true;
  } catch (e) { alert(e.message); return false; }
}
function openAccountModal() {
  if (MODE === 'demo') {
    $('acct-email').textContent = 'Demo mode — no account.';
    $('acct-sub').textContent = 'Sign up to save your plan and start your 7-day free trial.';
    $('btn-portal').style.display = 'none';
  } else {
    $('acct-email').textContent = ME.user.email;
    const s = ME.subscription || {};
    $('acct-sub').textContent = s.status === 'trialing'
      ? `Free trial — ${s.trialDaysLeft} days left, then $9.99/mo.`
      : `Subscription status: ${s.status}`;
    $('btn-portal').style.display = '';
  }
  $('acctmodal').classList.remove('hidden');
}

/* ---------------- DASHBOARD ---------------- */
async function setStrategy(strategy) {
  const c = ctx();
  if (c.profile.strategy === strategy) return;
  if (MODE === 'demo') {
    DEMO.profile.strategy = strategy;
  } else {
    try {
      PROFILE = (await api('PUT', '/api/profile', { ...PROFILE, strategy })).profile;
    } catch (e) { alert(e.message); return; }
  }
  await renderDash();
  renderPath();
}

/* Fetch (account) or compute (demo) the plan, then render. */
async function getPlan(extra, strategy) {
  if (MODE === 'demo') {
    const { profile, debts } = ctx();
    const ex = extra !== undefined ? extra : profile.extra;
    const st = strategy || profile.strategy;
    const sim = P.simulatePayoff(P.activeDebts(debts), ex, st);
    return {
      months: sim.stalled ? null : sim.months, stalled: sim.stalled,
      interest: Math.round(sim.interest * 100) / 100, payoff: sim.payoff,
      totalDebt: P.totalDebt(debts), extra: ex, strategy: st,
    };
  }
  const q = new URLSearchParams();
  if (extra !== undefined) q.set('extra', extra);
  if (strategy) q.set('strategy', strategy);
  return (await api('GET', '/api/plan' + (q.toString() ? '?' + q : ''))).plan;
}

async function renderDash() {
  const c = ctx();
  const p = c.profile;
  $('coach-greeting').textContent = `${p.name}'s plan · ${p.strategy === 'avalanche' ? 'Avalanche ⚡' : 'Snowball ⛄'}`;
  let plan;
  try { plan = await getPlan(); }
  catch (e) { return; /* api() already handled redirect */ }

  $('dash-total').textContent = P.money(plan.totalDebt);
  if (plan.stalled || plan.months === null) {
    $('dash-date').textContent = '⚠️ Never at this pace';
    $('dash-interest').textContent = '—';
    $('dash-months').textContent = '∞';
  } else {
    $('dash-date').textContent = P.monthName(plan.months);
    $('dash-interest').textContent = P.money(plan.interest);
    $('dash-months').textContent = plan.months;
  }
  document.querySelectorAll('.seg-btn[data-strat]').forEach(b =>
    b.classList.toggle('active', b.dataset.strat === p.strategy));
  $('strat-explainer').textContent = p.strategy === 'avalanche'
    ? 'Avalanche: every extra dollar attacks the highest APR first. Mathematically the cheapest and fastest way out.'
    : 'Snowball: every extra dollar attacks the smallest balance first. Costs a little more interest, but fast wins keep you motivated.';
  const order = P.priorityOrder(P.activeDebts(c.debts), p.strategy);
  $('payoff-order').innerHTML = order.length ? order.map((d, i) =>
    `<div class="payoff-item"><div><div class="po-name">${i + 1}. ${P.esc(d.name)}</div>` +
    `<div class="po-sub">${P.money(d.balance)} · ${d.apr}% APR · min ${P.money(d.min)}/mo</div></div>` +
    `<div class="po-badge">🎯<br>${plan.payoff[d.id] ? P.monthName(plan.payoff[d.id]) : '—'}</div></div>`
  ).join('') : '<p class="muted">No active debts — you did it! 🎉</p>';
  $('debt-list').innerHTML = c.debts.map(d =>
    `<div class="debt-line"><span>${P.esc(d.name)}</span><span><strong>${P.money(d.balance)}</strong> <span class="apr">${d.apr}%</span></span></div>`
  ).join('');
  $('whatif-slider').value = p.extra || 0;
  await updateWhatif();
}

async function updateWhatif() {
  const extra = +$('whatif-slider').value;
  $('whatif-amt').textContent = P.money(extra) + '/mo';
  const c = ctx();
  let base, alt;
  try {
    base = await getPlan(0, c.profile.strategy);
    alt = await getPlan(extra, c.profile.strategy);
  } catch (e) { return; }
  if (alt.stalled || alt.months === null) {
    $('whatif-date').textContent = 'still never at this pace ⚠️';
    $('whatif-saved').textContent = '$0';
  } else {
    $('whatif-date').textContent = `debt-free ${P.monthName(alt.months)} (${alt.months} months)`;
    $('whatif-saved').textContent = P.money(Math.max(0, base.interest - alt.interest));
  }
}

/* ---------------- PAYMENT LOGGING ---------------- */
async function logPayment() {
  const { profile, debts } = ctx();
  const debtId = $('pay-debt').value;
  const amt = +$('pay-amount').value;
  if (!(amt > 0)) { alert('Enter an amount.'); return; }
  const d = debts.find(x => String(x.id) === String(debtId));
  if (!d) { alert('Pick a debt.'); return; }

  let newBalance, plan;
  if (MODE === 'demo') {
    newBalance = Math.max(0, d.balance - amt);
    d.balance = newBalance;
    const sim = P.simulatePayoff(P.activeDebts(debts), profile.extra, profile.strategy);
    plan = { months: sim.stalled ? null : sim.months, stalled: sim.stalled, interest: sim.interest };
  } else {
    try {
      const r = await api('POST', '/api/payments', { debt_id: Number(debtId), amount: amt });
      newBalance = r.debt.balance;
      plan = r.plan;
      DEBTS = (await api('GET', '/api/debts')).debts;
    } catch (e) { alert(e.message); return; }
  }
  $('paymodal').classList.add('hidden');
  await renderDash();
  switchTab('tab-coach');
  userSay(`I just paid ${P.money(amt)} toward ${d.name}.`);
  const dateBit = (plan.months !== null && !plan.stalled)
    ? `New debt-free date: <strong>${P.monthName(plan.months)}</strong>.` : '';
  botSay(newBalance <= 0.005
    ? `🎉 <strong>${P.esc(d.name)} is PAID OFF!</strong> That minimum payment now rolls into your next target. ${dateBit}`
    : `Logged! ${P.esc(d.name)} is down to <strong>${P.money(newBalance)}</strong>. ${dateBit} Keep going, ${P.esc(profile.name)}. 💪`);
}

/* ---------------- INVESTING PATH + ACADEMY ---------------- */
function renderPath() {
  const { profile, debts } = ctx();
  const path = A.buildPath(profile, debts);
  $('invest-path').innerHTML = path.map(s =>
    `<li><strong>${s[0]}</strong><br><span class="muted small">${s[1]}</span></li>`).join('');
}
function renderAcademy() {
  const lessons = A.ACADEMY;
  $('academy-list').innerHTML = lessons.map((m, i) =>
    `<button class="academy-item" data-i="${i}"><span><span class="lvl">${m.lvl}</span><br><strong>${m.t}</strong></span><span>→</span></button>`
  ).join('');
  document.querySelectorAll('.academy-item').forEach(b => b.onclick = () => {
    const m = lessons[+b.dataset.i];
    $('modal-body').innerHTML = `<h2>${P.esc(m.t)}</h2>${m.body}`;
    $('modal').classList.remove('hidden');
  });
}

/* ---------------- COACH CHAT ---------------- */
function botSay(html) {
  const d = document.createElement('div');
  d.className = 'msg bot';
  d.innerHTML = html;
  $('chat-log').appendChild(d);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  // Announce the reply to screen readers without duplicating visible text
  $('chat-status').textContent = d.textContent;
}
function userSay(text) {
  const d = document.createElement('div');
  d.className = 'msg user';
  d.textContent = text;
  $('chat-log').appendChild(d);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
}
function resetChat() {
  $('chat-log').innerHTML = '';
  $('chat-status').textContent = '';
  renderChips();
  if (MODE === 'demo') DEMO.chatBooted = false;
  else { /* server chat is stateless; greet on first open */ window.__chatBooted = false; }
}
function renderChips() {
  $('chat-chips').innerHTML = C.CHIPS.map(c => `<button class="chip">${c}</button>`).join('');
  document.querySelectorAll('#chat-chips .chip').forEach(b => b.onclick = () => handleUser(b.textContent));
}
async function bootChat() {
  const booted = MODE === 'demo' ? DEMO.chatBooted : window.__chatBooted;
  if (booted) return;
  if (MODE === 'demo') DEMO.chatBooted = true; else window.__chatBooted = true;
  const { profile, debts } = ctx();
  let plan;
  try { plan = await getPlan(); } catch (e) { return; }
  const total = P.totalDebt(debts);
  setTimeout(() => botSay(
    `Hey ${P.esc(profile.name)}! 👋 I'm your debt coach. Here's your situation:<br><br>` +
    `💳 Total debt: <strong>${P.money(total)}</strong><br>` +
    `📅 Debt-free date: <strong>${plan.months !== null && !plan.stalled ? P.monthName(plan.months) : "not yet — let's fix that"}</strong><br>` +
    `💸 Interest on your current path: <strong>${plan.months !== null && !plan.stalled ? P.money(plan.interest) : 'growing'}</strong><br><br>` +
    `Ask me anything — try a what-if, log a payment, or tap a suggestion below.`), 400);
}
async function handleUser(text) {
  userSay(text);
  const { profile, debts } = ctx();
  if (MODE === 'demo') {
    setTimeout(() => botSay(C.coachReply(text, { profile, debts })), 400);
    return;
  }
  try {
    const { reply } = await api('POST', '/api/chat', { message: text });
    botSay(reply);
  } catch (e) {
    botSay(`Hmm, I hit a snag: ${P.esc(e.message)} — try again in a moment.`);
  }
}
