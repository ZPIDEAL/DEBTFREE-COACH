/* ============================================================
   DebtFree Coach v2 — shared investing academy + personalized path.
   Pure data/functions, no DOM. Ported exactly from v1.
   EDUCATION ONLY: no specific stocks, funds, or tickers.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DFCAcademy = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ACADEMY = [
    { t: 'Emergency Funds: Your Financial Airbag', lvl: 'Start here',
      body: `<h4>Why it comes before investing</h4>
      <p>An emergency fund is cash that keeps a car repair or ER visit from becoming credit-card debt at 24% APR. It's not an investment — it's insurance you pay to yourself.</p>
      <h4>How much</h4><ul><li><strong>Starter:</strong> $1,000 while you're in debt</li><li><strong>Full:</strong> 3–6 months of essential expenses once debt is gone</li></ul>
      <h4>Where to keep it</h4><p>A separate high-yield savings account — not your checking account where you'll spend it, and not invested where it can drop 20% the month you need it.</p>
      <h4>Key takeaway</h4><p>Cash savings earning 4% while you carry 24% debt still wins, because the fund's job is preventing <em>new</em> debt, not earning returns.</p>` },
    { t: 'Debt vs. Investing: The Only Math That Matters', lvl: 'Core concept',
      body: `<h4>The comparison</h4><p>Paying down a 24% APR credit card is a <strong>guaranteed, risk-free 24% return</strong>. The stock market has historically averaged roughly 10% per year before inflation (~7% after) — with plenty of down years mixed in. Guaranteed 24% beats possible 10% every time.</p>
      <h4>The rule of thumb</h4><ul><li>Debt above ~10% APR → pay it before investing (beyond grabbing your 401(k) match)</li><li>Debt at 4–7% (like many mortgages) → reasonable people split between extra payments and investing</li><li>Debt under ~4% → investing the difference is usually mathematically favored</li></ul>
      <h4>Key takeaway</h4><p>Interest is a return in reverse. Kill the expensive kind first, then let compounding work <em>for</em> you instead of against you.</p>` },
    { t: 'Free Money: The 401(k) Match', lvl: 'Core concept',
      body: `<h4>What it is</h4><p>Many employers match your retirement contributions — commonly 50% or 100% of what you put in, up to a few percent of your salary. A 100% match is an instant 100% return before the market does anything.</p>
      <h4>How to not leave money behind</h4><ul><li>Find your plan's match formula (HR or your plan website)</li><li>Contribute at least enough to capture the <em>full</em> match</li><li>Check vesting: some matches require you to stay 2–3 years to fully keep them</li></ul>
      <h4>Key takeaway</h4><p>The match beats extra debt payments mathematically. Fund it first, then attack debt with what's left.</p>` },
    { t: 'Roth vs. Traditional: Pay Tax Now or Later?', lvl: 'Accounts',
      body: `<h4>The one-sentence version</h4><p><strong>Roth:</strong> pay tax now, never pay tax on the growth. <strong>Traditional:</strong> get a tax break now, pay tax when you withdraw in retirement.</p>
      <h4>Who tends to prefer Roth</h4><ul><li>Younger / lower-income earners (your tax rate now is likely lower than later)</li><li>Anyone who wants tax-free withdrawals in retirement</li><li>Roth IRAs also let you withdraw <em>contributions</em> (not earnings) anytime without penalty — flexibility traditional accounts don't offer</li></ul>
      <h4>Watch the limits</h4><p>IRAs have annual contribution limits and Roth eligibility phases out at higher incomes. Limits change yearly — check current IRS figures.</p>
      <h4>Key takeaway</h4><p>For most people starting out, Roth is the simpler, more flexible first account. The best account is the one you actually fund consistently.</p>` },
    { t: 'Index Funds & Diversification', lvl: 'Investing basics',
      body: `<h4>What an index fund is</h4><p>One purchase that owns a slice of hundreds or thousands of companies at once. Instead of betting on one company, you own a piece of the whole market's growth.</p>
      <h4>Why beginners do well with them</h4><ul><li><strong>Diversification:</strong> one company collapsing barely dents you</li><li><strong>Low cost:</strong> look for expense ratios under ~0.2% — fees compound against you just like interest</li><li><strong>No stock-picking required:</strong> most professional fund managers fail to beat the index over time</li></ul>
      <h4>Dollar-cost averaging</h4><p>Investing a fixed amount on a schedule (every paycheck) means you automatically buy more shares when prices are low and fewer when high. It removes timing decisions entirely.</p>
      <h4>Key takeaway</h4><p>Broad, cheap, automatic. That's the entire strategy most people ever need.</p>` },
    { t: 'Opening Your First Brokerage Account', lvl: 'Action steps',
      body: `<h4>Checklist</h4><ul><li>No account minimums or monthly fees</li><li>Fractional shares (invest $50, not $500 per share)</li><li>Commission-free trades and low-cost index funds available</li><li>Offers the account type you want (Roth IRA, traditional IRA, taxable)</li></ul>
      <h4>Behavioral rules that matter more than the account</h4><ul><li><strong>Automate:</strong> scheduled transfers beat willpower</li><li><strong>Don't panic-sell:</strong> every historical crash has eventually recovered; selling locks in the loss</li><li><strong>Ignore hot tips:</strong> if a stranger is excited about a stock, you're the exit liquidity</li></ul>
      <h4>Key takeaway</h4><p>Open it, automate it, then mostly leave it alone. Wealth is built by consistency, not cleverness.</p>
      <p class="fineprint">Educational content only — not financial, tax, or investment advice.</p>` }
  ];

  /* Personalized investing path, ordered by the user's actual situation. */
  function buildPath(profile, debts) {
    const steps = [];
    const hiApr = debts.length ? Math.max(...debts.map(d => d.apr)) : 0;
    if (profile.savings < 1000)
      steps.push(['🛟 Starter safety net', 'Build $1,000 in a separate savings account first. Without it, every surprise bill becomes new debt.']);
    if (hiApr >= 10)
      steps.push(['⚔️ Kill high-interest debt first', `Your highest APR is ${hiApr}%. Paying that down is a guaranteed ${hiApr}% return — no investment in history has averaged that. Clear debts above ~10% APR before investing beyond your 401(k) match.`]);
    if (profile.has401k === 'yes' && profile.match !== 'yes')
      steps.push(['💰 Capture the full 401(k) match', 'An employer match is an instant 50–100% return on your contribution. Raise your contribution to grab every matched dollar — this beats extra debt payments mathematically.']);
    if (profile.has401k === 'no')
      steps.push(['🏦 Plan your first retirement account', 'Once high-interest debt is gone, a Roth IRA is the classic first investing account. Learn how it works in the Academy below.']);
    steps.push(['🎯 Finish the debt exit plan', `Every extra dollar follows your ${profile.strategy} order until balances hit zero. Boring, automatic, effective.`]);
    steps.push(['🛟 Grow the emergency fund to 3–6 months', 'With debt gone, redirect your old debt payment straight into savings until you have 3–6 months of expenses covered.']);
    steps.push(['📈 Begin diversified index-fund investing', 'Automate a monthly investment into low-cost, diversified index funds inside a tax-advantaged account. Time in the market beats timing the market.']);
    return steps;
  }

  return { ACADEMY, buildPath };
}));
