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
    'Why do I keep overspending?',
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
    /* autopay / automatic payments */
    if (has('autopay', 'auto-pay', 'auto pay', 'automatic', 'automate')) return `Yes — automate it, ${name}. ⚙️ Set <strong>automatic payments for at least the minimum on every debt</strong>, timed a day or two after payday. Why it matters:<br><br>1️⃣ You never miss a due date — no $30 late fees, no penalty APR hikes<br>2️⃣ On-time payments protect your payment history (the biggest slice of a credit score)<br>3️⃣ Your plan keeps working in your busiest, most distracted months<br><br>Two guardrails: keep a small <strong>buffer in checking</strong> so autopay never overdrafts, and check the first automated statement to confirm it actually ran. Want to go further? Automate your extra payment to <strong>${target ? esc(target.name) : 'your top target'}</strong> too — then the whole plan runs itself. Set it up and claim your ⚙️ Autopilot badge on the Plan tab!<br><br>Not comfortable with autopay? Grab <strong>calendar reminders</strong> from the Plan tab instead — monthly alerts 3 days and 1 day before each payment, ready for Google, Apple, or Outlook calendars.`;
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
    /* ---- behavioral traps: the habits that build unmanageable debt ---- */
    /* emotional spending */
    if (!has('motivat') && has('emotional', 'overspend', 'stress spend', 'stressed', 'boredom', 'bored', 'retail therapy', 'shopping when', 'sad spend')) {
      return `The spending usually isn't about the thing, ${name} — it's about the feeling underneath. That's not a character flaw; it's how brains are wired. The fix isn't willpower, it's a pause:<br><br>🛑 <strong>The 24-hour rule:</strong> want it? Wait a day. Still want it tomorrow? Then it was a real want, not a feeling.<br>📝 <strong>Name it first:</strong> "I'm stressed, not under-accessorized." Feelings pass faster once they're named.<br>🔁 <strong>Swap the hit:</strong> the dopamine comes from the <em>buying</em>, not the owning — a walk, a finished chore, or a call with someone you like gives the same lift for free.<br><br>For one week, jot down what you were feeling before each unplanned purchase. You'll see your pattern — and patterns can be redesigned. What's been triggering yours lately?`;
    }
    /* lifestyle inflation / keeping up */
    if (has('lifestyle', 'keeping up', 'deserve it', 'i deserve', 'lifestyle creep')) {
      return `Lifestyle inflation is the quietest debt-builder there is, ${name} — every raise becomes a nicer car, a bigger place, a fancier brunch, and the debt-free date never moves closer. Try the <strong>50/50 rule</strong>: half of every raise, bonus, or new income goes to your debt target; you keep the other half to enjoy. You still feel the raise — but your finish line moves too.<br><br>The reframe: it's not "I can't have nice things." It's "I'm buying my freedom date first, then the nice things with cash." Which upgrade has been tempting you most? Let's run what killing it does to your date. 📅`;
    }
    /* money avoidance */
    if (has('afraid', 'scared to look', 'head in the sand', 'avoid looking', "haven't looked", 'too scared', 'anxiety about money')) {
      return `You're not alone in this, ${name} — most people with growing debt avoid looking at it, and avoiding it is exactly what lets it grow. Here's the way back in:<br><br>📅 <strong>The 10-minute money date:</strong> same time every week, just <em>look</em> — balances, due dates, nothing else. No fixing, no judging. Looking is the brave part; the numbers are just numbers.<br><br>Your debt grows in the dark and shrinks the moment you turn the light on. You already did the hardest part by opening this app. Want to do this week's money date together right now?`;
    }
    /* BNPL stacking */
    if (has('afterpay', 'klarna', 'affirm', 'bnpl', 'pay in 4', 'buy now pay later', 'split it into payments')) {
      return `Buy-now-pay-later feels like free money because each plan is "only" $35 — but six plans at once is a $210 invisible bill with four different due dates, ${name}. That's the stacking trap.<br><br>Do this today:<br>1️⃣ List every active split-payment plan with its remaining payments<br>2️⃣ Add the total — that's a real debt; add it to your list in the app so your plan sees it<br>3️⃣ New rule: <strong>no new split payments until the existing ones are dead</strong><br><br>BNPL isn't evil — it's just debt wearing a friendly costume. Once it's all in one place, your payoff order handles it like everything else. How many active plans do you have right now?`;
    }
    /* social pressure spending */
    if (has('fomo', 'peer pressure', 'keeping up with', 'brunch', 'everyone else is', 'they all have', "can't afford the trip", 'girls trip', 'bachelor')) {
      return `Real talk, ${name}: most people respect a boundary way more than we fear they'll judge it. And the brunch you can't afford is forgotten in a week — the interest on it isn't. Keep these in your pocket:<br><br>💬 <strong>"Not in the budget this month — next time!"</strong> (a complete sentence, no apology needed)<br>💬 <strong>"I'll sit this one out, but let's do [cheaper thing] Saturday?"</strong> — you keep the friendship, skip the bill<br><br>The people worth keeping don't keep score on your spending. And every "no" to a $80 brunch is $80 closer to never needing to say no again. Which invitation has been stressing you out?`;
    }
    /* all-or-nothing thinking */
    if (has('blew it', 'ruined everything', 'all or nothing', 'messed up', 'off the wagon', 'one mistake', 'whats the point')) {
      return `Your plan isn't glass, ${name} — it's a road. One detour doesn't total the car. Let's do the actual math instead of the shame math: a $200 overspend on a $20,000 payoff plan moves your debt-free date by roughly <strong>two weeks</strong> — not to "never."<br><br>The danger was never the slip; it's the story "I already blew it, so why bother" — <em>that's</em> what turns $200 into $2,000. So:<br>1️⃣ Log what happened (no judgment, just data)<br>2️⃣ Look at your date — it's still there<br>3️⃣ Keep driving<br><br>Perfection was never the plan. Persistence is. What tripped you up?`;
    }
    /* procrastination */
    if (has('procrastinat', "i'll start", 'i will start', 'someday', 'start tomorrow', "haven't started", 'never get around')) {
      return `Here's the secret about motivation, ${name}: it follows action, it doesn't come before it. You don't need to feel ready — you need a first step so small it feels silly:<br><br>⏱️ <strong>The 10-minute start:</strong> enter just <em>one</em> debt in the app. That's it. One debt, ten minutes, done.<br><br>Starting imperfectly beats planning perfectly, because "someday" has no debt-free date and today does. Your date is already calculated — it's just waiting for you to start the clock. Want to enter that first debt together right now?`;
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
