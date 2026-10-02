/* ============================================================
   DebtFree Coach v2 — shared payoff engine + formatting helpers.
   Pure functions, no DOM. Loaded by the Node server AND the browser
   (UMD wrapper), so demo mode and server math can never drift apart.
   Ported exactly from v1's engine.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DFCPayoff = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => '$' + Math.round(n).toLocaleString('en-US');
  function monthName(offset) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset);
    return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
  }

  const activeDebts = debts => debts.filter(d => d.balance > 0.005);
  const totalDebt = debts => debts.reduce((a, d) => a + d.balance, 0);
  const totalMins = debts => debts.reduce((a, d) => a + d.min, 0);

  function priorityOrder(debts, strategy) {
    return [...debts].sort((a, b) => strategy === 'avalanche'
      ? ((b.apr - a.apr) || (a.balance - b.balance))
      : ((a.balance - b.balance) || (b.apr - a.apr)));
  }

  /* Simulate: pay every minimum, then throw (extra + freed minimums) at the
     priority target each month. Returns months, total interest, per-debt payoff month. */
  function simulatePayoff(debts, extra, strategy) {
    const ds = debts.map(d => ({ ...d }));
    const pri = priorityOrder(ds, strategy);
    const payoff = {}; const done = new Set();
    let month = 0, interest = 0, rollover = 0;
    const MAX = 600;
    while (ds.some(d => d.balance > 0.005) && month < MAX) {
      month++;
      ds.forEach(d => { if (d.balance > 0.005) { const i = d.balance * d.apr / 100 / 12; d.balance += i; interest += i; } });
      ds.forEach(d => { if (d.balance > 0.005) { d.balance -= Math.min(d.min, d.balance); if (d.balance < 0.005) d.balance = 0; } });
      let budget = extra + rollover, guard = 0;
      while (budget > 0.005 && guard++ < 100) {
        const t = pri.find(d => d.balance > 0.005); if (!t) break;
        const p = Math.min(budget, t.balance); t.balance -= p; budget -= p;
        if (t.balance < 0.005) t.balance = 0;
      }
      ds.forEach(d => { if (d.balance <= 0.005 && !done.has(d.id)) { done.add(d.id); payoff[d.id] = month; rollover += d.min; } });
    }
    const stalled = month >= MAX;
    return { months: stalled ? Infinity : month, interest, payoff, stalled };
  }

  return { esc, money, monthName, activeDebts, totalDebt, totalMins, priorityOrder, simulatePayoff };
}));
