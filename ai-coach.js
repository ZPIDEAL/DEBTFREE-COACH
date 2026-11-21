/* ============================================================
   DebtFree Coach v2 — AI coach (Anthropic Claude).
   Server-only module: the API key must never reach the browser.
   Requires ANTHROPIC_API_KEY in the environment (Render dashboard,
   declared sync:false in render.yaml). No key -> aiConfigured()
   is false and the /api/chat route keeps using the rule-based
   coach in shared/coach.js, so chat never breaks.

   Design (Nov 8, 2026):
   - Exact payoff math stays deterministic: /api/chat runs the
     rule-based coachReply first. Only when it hits its generic
     fallback ("didn't quite catch that one") does the question
     go to Claude. The LLM never invents balances or dates —
     it gets a short summary of the user's real plan and is
     told to ground every number in it.
   - Model: claude-haiku-5-5 (cheapest current Claude, $0.10
     input / $0.50 output per million tokens, prompts <=100K).
     A typical chat message costs a fraction of a cent.
   - Caps: 600 output tokens per reply (short answers), plus
     50 AI replies per user per day (in-memory; resets on
     server restart, which is fine at this scale). The existing
     express rate limiter (chatLimiter, 40/min) still applies.
   - Privacy: the summary carries totals, strategy, and the
     top target debt — never the user's name or email.
   ============================================================ */
'use strict';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const AI_MODEL = 'claude-haiku-5-5';
const AI_MAX_TOKENS = 600;
const AI_TIMEOUT_MS = 20000;
const AI_DAILY_CAP = 50;

function aiConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/* The rule-based coach's generic fallback — the routing signal:
   when coachReply returns this, the question goes to Claude. */
function isFallbackReply(reply) {
  return typeof reply === 'string' && reply.includes("didn't quite catch that one");
}

/* Short plan summary for the model. Totals and strategy only —
   never the user's name or email. */
function planSummary(profile, debts, plan) {
  const p = profile || {};
  const ds = Array.isArray(debts) ? debts : [];
  const active = ds.filter(d => Number(d.balance) > 0);
  const highestApr = active.length ? Math.max(...active.map(d => Number(d.apr) || 0)) : 0;
  const order = [...active].sort((a, b) => {
    if ((p.strategy || 'avalanche') === 'snowball') return Number(a.balance) - Number(b.balance);
    return Number(b.apr) - Number(a.apr);
  });
  const top = order[0] || null;
  const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  const lines = [
    `Total debt: ${money(plan && plan.totalDebt)} across ${active.length} active debt(s).`,
    `Strategy: ${(plan && plan.strategy) || p.strategy || 'avalanche'}; extra payment: ${money((plan && plan.extra) || p.extra || 0)}/month; minimums total: ${money((plan && plan.totalMins) || 0)}/month.`,
    plan && plan.months
      ? `Debt-free date: ${plan.months} months from now; total interest ahead: ${money(plan.interest)}.`
      : `At minimums only, the payoff math does not close right now (minimums do not cover the interest).`,
    top
      ? `Top payoff target: ${top.name}, ${money(top.balance)} at ${top.apr}% APR.`
      : `No active debts.`,
    `Highest APR in the mix: ${highestApr}%.`,
    `Cash savings right now: ${money(p.savings || 0)}; monthly expenses: ${money(p.expenses || 0)}.`,
    p.has401k === 'yes'
      ? `Has a workplace retirement plan; getting the full employer match: ${p.match === 'yes' ? 'yes' : 'no'}.`
      : `No workplace retirement plan.`,
  ];
  return lines.join('\n');
}

function systemPrompt(summary) {
  return [
    'You are the DebtFree Coach chat assistant inside a debt-payoff app. Be direct, short, and encouraging. Plain words, no jargon. Keep replies under about 150 words.',
    'You are financial education, not a financial advisor. Never give personalized investment advice, never tell the user what to buy, and never name specific stocks, funds, ETFs, or tickers. Never claim to be a licensed advisor.',
    'Ground every number in the plan summary below — never invent balances, APRs, or dates. If a question needs exact payoff math you cannot compute, say so plainly and point the user to the Plan tab what-if slider instead of guessing.',
    'If the user sounds discouraged or says they slipped, be kind first, then practical: minimums today, call the creditor about hardship options, re-run the plan tomorrow.',
    'Reply as short HTML the app renders directly: use <br> for line breaks and <strong> for emphasis. No markdown, no headings, no bullet characters.',
    '',
    'The user\'s current plan summary:',
    summary,
  ].join('\n');
}

/* Per-user daily AI-reply cap (in-memory). Returns true when the
   user still has budget left, and counts this reply. */
const _dailyCounts = new Map();
function checkAndCount(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${String(userId)}:${today}`;
  for (const k of [..._dailyCounts.keys()]) {
    if (!k.endsWith(`:${today}`)) _dailyCounts.delete(k);
  }
  const used = _dailyCounts.get(key) || 0;
  if (used >= AI_DAILY_CAP) return false;
  _dailyCounts.set(key, used + 1);
  return true;
}

/* One Claude call. fetchFn is injectable for tests; defaults to
   the global fetch. Never throws — failures return { ok: false }. */
async function askClaude(message, summary, opts = {}) {
  const fetchFn = opts.fetchFn || fetch;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'AI coach is not configured.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    /* Chris's Anthropic account requires the workspace header —
       the first live reply (Nov 15, 2026) only worked with it.
       Sent only when ANTHROPIC_WORKSPACE_ID is set in the
       environment (Render dashboard), so other setups are
       unaffected. */
    if (process.env.ANTHROPIC_WORKSPACE_ID) {
      headers['anthropic-workspace-id'] = process.env.ANTHROPIC_WORKSPACE_ID;
    }
    const res = await fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: AI_MAX_TOKENS,
        system: systemPrompt(summary),
        messages: [{ role: 'user', content: String(message).slice(0, 2000) }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `Claude API ${res.status}: ${String(detail).slice(0, 200)}` };
    }
    const data = await res.json();
    const text = Array.isArray(data.content)
      ? data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
      : '';
    if (!text) return { ok: false, error: 'Claude returned an empty reply.' };
    return { ok: true, reply: text };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'Claude request timed out.' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  AI_MODEL, AI_MAX_TOKENS, AI_DAILY_CAP,
  aiConfigured, isFallbackReply, planSummary, systemPrompt,
  checkAndCount, askClaude,
};
