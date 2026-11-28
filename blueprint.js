/* ============================================================
   DebtFree Coach — "Debt-Free Date Blueprint" PDF generator.
   Personalized one-time-offer PDF built from the customer's own
   profile + debts + payoff simulation. Education only — not
   financial advice (disclaimer printed on every copy).

   The Blueprint is a complete, followable plan: cover summary,
   payoff order, execution steps, minimums comparison, and a full
   month-by-month schedule (payment + remaining balance per debt)
   generated from the same rules as shared/payoff.js's simulator,
   so the schedule always matches the simulator's totals.

   If the entered payments never pay the debt off (minimums don't
   cover interest), the plan is rebuilt at the smallest monthly
   payment that does finish, and the PDF says so plainly.
   ============================================================ */
'use strict';

const PDFDocument = require('pdfkit');
const store = require('./db');
const P = require('./shared/payoff');

const GREEN = '#16a34a';
const INK = '#1f2937';
const MUTED = '#6b7280';
const FAINT = '#e5e7eb';
const AMBER_BG = '#fef3c7';
const AMBER_INK = '#78350f';

const PORTRAIT = { size: 'LETTER', layout: 'portrait', margin: 56 };
const LANDSCAPE = { size: 'LETTER', layout: 'landscape', margin: 40 };

const money = n =>
  '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = n => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
const round2 = n => Math.round(Number(n || 0) * 100) / 100;

function payoffDate(months) {
  if (!months) return '—';
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/* Short label for schedule month N — computed exactly like payoffDate so
   the schedule and the payoff-order table can never disagree. */
function monthLabel(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/* ---------------------------------------------------------------
   Month-by-month simulation. Mirrors P.simulatePayoff's loop step
   for step (same interest accrual, same minimum payments, same
   extra-budget/rollover mechanics, same payoff bookkeeping) while
   also recording each month's per-debt payment and ending balance.
   Totals (months, interest, payoff months) therefore match
   simulatePayoff exactly — the tests assert this.
   maxMonths defaults to the simulator's own 600-month cap.
   --------------------------------------------------------------- */
function simulateSchedule(debts, extra, strategy, maxMonths) {
  const MAX = maxMonths || 600;
  const ds = debts.map(d => ({ ...d }));
  const pri = P.priorityOrder(ds, strategy);
  const payoff = {}; const done = new Set();
  let month = 0, interest = 0, rollover = 0;
  const rows = [];
  while (ds.some(d => d.balance > 0.005) && month < MAX) {
    month++;
    ds.forEach(d => { if (d.balance > 0.005) { const i = d.balance * d.apr / 100 / 12; d.balance += i; interest += i; } });
    const payments = {};
    ds.forEach(d => {
      if (d.balance > 0.005) {
        const p = Math.min(d.min, d.balance);
        d.balance -= p;
        payments[d.id] = (payments[d.id] || 0) + p;
        if (d.balance < 0.005) d.balance = 0;
      }
    });
    let budget = extra + rollover, guard = 0;
    while (budget > 0.005 && guard++ < 100) {
      const t = pri.find(d => d.balance > 0.005); if (!t) break;
      const p = Math.min(budget, t.balance); t.balance -= p; budget -= p;
      payments[t.id] = (payments[t.id] || 0) + p;
      if (t.balance < 0.005) t.balance = 0;
    }
    ds.forEach(d => { if (d.balance <= 0.005 && !done.has(d.id)) { done.add(d.id); payoff[d.id] = month; rollover += d.min; } });
    const balances = {};
    let totalPaid = 0, totalBalance = 0;
    ds.forEach(d => { balances[d.id] = round2(d.balance); totalBalance += d.balance; });
    Object.keys(payments).forEach(id => { totalPaid += payments[id]; });
    rows.push({
      month,
      label: monthLabel(month),
      payments,
      balances,
      totalPaid: round2(totalPaid),
      totalBalance: round2(totalBalance),
    });
  }
  return { months: month, interest, payoff, rows };
}

/* Smallest extra-above-minimums (to the cent) at which the plan finishes.
   Binary search over cents, judged by simulatePayoff itself so "finishes"
   means exactly what the rest of the product means by it. Only called when
   the entered extra is known to stall. */
function findViableExtra(active, extra, strategy) {
  let lo = Math.max(0, Math.round(extra * 100));               // stalls
  let hi = Math.max(lo + 1, Math.round(P.totalDebt(active) * 100)); // finishes fast
  let guard = 0;
  while (P.simulatePayoff(active, hi / 100, strategy).stalled && guard++ < 40) {
    lo = hi; hi *= 2;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (P.simulatePayoff(active, mid / 100, strategy).stalled) lo = mid;
    else hi = mid;
  }
  return hi / 100;
}

/* Build the data model from raw parts ({name, debts, extra, strategy}).
   Shared by the account flow (data from the DB) and the standalone
   /debt-free-date guest flow (data the visitor typed into the calculator).
   Returns null when there is nothing meaningful to print (no debts). */
function buildBlueprintDataFromParts(input) {
  const debts = (input.debts || []).map((d, i) => ({
    id: String(d.id != null ? d.id : i), name: d.name, balance: d.balance, apr: d.apr, min: d.min,
  }));
  if (!debts.length) return null;
  const active = P.activeDebts(debts);
  if (!active.length) return null;
  const strategy = input.strategy === 'snowball' ? 'snowball' : 'avalanche';
  const enteredExtra = Number(input.extra) || 0;
  const totalDebt = P.totalDebt(debts);
  const totalMins = P.totalMins(debts);

  // The plan. If the entered payments never finish, rebuild at the
  // smallest monthly payment that does — the PDF never ships a warning
  // in place of a plan.
  let effectiveExtra = enteredExtra;
  let planSim = P.simulatePayoff(active, effectiveExtra, strategy);
  let adjusted = false;
  if (planSim.stalled) {
    effectiveExtra = findViableExtra(active, enteredExtra, strategy);
    planSim = P.simulatePayoff(active, effectiveExtra, strategy);
    adjusted = true;
  }
  const sched = simulateSchedule(active, effectiveExtra, strategy);

  // Minimums-only baseline. When minimums alone never finish, measure
  // what that path costs over the same span the plan runs.
  const baseSim = P.simulatePayoff(active, 0, strategy);
  let baseline;
  if (!baseSim.stalled) {
    baseline = {
      stalled: false,
      months: baseSim.months,
      interest: round2(baseSim.interest),
    };
  } else {
    // Cap the comparison span at 10 years: with fixed minimums that don't
    // cover interest, the simulator's balances grow exponentially, and over
    // a very long plan the "cost of minimums" figure becomes a meaningless
    // artifact (billions) instead of a number a client can act on.
    const spanMonths = Math.min(planSim.months, 120);
    const span = simulateSchedule(active, 0, strategy, spanMonths);
    const lastRow = span.rows[span.rows.length - 1];
    baseline = {
      stalled: true,
      spanMonths,
      spanCapped: planSim.months > 120,
      spanInterest: round2(span.interest),
      remaining: lastRow ? lastRow.totalBalance : round2(totalDebt),
    };
  }

  // Payoff order: sort debts by the month each is eliminated.
  const order = [...active].sort((a, b) =>
    (planSim.payoff[a.id] || 1e9) - (planSim.payoff[b.id] || 1e9));

  return {
    name: input.name || 'there',
    generatedAt: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    debts, totalDebt, totalMins, strategy,
    enteredExtra,
    enteredMonthly: round2(totalMins + enteredExtra),
    adjusted,
    plan: {
      months: planSim.months,
      interest: round2(planSim.interest),
      monthly: round2(totalMins + effectiveExtra),
      extra: effectiveExtra,
      date: payoffDate(planSim.months),
    },
    baseline,
    order: order.map(d => ({
      id: d.id, name: d.name, balance: d.balance, apr: d.apr, min: d.min,
      payoffMonth: planSim.payoff[d.id] || null,
      payoffDate: planSim.payoff[d.id] ? payoffDate(planSim.payoff[d.id]) : '—',
    })),
    schedule: {
      debts: active.map(d => ({ id: d.id, name: d.name })),
      rows: sched.rows,
      interest: sched.interest,
    },
  };
}

/* Build the data model for an account user's blueprint (profile + debts
   from the DB). Returns null when there is nothing to print. */
function buildBlueprintData(userId) {
  const profile = store.getProfile(userId);
  if (!profile) return null;
  const debts = store.getDebts(userId).map(d => ({
    id: String(d.id), name: d.name, balance: d.balance, apr: d.apr, min: d.min,
  }));
  return buildBlueprintDataFromParts({
    name: profile.name, debts, extra: profile.extra, strategy: profile.strategy,
  });
}

/* ------------------------- PDF layout ------------------------- */

function header(doc, data) {
  doc.fillColor(GREEN).fontSize(11).font('Helvetica-Bold')
    .text('DEBTFREE COACH', { align: 'left' });
  doc.moveDown(0.4);
  doc.fillColor(INK).fontSize(26).font('Helvetica-Bold')
    .text('Your Debt-Free Date Blueprint', { align: 'left' });
  doc.moveDown(0.2);
  doc.fillColor(MUTED).fontSize(11).font('Helvetica')
    .text(`Prepared for ${data.name}  •  ${data.generatedAt}`);
  doc.moveDown(0.3);
  doc.strokeColor(GREEN).lineWidth(2)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.8);
}

function sectionTitle(doc, title) {
  doc.x = doc.page.margins.left; // tables draw at explicit x; reset the flow cursor
  doc.fillColor(INK).fontSize(15).font('Helvetica-Bold').text(title);
  doc.moveDown(0.4);
}

function kv(doc, label, value) {
  doc.fillColor(MUTED).fontSize(10).font('Helvetica').text(label, { continued: true });
  doc.fillColor(INK).font('Helvetica-Bold').text(`  ${value}`);
  doc.moveDown(0.15);
}

function body(doc, text, size) {
  doc.x = doc.page.margins.left;
  doc.fillColor(INK).fontSize(size || 10.5).font('Helvetica').text(text);
}

/* Returns true when a page break was taken (so tables can redraw headers). */
function ensureSpace(doc, needed, pageOpts) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage(pageOpts || PORTRAIT);
    return true;
  }
  return false;
}

/* Truncate a string so it fits a column at the doc's current font. */
function fitText(doc, text, width) {
  let t = String(text == null ? '' : text);
  if (doc.widthOfString(t) <= width) return t;
  while (t.length > 1 && doc.widthOfString(t + '…') > width) t = t.slice(0, -1);
  return t + '…';
}

function disclaimer(doc) {
  doc.moveDown(1);
  doc.fillColor(MUTED).fontSize(8).font('Helvetica')
    .text('Education only — not financial advice. This blueprint is an educational illustration ' +
      'based on the balances, APRs, and payments you entered. It is not personalized financial, ' +
      'investment, tax, or legal advice. Payoff simulations are estimates, not guarantees; actual ' +
      'results depend on your creditors\u2019 terms, future rates, fees, and payments. ' +
      'DebtFree Coach is not a fiduciary, broker, advisor, or lender.', { align: 'justify' });
}

function cta(doc) {
  doc.moveDown(0.6);
  doc.fillColor(GREEN).fontSize(11).font('Helvetica-Bold')
    .text('Keep your plan on track — reactivate DebtFree Coach anytime at getdebtfreecoach.com',
      { align: 'center' });
}

/* Amber callout used when the plan had to be rebuilt at a higher payment. */
function adjustedCallout(doc, data) {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const sentence =
    `At your current ${money(data.enteredMonthly)}/mo this debt never pays off. ` +
    `This plan uses ${money(data.plan.monthly)}/mo — the smallest amount that gets you ` +
    `debt-free — and finishes ${data.plan.date}.`;
  doc.fontSize(11).font('Helvetica-Bold');
  const h = doc.heightOfString(sentence, { width: w - 24 }) + 42;
  ensureSpace(doc, h + 10);
  const top = doc.y;
  doc.save();
  doc.roundedRect(x, top, w, h, 6).fill(AMBER_BG);
  doc.restore();
  doc.fillColor(AMBER_INK).fontSize(10).font('Helvetica-Bold')
    .text('FIRST, AN HONEST ADJUSTMENT', x + 12, top + 10, { width: w - 24 });
  doc.fontSize(11).text(sentence, x + 12, top + 26, { width: w - 24 });
  doc.y = top + h + 6;
  doc.x = doc.page.margins.left;
  doc.fillColor(INK).fontSize(10.5).font('Helvetica')
    .text('Everything below — the payoff order, the steps, and the month-by-month ' +
      'schedule — is built on that payment, so the plan in your hands actually finishes.');
  doc.moveDown(0.8);
}

/* Simple 4-column table (name / balance / APR / minimum) with page breaks. */
function debtsTable(doc, list) {
  const colX = [doc.page.margins.left, 250, 340, 430];
  const drawHead = () => {
    doc.fillColor(MUTED).fontSize(9).font('Helvetica-Bold');
    const y = doc.y;
    doc.text('Debt', colX[0], y, { width: 170 });
    doc.text('Balance', colX[1], y, { width: 80, align: 'right' });
    doc.text('APR', colX[2], y, { width: 80, align: 'right' });
    doc.text('Minimum', colX[3], y, { width: 80, align: 'right' });
    doc.y = y + 14;
  };
  drawHead();
  doc.fillColor(INK).font('Helvetica').fontSize(10);
  list.forEach(d => {
    if (ensureSpace(doc, 16)) drawHead();
    const y = doc.y;
    doc.fillColor(INK).font('Helvetica').fontSize(10);
    doc.text(fitText(doc, d.name, 186), colX[0], y, { width: 190 });
    doc.text(money(d.balance), colX[1], y, { width: 80, align: 'right' });
    doc.text(`${Number(d.apr).toFixed(2)}%`, colX[2], y, { width: 80, align: 'right' });
    doc.text(`${money(d.min)}/mo`, colX[3], y, { width: 80, align: 'right' });
    doc.y = y + 15;
  });
  doc.moveDown(0.6);
}

/* Payoff-order table: order, debt, balance, APR, minimum, payoff month/date. */
function payoffOrderTable(doc, order) {
  const x0 = doc.page.margins.left;
  const cols = [
    { label: '#', w: 22 },
    { label: 'Debt', w: 148 },
    { label: 'Balance', w: 78, right: true },
    { label: 'APR', w: 54, right: true },
    { label: 'Minimum', w: 74, right: true },
    { label: 'Paid off', w: 124, right: true },
  ];
  const drawHead = () => {
    let x = x0;
    const y = doc.y;
    doc.fillColor(MUTED).fontSize(8.5).font('Helvetica-Bold');
    cols.forEach(c => {
      doc.text(c.label, x, y, { width: c.w - 4, align: c.right ? 'right' : 'left' });
      x += c.w;
    });
    doc.y = y + 13;
    doc.strokeColor(FAINT).lineWidth(1)
      .moveTo(x0, doc.y).lineTo(x0 + 500, doc.y).stroke();
    doc.y += 4;
  };
  drawHead();
  order.forEach((d, i) => {
    if (ensureSpace(doc, 16)) drawHead();
    let x = x0;
    const y = doc.y;
    doc.fillColor(INK).fontSize(9.5).font('Helvetica');
    const cells = [
      String(i + 1),
      fitText(doc, d.name, cols[1].w - 6),
      money(d.balance),
      `${Number(d.apr).toFixed(2)}%`,
      `${money(d.min)}/mo`,
      d.payoffMonth ? `Month ${d.payoffMonth} · ${d.payoffDate}` : '—',
    ];
    cells.forEach((cell, ci) => {
      if (ci === 5 && d.payoffMonth) doc.font('Helvetica-Bold');
      else if (ci === 5) doc.font('Helvetica');
      doc.text(cell, x, y, { width: cols[ci].w - 4, align: cols[ci].right ? 'right' : 'left' });
      x += cols[ci].w;
    });
    doc.y = y + 15;
  });
  doc.moveDown(0.6);
}

/* The month-by-month schedule, on landscape pages. Up to 5 debts each get a
   Pay + Balance column pair; with 6–8 debts the table shows the total paid
   plus each debt's remaining balance (a payment column per debt no longer
   fits the page). */
function scheduleSection(doc, data) {
  doc.addPage(LANDSCAPE);
  sectionTitle(doc, '6. Your month-by-month schedule');
  const sDebts = data.schedule.debts;
  const showPay = sDebts.length <= 5;
  body(doc,
    'Every row is one month. ' +
    (showPay
      ? '"Pay" is what goes to that debt that month; "Bal" is what is left after the payment. '
      : '"Paid" is your total payment that month; each debt column shows what is left after the payment. ') +
    `Your payment is ${money(data.plan.monthly)}/mo until the final month, which is smaller. ` +
    'When a balance reaches $0.00 that debt is done — from the next month its whole payment ' +
    'rolls into the next debt in the payoff order.', 9.5);
  doc.moveDown(0.5);

  const x0 = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const monthW = 92, owedW = 64;
  const cols = [{ key: 'month', label: 'Month', w: monthW }];
  if (showPay) {
    const per = (W - monthW - owedW) / sDebts.length;
    sDebts.forEach(d => {
      cols.push({ key: 'pay:' + d.id, debt: d, w: per * 0.44, right: true });
      cols.push({ key: 'bal:' + d.id, debt: d, w: per * 0.56, right: true });
    });
  } else {
    cols.push({ key: 'paid', label: 'Paid', w: 56, right: true });
    const per = (W - monthW - 56 - owedW) / sDebts.length;
    sDebts.forEach(d => cols.push({ key: 'bal:' + d.id, debt: d, w: per, right: true }));
  }
  cols.push({ key: 'owed', label: 'Total owed', w: owedW, right: true });

  const payoffMonthById = {};
  data.order.forEach(d => { if (d.payoffMonth) payoffMonthById[d.id] = d.payoffMonth; });

  const headerH = showPay ? 30 : 18;
  const drawHeader = (continued) => {
    if (continued) {
      doc.fillColor(MUTED).fontSize(8).font('Helvetica')
        .text('Month-by-month schedule (continued)');
      doc.moveDown(0.3);
    }
    let x = x0;
    const yTop = doc.y;
    // Debt names row
    doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold');
    cols.forEach(c => {
      if (c.key === 'month') doc.text('Month', x, yTop, { width: c.w - 4 });
      else if (c.key === 'paid') doc.text('Paid', x, yTop, { width: c.w - 4, align: 'right' });
      else if (c.key === 'owed') doc.text('Total owed', x, yTop, { width: c.w - 2, align: 'right' });
      else if (c.key.startsWith('pay:')) {
        // name spans the Pay+Bal pair; drawn once, from the Pay column
        const pairW = c.w + cols[cols.indexOf(c) + 1].w;
        doc.text(fitText(doc, c.debt.name, pairW - 4), x, yTop, { width: pairW - 4, align: 'center' });
      } else if (c.key.startsWith('bal:') && !showPay) {
        doc.text(fitText(doc, c.debt.name, c.w - 4), x, yTop, { width: c.w - 4, align: 'right' });
      }
      x += c.w;
    });
    if (showPay) {
      let x2 = x0;
      const y2 = yTop + 11;
      doc.fontSize(7.5);
      cols.forEach(c => {
        if (c.key.startsWith('pay:')) doc.text('Pay', x2, y2, { width: c.w - 4, align: 'right' });
        else if (c.key.startsWith('bal:')) doc.text('Bal', x2, y2, { width: c.w - 4, align: 'right' });
        x2 += c.w;
      });
    }
    doc.y = yTop + headerH;
    doc.strokeColor(MUTED).lineWidth(1)
      .moveTo(x0, doc.y).lineTo(x0 + W, doc.y).stroke();
    doc.y += 4;
  };

  drawHeader(false);
  const rowH = 12.5;
  const bottom = doc.page.height - doc.page.margins.bottom;
  doc.fontSize(7.5).font('Helvetica');
  data.schedule.rows.forEach(row => {
    if (doc.y + rowH > bottom) {
      doc.addPage(LANDSCAPE);
      drawHeader(true);
      doc.fontSize(7.5).font('Helvetica');
    }
    let x = x0;
    const y = doc.y;
    doc.fillColor(INK).font('Helvetica');
    cols.forEach(c => {
      let text, bold = false, green = false;
      if (c.key === 'month') text = `${row.month} · ${row.label}`;
      else if (c.key === 'paid') text = money(row.totalPaid);
      else if (c.key === 'owed') { text = money(row.totalBalance); bold = true; }
      else if (c.key.startsWith('pay:')) text = money(row.payments[c.debt.id] || 0);
      else {
        text = money(row.balances[c.debt.id] || 0);
        if (payoffMonthById[c.debt.id] === row.month) { bold = true; green = true; }
      }
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
      if (green) doc.fillColor(GREEN); else doc.fillColor(INK);
      doc.text(text, x, y, { width: c.w - 4, align: c.right ? 'right' : 'left' });
      x += c.w;
    });
    doc.y = y + rowH;
    doc.strokeColor(FAINT).lineWidth(0.5)
      .moveTo(x0, doc.y - 2.5).lineTo(x0 + W, doc.y - 2.5).stroke();
  });
  doc.moveDown(0.4);
  doc.x = x0;
  doc.fillColor(MUTED).fontSize(8).font('Helvetica')
    .text('Bold green $0.00 marks the month a debt is paid off. Balances are estimates from the ' +
      'numbers you entered — your real statements will differ by a few dollars as creditors post ' +
      'interest and fees on their own schedules.');
}

/* Generate the PDF. Resolves with a Buffer. */
function generateBlueprintPDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: 'LETTER' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    header(doc, data);

    if (data.adjusted) adjustedCallout(doc, data);

    // 1. Plan at a glance (cover summary)
    sectionTitle(doc, '1. Your plan at a glance');
    doc.fillColor(GREEN).fontSize(20).font('Helvetica-Bold')
      .text(`Debt-free by ${data.plan.date}`);
    doc.moveDown(0.4);
    kv(doc, 'Total debt', money(data.totalDebt));
    kv(doc, 'Combined minimum payments', `${money(data.totalMins)}/mo`);
    kv(doc, 'Strategy', data.strategy === 'snowball' ? 'Snowball (smallest balance first)' : 'Avalanche (highest APR first)');
    kv(doc, 'Your monthly plan payment', `${money(data.plan.monthly)}/mo`);
    kv(doc, 'Time to debt-free', `${data.plan.months} months`);
    kv(doc, 'Total interest with this plan', money(data.plan.interest));
    if (!data.baseline.stalled) {
      const saved = round2(data.baseline.interest - data.plan.interest);
      if (saved > 0) kv(doc, 'Interest saved vs. minimums only', money(saved));
    } else {
      kv(doc, 'Paying only minimums', 'Never reaches zero — see section 5');
    }
    doc.moveDown(0.6);

    // 2. Starting point
    sectionTitle(doc, '2. Where you stand today');
    debtsTable(doc, data.debts);

    // 3. Payoff order
    sectionTitle(doc, `3. Your payoff order (${data.strategy})`);
    body(doc, data.strategy === 'snowball'
      ? 'You attack the smallest balance first for quick wins, paying minimums on everything else. ' +
        'Each debt you finish frees its payment to roll into the next one.'
      : 'You attack the highest APR first because it costs you the most, paying minimums on everything else. ' +
        'Each debt you finish frees its payment to roll into the next one.');
    doc.moveDown(0.4);
    payoffOrderTable(doc, data.order);

    // 4. How to work this plan
    sectionTitle(doc, '4. How to work this plan');
    const first = data.order[0];
    const steps = [
      ['Tonight, put every minimum on autopay.',
        ' ' + data.order.map(d => `${d.name}: ${money(d.min)}`).join(' · ') +
        '. Autopay means a payment is never late while you run this plan.'],
      [`Pay ${money(data.plan.monthly)} every month — no more, no less.`,
        ` Minimums go to every debt. Everything left over goes to #1 in the payoff order` +
        (first ? ` — right now that's ${first.name}.` : '.')],
      ['When a debt is gone, roll its whole payment into the next one.',
        ' Don\u2019t spend the freed money. Your monthly total never changes; the payment aimed ' +
        'at the next debt just gets bigger. That roll is what makes the finish line move closer fast.'],
      ['Send windfalls straight to the debt you\u2019re attacking.',
        ' Tax refunds, bonuses, overtime, things you sell — every extra dollar on the target ' +
        'debt pulls your debt-free date closer.'],
      ['Stop charging the cards you\u2019re paying off.',
        ' New charges add balance this schedule doesn\u2019t know about and quietly push the date back.'],
      ['Check in once a month against the schedule.',
        ' Find this month\u2019s row in section 6 and compare your real balances. Ahead? Stay the ' +
        'course. Behind, or life changed the payment you can make? Re-run your numbers free at ' +
        'getdebtfreecoach.com/debt-free-date and work from the fresh plan.'],
    ];
    steps.forEach((s, i) => {
      ensureSpace(doc, 30);
      doc.fillColor(INK).fontSize(10.5).font('Helvetica-Bold')
        .text(`${i + 1}. ${s[0]}`, { continued: true });
      doc.font('Helvetica').text(s[1]);
      doc.moveDown(0.3);
    });
    doc.moveDown(0.3);

    // 5. Minimums vs plan
    sectionTitle(doc, '5. Minimums vs. your plan');
    doc.fillColor(INK).fontSize(10.5).font('Helvetica');
    if (!data.baseline.stalled) {
      const monthsSaved = data.baseline.months - data.plan.months;
      const interestSaved = round2(data.baseline.interest - data.plan.interest);
      doc.text(`Paying only minimums:  ${data.baseline.months} months, ${money(data.baseline.interest)} in interest.`);
      doc.moveDown(0.15);
      doc.text(`With your plan:  ${data.plan.months} months, ${money(data.plan.interest)} in interest.`);
      doc.moveDown(0.3);
      if (monthsSaved > 0 || interestSaved > 0) {
        doc.fillColor(GREEN).fontSize(12).font('Helvetica-Bold')
          .text(`You save ${monthsSaved} months and ${money0(interestSaved)} in interest.`);
      } else {
        doc.fillColor(INK).fontSize(10.5).font('Helvetica')
          .text('This plan follows the minimums-only path. Any extra payment you can add pulls the date closer.');
      }
    } else if (data.baseline.spanCapped) {
      doc.text(
        `Paying only minimums, this debt never reaches zero — the payments don't cover the interest. ` +
        `Over just the next 10 years, minimums alone would cost ${money(data.baseline.spanInterest)} in interest ` +
        `and your balance would grow to ${money(data.baseline.remaining)} — and it only gets worse from there. ` +
        `Your plan pays ${money(data.plan.interest)} in interest and ends at $0.`);
    } else {
      doc.text(
        `Paying only minimums, this debt never reaches zero — the payments don't cover the interest. ` +
        `Over the same ${data.baseline.spanMonths} months your plan runs, minimums alone would cost ` +
        `${money(data.baseline.spanInterest)} in interest and you would still owe ${money(data.baseline.remaining)}. ` +
        `Your plan pays ${money(data.plan.interest)} in interest and ends at $0.`);
    }

    // 6. Month-by-month schedule (landscape)
    scheduleSection(doc, data);

    // Closing page (portrait): CTA + disclaimer
    doc.addPage(PORTRAIT);
    cta(doc);
    disclaimer(doc);
    doc.end();
  });
}

module.exports = {
  buildBlueprintData, buildBlueprintDataFromParts, generateBlueprintPDF,
  // Exported for tests:
  simulateSchedule, findViableExtra,
};
