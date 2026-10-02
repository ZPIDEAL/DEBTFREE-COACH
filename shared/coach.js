/* ============================================================
   DebtFree Coach v2 — rule-based, data-aware coach.
   Pure function: coachReply(message, {profile, debts}) -> HTML string.
   No DOM here; the browser and server both call it.
   Ported exactly from v1's coach logic.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./payoff'));
  } else {
    root.DFCCoach = factory(root.DFCPayoff);
  }
}(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';

  const { esc, money, monthName, activeDebts, totalDebt, totalMins, priorityOrder, simulatePayoff } = P;

  const CHIPS = [
    'What if I pay $200 extra?',
    'Should I invest or pay debt?',
    'Avalanche vs snowball?',
    'How am I doing?',
    'Motivate me 💪'
  ];

  function coachReply(input, ctx) {
    const t = String(input || '').toLowerCase();
    const p = ctx.profile, debts = ctx.debts || [];
    const name = esc(p.name || 'friend');
    const total = totalDebt(debts);
    const plan = simulatePayoff(activeDebts(debts), p.extra || 0, p.strategy || 'avalanche');
    const hiApr = debts.length ? Math.max(...debts.map(d => d.apr)) : 0;
    const order = priorityOrder(activeDebts(debts), p.strategy || 'avalanche');
    const target = order[0];

    const has = (...ws) => ws.some(w => t.includes(w));
    const numMatch = t.match(/\$?\s*(\d[\d,]*)\s*(extra|more|additional|a month)/) || t.match(/what if.*?\$?\s*(\d[\d,]*)/);
    const num = n => parseInt(String(n).replace(/,/g, ''), 10);

    /* what-if extra payment */
    if (has('what if', 'whatif') || (numMatch && has('extra', 'pay'))) {
      const x = numMatch ? num(numMatch[1]) : 200;
      if (!(x > 0)) return `Give me a number, ${name} — like "what if I pay $200 extra?"`;
      const alt = simulatePayoff(activeDebts(debts), x, p.strategy);
      const base = simulatePayoff(activeDebts(debts), 0, p.strategy);
      if (!isFinite(alt.months)) return `Even with ${money(x)}/mo extra, your minimums don't cover the interest right now — the balance would keep growing. We need a bigger number or a call to your creditors about hardship options. Want to try a larger amount?`;
      const saved = Math.max(0, base.interest - alt.interest);
      return `With <strong>${money(x)}/mo extra</strong> (${p.strategy}):<br>📅 Debt-free <strong>${monthName(alt.months)}</strong> (${alt.months} months)<br>💸 Interest saved vs. minimums: <strong>${money(saved)}</strong><br><br>That's the power of extra payments, ${name}. Want me to make ${money(x)} your new monthly target?`;
    }
    /* windfall */
    if (has('bonus', 'windfall', 'refund', 'inheritance', 'came into', 'extra cash', 'stimulus')) {
      const m = t.match(/\$?\s*(\d[\d,]*)/);
      if (!m) return `Nice — found money is a debt-killer. How much are we talking? (e.g. "I got a $1,500 bonus")`;
      const amt = num(m[1]);
      const ds = activeDebts(debts).map(d => ({ ...d }));
      const pri = priorityOrder(ds, p.strategy);
      let left = amt;
      for (const d of pri) { if (left <= 0) break; const pay = Math.min(left, d.balance); d.balance -= pay; left -= pay; }
      const alt = simulatePayoff(ds, p.extra, p.strategy);
      const saved = Math.max(0, plan.interest - alt.interest);
      return `If you throw that <strong>${money(amt)}</strong> at your debt (${p.strategy} order):<br>📅 New debt-free date: <strong>${isFinite(alt.months) ? monthName(alt.months) : '—'}</strong><br>💸 Interest saved: <strong>${money(saved)}</strong><br><br>Lump sums are the fastest shortcut there is, ${name}. Do it before lifestyle creep finds it. 😄`;
    }
    /* invest vs debt */
    if (has('invest')) {
      if (hiApr >= 15) return `With a <strong>${hiApr}% APR</strong> in the mix, ${name}: paying that down is a guaranteed ${hiApr}% return. The stock market has averaged ~10% with plenty of down years. <strong>Kill the high-APR debt first</strong> — then invest. The one exception: still grab your full 401(k) employer match if you have one. That's free money.`;
      if (hiApr >= 10) return `Your highest APR is <strong>${hiApr}%</strong> — right on the borderline. The textbook move: finish debts above ~10% first (guaranteed return), then split extra cash between remaining debt and investing. Check the "Debt vs. Investing" lesson in the Academy for the full math.`;
      return `Good news, ${name} — your highest APR is ${hiApr}%, so you're in the zone where investing while finishing debt makes sense. Keep minimums on everything, then split extra cash: some to debt, some automated into diversified index funds in a tax-advantaged account. The Academy's investing track walks you through it.`;
    }
    /* 401k / match */
    if (has('401', '403b', 'tsp', 'match')) {
      if (p.has401k === 'yes' && p.match !== 'yes') return `You told me you're <strong>not getting your full match</strong>, ${name} — that's the first thing to fix. A 100% match is an instant 100% return; nothing else you do with money beats it. Bump your contribution to the full match amount, then attack debt with the rest.`;
      return `The 401(k) match is free money, ${name} — often 50–100% of your contribution. Always contribute enough to capture 100% of it before sending extra to debt. Open the "Free Money" lesson in the Academy for the details.`;
    }
    /* roth */
    if (has('roth')) return `Roth = pay tax now, never pay tax on the growth. For most people starting out, a <strong>Roth IRA</strong> is the classic first investing account: tax-free growth, and you can withdraw contributions (not earnings) anytime without penalty. Annual limits apply — the Academy's Roth lesson has the details.`;
    /* index funds */
    if (has('index', 'etf', 's&p', 'diversif', 'mutual fund')) return `Index funds = owning a slice of hundreds of companies in one purchase. Why they work: instant diversification, tiny fees (look for expense ratios under ~0.2%), and no stock-picking needed — most pros fail to beat the index anyway. Automate a fixed amount each paycheck and let time do the work. Full lesson in the Academy. 📚`;
    /* emergency fund */
    if (has('emergency', 'rainy day', 'safety net')) return p.savings >= 1000
      ? `You've got ${money(p.savings)} saved — nice, that covers your starter safety net, ${name}. 🛟 Once debt is gone, grow it to 3–6 months of expenses (${money(p.expenses * 3)}–${money(p.expenses * 6)} for you) in a separate high-yield savings account.`
      : `You have ${money(p.savings)} saved, ${name}. Priority one: build a <strong>$1,000 starter safety net</strong> in a separate savings account — before extra debt payments. It stops the next surprise bill from becoming new 24% APR debt.`;
    /* APR explainer */
    if (has('what is apr', 'apr mean', "what's apr")) return `APR = Annual Percentage Rate — the yearly cost of borrowing. A 24% APR on a $4,000 balance costs you roughly <strong>$80/month in interest alone</strong> ($4,000 × 24% ÷ 12). That's why minimum payments feel like running on a treadmill. 🏃`;
    /* minimum payment trap */
    if (has('minimum', 'min payment', 'only the min')) return `Minimum payments are designed to keep you in debt, ${name} — on a high-APR card they can be 90%+ interest. Your minimums total about <strong>${money(totalMins(debts))}/mo</strong>. Every dollar above that attacks principal directly. Try the what-if slider on your Plan tab and watch the interest melt. 📉`;
    /* avalanche vs snowball */
    if (has('avalanche', 'snowball', 'which first', 'which debt', 'what order', 'strategy')) {
      const a = simulatePayoff(activeDebts(debts), p.extra, 'avalanche'), s = simulatePayoff(activeDebts(debts), p.extra, 'snowball');
      const diff = (isFinite(a.interest) && isFinite(s.interest)) ? Math.max(0, s.interest - a.interest) : 0;
      return `<strong>Avalanche ⚡</strong> (highest APR first): cheapest, fastest. <strong>Snowball ⛄</strong> (smallest balance first): quick wins, more motivation.<br><br>On <em>your</em> numbers, avalanche saves about <strong>${money(diff)}</strong> in interest vs. snowball. You're on <strong>${p.strategy}</strong> now — switch anytime on the Plan tab. Both beat minimums by a mile.`;
    }
    /* slipped / discouraged */
    if (has('slip', 'missed', 'late payment', 'fell off', 'gave up', 'discourag', 'depress', 'ashamed', 'embarrass')) {
      return `Hey — breathe, ${name}. 💛 One missed payment or rough month doesn't erase your plan; it just moves the date. Here's the reset:<br><br>1️⃣ Make at least the minimums <em>today</em> to stop fees<br>2️⃣ Call the creditor — hardship programs exist and they want your money, not your fees<br>3️⃣ Re-run your plan tomorrow with fresh eyes<br><br>If debt ever feels unmanageable, nonprofit credit counselors (like NFCC member agencies) help for free or nearly free. No shame in getting a co-pilot.`;
    }
    /* progress */
    if (has('how am i', 'progress', 'status', 'am i doing')) {
      return isFinite(plan.months)
        ? `You're on track, ${name}! 💪<br>💳 Remaining: <strong>${money(total)}</strong><br>📅 Debt-free: <strong>${monthName(plan.months)}</strong> (${plan.months} months)<br>💸 Total interest ahead: <strong>${money(plan.interest)}</strong><br><br>${target ? `Next target: <strong>${esc(target.name)}</strong> (${money(target.balance)} at ${target.apr}% APR).` : 'Every debt is cleared!'}`
        : `Right now your minimums don't cover the monthly interest, ${name} — the balance would grow. Let's fix the math: can you find any extra monthly amount, or should we talk about calling creditors for hardship rates?`;
    }
    /* debt-free date */
    if (has('debt-free', 'debt free', 'when will', 'when am i done', 'finish', 'payoff date'))
      return isFinite(plan.months)
        ? `On your current plan (${p.strategy}, ${money(p.extra)}/mo extra): <strong>${monthName(plan.months)}</strong> — ${plan.months} months from now, with ${money(plan.interest)} in total interest. Want to see it sooner? Ask "what if I pay $X extra?"`
        : `At minimums only, the math doesn't close right now, ${name}. Tell me any extra monthly amount and I'll give you a real date.`;
    /* motivation */
    if (has('motivat', 'encourage', 'inspire', 'keep going', 'tired', 'burnout', 'quit'))
      return `${name}, remember: every payment is buying back your future income. 💪<br><br>You're <strong>${money(total)}</strong> in debt today — but you're also ${money(totalMins(debts) + (p.extra || 0))}/mo closer every single month. Future-you is already grateful. One payment at a time. What's one small win we can log today?`;
    /* which debt first (generic) */
    if (has('which') && has('debt'))
      return target ? `Attack <strong>${esc(target.name)}</strong> first — ${money(target.balance)} at ${target.apr}% APR. That's your ${p.strategy} target. Minimums on everything else, every spare dollar here.` : `You're debt-free, ${name}! Time to point that payment at investing. 🎉`;
    /* greeting */
    if (/^(hi|hey|hello|yo|sup|good (morning|afternoon|evening))\b/.test(t))
      return `Hey ${name}! 👋 Ask me things like:<br>• "What if I pay $300 extra?"<br>• "Should I invest or pay debt?"<br>• "How am I doing?"<br>• "I got a $1,000 bonus — where should it go?"`;
    if (has('thank')) return `Anytime, ${name}! That's what I'm here for. 💪`;
    if (has('help', 'what can you'))
      return `I can:<br>📊 Run <strong>what-if scenarios</strong> ("what if I pay $300 extra?")<br>💰 Tell you where a <strong>windfall</strong> hits hardest<br>⚖️ Explain <strong>avalanche vs snowball</strong> on your numbers<br>📈 Teach <strong>investing basics</strong> matched to your situation<br>💛 Talk you through a <strong>rough month</strong><br>📝 Log payments from the Plan tab<br><br>Try one!`;
    /* fallback */
    return `Hmm, I'm a debt + investing-education coach, ${name} — money questions are my whole thing, but I didn't quite catch that one. 🤔<br><br>Try: "What if I pay $250 extra?", "Should I invest or pay debt?", or tap a suggestion below.`;
  }

  return { CHIPS, coachReply };
}));
