/* ============================================================
   DebtFree Coach — "Debt-Free Date Blueprint" PDF generator.
   Personalized one-time-offer PDF built from the customer's own
   profile + debts + payoff simulation. Education only — not
   financial advice (disclaimer printed on every copy).
   ============================================================ */
'use strict';

const PDFDocument = require('pdfkit');
const store = require('./db');
const P = require('./shared/payoff');

const GREEN = '#16a34a';
const INK = '#1f2937';
const MUTED = '#6b7280';

const money = n =>
  '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = n => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');

function payoffDate(months) {
  if (!months) return '—';
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/* Build the data model for a user's blueprint. Returns null when there is
   nothing meaningful to print (no profile or no debts). */
function buildBlueprintData(userId) {
  const profile = store.getProfile(userId);
  const debts = store.getDebts(userId).map(d => ({
    id: String(d.id), name: d.name, balance: d.balance, apr: d.apr, min: d.min,
  }));
  if (!profile || !debts.length) return null;
  const strategy = profile.strategy === 'snowball' ? 'snowball' : 'avalanche';
  const extra = Number(profile.extra) || 0;

  const planSim = P.simulatePayoff(P.activeDebts(debts), extra, strategy);
  const baseSim = P.simulatePayoff(P.activeDebts(debts), 0, strategy);
  const totalDebt = P.totalDebt(debts);
  const totalMins = P.totalMins(debts);

  // Payoff order: sort debts by the month each is eliminated.
  const order = [...debts].sort((a, b) =>
    (planSim.payoff[a.id] || 1e9) - (planSim.payoff[b.id] || 1e9));

  return {
    name: profile.name || 'there',
    generatedAt: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    debts, totalDebt, totalMins, extra, strategy,
    plan: {
      months: planSim.stalled ? null : planSim.months,
      interest: Math.round(planSim.interest * 100) / 100,
      monthly: Math.round((totalMins + extra) * 100) / 100,
      date: payoffDate(planSim.stalled ? null : planSim.months),
      stalled: !!planSim.stalled,
    },
    baseline: {
      months: baseSim.stalled ? null : baseSim.months,
      interest: Math.round(baseSim.interest * 100) / 100,
    },
    order: order.map(d => ({
      name: d.name, balance: d.balance, apr: d.apr, min: d.min,
      payoffMonth: planSim.payoff[d.id] || null,
    })),
  };
}

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
  doc.fillColor(INK).fontSize(15).font('Helvetica-Bold').text(title);
  doc.moveDown(0.4);
}

function kv(doc, label, value) {
  doc.fillColor(MUTED).fontSize(10).font('Helvetica').text(label, { continued: true });
  doc.fillColor(INK).font('Helvetica-Bold').text(`  ${value}`);
  doc.moveDown(0.15);
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

/* Generate the PDF. Resolves with a Buffer. */
function generateBlueprintPDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: 'LETTER' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    header(doc, data);

    // 1. Starting point
    sectionTitle(doc, '1. Where you stand today');
    kv(doc, 'Total debt', money(data.totalDebt));
    kv(doc, 'Combined minimum payments', `${money(data.totalMins)}/mo`);
    doc.moveDown(0.5);
    // Debt table
    const colX = [doc.page.margins.left, 250, 340, 430];
    doc.fillColor(MUTED).fontSize(9).font('Helvetica-Bold');
    doc.text('Debt', colX[0], doc.y, { width: 170 });
    doc.text('Balance', colX[1], doc.y - 11, { width: 80, align: 'right' });
    doc.text('APR', colX[2], doc.y - 11, { width: 80, align: 'right' });
    doc.text('Minimum', colX[3], doc.y - 11, { width: 80, align: 'right' });
    doc.moveDown(0.3);
    doc.fillColor(INK).font('Helvetica').fontSize(10);
    data.debts.forEach(d => {
      const y = doc.y;
      doc.text(d.name, colX[0], y, { width: 170 });
      doc.text(money(d.balance), colX[1], y, { width: 80, align: 'right' });
      doc.text(`${Number(d.apr).toFixed(2)}%`, colX[2], y, { width: 80, align: 'right' });
      doc.text(`${money(d.min)}/mo`, colX[3], y, { width: 80, align: 'right' });
      doc.moveDown(0.35);
    });
    doc.moveDown(0.6);

    // 2. The plan
    sectionTitle(doc, `2. Your payoff plan (${data.strategy})`);
    if (data.plan.stalled) {
      doc.fillColor(INK).fontSize(11).font('Helvetica')
        .text('Your current payments don\u2019t cover the growing interest — the balances would ' +
          'never reach zero at these payment levels. Raising your monthly payment (even a little) ' +
          'changes the math completely. This is exactly what the DebtFree Coach app helps you tune month to month.');
    } else {
      kv(doc, 'Debt-free date', data.plan.date);
      kv(doc, 'Time to debt-free', `${data.plan.months} months`);
      kv(doc, 'Monthly payment', `${money(data.plan.monthly)}/mo`);
      kv(doc, 'Total interest paid', money(data.plan.interest));
      doc.moveDown(0.5);
      doc.fillColor(INK).fontSize(11).font('Helvetica-Bold').text('Payoff order');
      doc.moveDown(0.2);
      doc.fillColor(INK).fontSize(10).font('Helvetica');
      data.order.forEach((d, i) => {
        const when = d.payoffMonth ? `gone by month ${d.payoffMonth}` : '—';
        doc.text(`${i + 1}. ${d.name} — ${money(d.balance)} (${when})`);
        doc.moveDown(0.15);
      });
    }
    doc.moveDown(0.6);

    // 3. Minimums vs plan
    sectionTitle(doc, '3. Minimums vs. your plan');
    if (!data.plan.stalled && data.baseline.months) {
      const monthsSaved = data.baseline.months - data.plan.months;
      const interestSaved = Math.max(0, data.baseline.interest - data.plan.interest);
      doc.fillColor(INK).fontSize(10).font('Helvetica');
      doc.text(`Paying only minimums:  ${data.baseline.months} months, ${money(data.baseline.interest)} in interest.`);
      doc.moveDown(0.15);
      doc.text(`With your plan:  ${data.plan.months} months, ${money(data.plan.interest)} in interest.`);
      doc.moveDown(0.3);
      doc.fillColor(GREEN).fontSize(12).font('Helvetica-Bold')
        .text(`You save ${monthsSaved} months and ${money0(interestSaved)} in interest.`);
    } else {
      doc.fillColor(INK).fontSize(10).font('Helvetica')
        .text('With minimum payments alone, this debt would never reach zero. Your plan is the difference.');
    }

    cta(doc);
    disclaimer(doc);
    doc.end();
  });
}

module.exports = { buildBlueprintData, generateBlueprintPDF };
