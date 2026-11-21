/* DebtFree Coach — /debt-free-date page logic (cookie consent banner +
   calculator + shareable date card). Moved out of debt-free-date.html so
   the site's CSP (script-src 'self') allows it. Loaded at end of <body>,
   same execution point as the original inline scripts. */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  try {
    if (!localStorage.getItem('dfc-consent')) $('cookie-banner').classList.remove('hidden');
  } catch (e) { /* storage unavailable: banner stays hidden, pixel never loads */ }
  $('cookie-accept').addEventListener('click', function () {
    try { localStorage.setItem('dfc-consent', 'accepted'); } catch (e) {}
    $('cookie-banner').classList.add('hidden');
    try { if (window.dfcEnableTracking) dfcEnableTracking(); } catch (e) {}
    try { if (window.dfcEnableManychatPixel) dfcEnableManychatPixel(); } catch (e) {}
  });
  $('cookie-decline').addEventListener('click', function () {
    try { localStorage.setItem('dfc-consent', 'declined'); } catch (e) {}
    $('cookie-banner').classList.add('hidden');
  });
})();

(function () {
  'use strict';
  var P = window.DFCPayoff;
  var rowsEl = document.getElementById('debt-rows');
  var rowCount = 0;

  function addRow(prefill) {
    if (rowCount >= 8) return;
    rowCount++;
    var div = document.createElement('div');
    div.className = 'debt-row';
    div.innerHTML =
      '<div class="full"><label>Debt name (optional)</label><input class="d-name" type="text" placeholder="e.g. Credit card" value="' + (prefill && prefill.name ? P.esc(prefill.name) : '') + '"></div>' +
      '<div><label>Balance ($)</label><input class="d-bal" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0" value="' + (prefill ? prefill.balance : '') + '"></div>' +
      '<div><label>APR (%)</label><input class="d-apr" type="number" inputmode="decimal" min="0" max="100" step="0.01" placeholder="0" value="' + (prefill ? prefill.apr : '') + '"></div>' +
      '<div><label>Minimum payment ($/mo)</label><input class="d-min" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0" value="' + (prefill ? prefill.min : '') + '"></div>' +
      '<div><button type="button" class="rm-btn">Remove</button></div>';
    div.querySelector('.rm-btn').addEventListener('click', function () { div.remove(); rowCount--; });
    rowsEl.appendChild(div);
  }

  addRow(); addRow();

  document.getElementById('add-debt').addEventListener('click', function () { addRow(); });
  document.getElementById('try-example').addEventListener('click', function () {
    rowsEl.innerHTML = ''; rowCount = 0;
    addRow({ name: 'Store card', balance: 4200, apr: 24.99, min: 105 });
    addRow({ name: 'Credit card', balance: 8900, apr: 18.9, min: 210 });
    document.getElementById('extra').value = 150;
    calculate();
  });

  var strategy = 'avalanche';
  function setStrat(s) {
    strategy = s;
    document.getElementById('strat-avalanche').className = s === 'avalanche' ? 'sel' : '';
    document.getElementById('strat-snowball').className = s === 'snowball' ? 'sel' : '';
  }
  document.getElementById('strat-avalanche').addEventListener('click', function () { setStrat('avalanche'); });
  document.getElementById('strat-snowball').addEventListener('click', function () { setStrat('snowball'); });

  function showError(msg) {
    var el = document.getElementById('calc-error');
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'block'; el.textContent = msg;
  }

  function readDebts() {
    var debts = [], i = 0;
    rowsEl.querySelectorAll('.debt-row').forEach(function (row) {
      var bal = parseFloat(row.querySelector('.d-bal').value);
      var apr = parseFloat(row.querySelector('.d-apr').value);
      var min = parseFloat(row.querySelector('.d-min').value);
      if (isNaN(bal) || isNaN(apr) || isNaN(min)) return;
      debts.push({ id: 'd' + (i++), name: row.querySelector('.d-name').value || 'Debt ' + i, balance: bal, apr: apr, min: min });
    });
    return debts;
  }

  function calculate() {
    showError('');
    var debts = readDebts().filter(function (d) { return d.balance > 0; });
    if (!debts.length) { showError('Add at least one debt with a balance above $0.'); return; }
    var bad = debts.some(function (d) { return d.apr < 0 || d.apr > 100 || d.min < 0; });
    if (bad) { showError('Check your numbers: APR must be 0–100 and minimums can\'t be negative.'); return; }
    var extra = parseFloat(document.getElementById('extra').value) || 0;
    if (extra < 0) { showError('Extra payment can\'t be negative.'); return; }

    var plan = P.simulatePayoff(P.activeDebts(debts), extra, strategy);
    var base = P.simulatePayoff(P.activeDebts(debts), 0, strategy);
    var res = document.getElementById('results');
    var stalledEl = document.getElementById('res-stalled');
    stalledEl.style.display = 'none';

    if (plan.stalled) {
      document.getElementById('res-date').textContent = 'Not on this payment';
      document.getElementById('res-months').textContent = 'Even with $' + Math.round(extra) + '/mo extra, these payments don\'t cover the interest — the balance keeps growing.';
      document.getElementById('res-interest').textContent = '';
      document.getElementById('res-vs-min').textContent = 'Try a bigger extra payment, or a lower APR, and run it again. The math is honest even when it stings.';
      dcMonths = null;
      document.getElementById('date-card').style.display = 'none';
      res.style.display = 'block';
      res.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    document.getElementById('res-date').textContent = 'Debt-free by ' + P.monthName(plan.months);
    document.getElementById('res-months').textContent = 'That\'s ' + plan.months + ' months from now, paying ' + P.money(plan.interest) + ' in interest along the way.';
    if (!base.stalled && base.months > plan.months) {
      document.getElementById('res-vs-min').innerHTML = 'On minimums alone: ' + P.monthName(base.months) + ' (' + base.months + ' months, ' + P.money(base.interest) + ' interest). Your plan saves <b>' + (base.months - plan.months) + ' months and ' + P.money(base.interest - plan.interest) + '</b>.';
    } else if (base.stalled) {
      document.getElementById('res-vs-min').innerHTML = 'On minimums alone, this debt <b>never gets paid off</b> — the minimums don\'t cover the interest. Your plan is the difference between stuck and free.';
    } else {
      document.getElementById('res-vs-min').textContent = 'Add an extra payment above to see how much sooner you could be free.';
    }
    dcMonths = plan.months;
    document.getElementById('date-card').style.display = 'block';
    renderDateCard();
    res.style.display = 'block';
    res.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- Shareable date card (client-side canvas; same pattern as the
     app's badge share graphics in app.js). Shows only the calculated date —
     nothing is uploaded, stored, or sent anywhere. ---------- */
  var dcMonths = null, dcSize = 'square', dcCanvas = null;

  function fullMonthName(offset) {
    var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset);
    return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  }

  function drawDateCard(months, size) {
    var W = 1080, H = size === 'story' ? 1920 : 1080;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
    var bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#16294d'); bg.addColorStop(1, '#0b1220');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#fbbf24'; g.lineWidth = 10;
    g.strokeRect(28, 28, W - 56, H - 56);
    g.textAlign = 'center';
    var cx = W / 2;
    var y = size === 'story' ? 460 : 280;
    g.font = '200px serif';
    g.fillText('💰', cx, y);
    y += size === 'story' ? 180 : 160;
    g.fillStyle = '#fbbf24';
    g.font = '700 46px -apple-system, "Segoe UI", Roboto, sans-serif';
    g.fillText('MY DEBT-FREE DATE', cx, y, W - 160);
    y += size === 'story' ? 170 : 150;
    g.fillStyle = '#22c55e';
    g.font = '800 118px -apple-system, "Segoe UI", Roboto, sans-serif';
    g.fillText(fullMonthName(months), cx, y, W - 140);
    y += 105;
    g.fillStyle = '#eef3fb';
    g.font = '700 54px -apple-system, "Segoe UI", Roboto, sans-serif';
    g.fillText(months + (months === 1 ? ' month' : ' months') + ' from now — I\'m holding the date.', cx, y, W - 160);
    g.fillStyle = '#22c55e';
    g.font = '800 54px -apple-system, "Segoe UI", Roboto, sans-serif';
    g.fillText('DebtFree Coach', cx, H - (size === 'story' ? 320 : 200));
    g.fillStyle = '#93a1bd';
    g.font = '500 40px -apple-system, "Segoe UI", Roboto, sans-serif';
    g.fillText('getdebtfreecoach.com', cx, H - (size === 'story' ? 250 : 140));
    return cv;
  }

  function dateCardCaption(months) {
    return 'I\'m debt-free by ' + fullMonthName(months) + '! 💪 Found my date free with DebtFree Coach — find yours: https://getdebtfreecoach.com/debt-free-date\n\n#DebtFree #DebtPayoffJourney';
  }

  function renderDateCard() {
    if (dcMonths == null) return;
    dcCanvas = drawDateCard(dcMonths, dcSize);
    document.getElementById('dc-preview').src = dcCanvas.toDataURL('image/png');
    document.getElementById('dc-caption').value = dateCardCaption(dcMonths);
    var canNative = !!(navigator.share && navigator.canShare);
    document.getElementById('dc-share').style.display = canNative ? '' : 'none';
  }

  function setDcSize(s) {
    dcSize = s;
    document.getElementById('dc-size-square').className = s === 'square' ? 'sel' : '';
    document.getElementById('dc-size-story').className = s === 'story' ? 'sel' : '';
    renderDateCard();
  }
  document.getElementById('dc-size-square').addEventListener('click', function () { setDcSize('square'); });
  document.getElementById('dc-size-story').addEventListener('click', function () { setDcSize('story'); });

  document.getElementById('dc-download').addEventListener('click', function () {
    if (!dcCanvas) return;
    dcCanvas.toBlob(function (blob) {
      if (!blob) return;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'my-debt-free-date-' + dcSize + '.png';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }, 'image/png');
  });

  document.getElementById('dc-copy').addEventListener('click', function () {
    var btn = document.getElementById('dc-copy');
    var ta = document.getElementById('dc-caption');
    function done() {
      btn.textContent = '✅ Copied!';
      setTimeout(function () { btn.textContent = '📋 Copy caption'; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand('copy'); done(); });
    } else { ta.select(); document.execCommand('copy'); done(); }
  });

  document.getElementById('dc-share').addEventListener('click', function () {
    if (!dcCanvas || !navigator.share) return;
    dcCanvas.toBlob(function (blob) {
      if (!blob) return;
      var file = new File([blob], 'my-debt-free-date.png', { type: 'image/png' });
      var text = document.getElementById('dc-caption').value;
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] }))
          navigator.share({ files: [file], text: text, title: 'DebtFree Coach' }).catch(function () { /* user dismissed */ });
        else
          navigator.share({ text: text, title: 'DebtFree Coach' }).catch(function () { /* user dismissed */ });
      } catch (e) { /* user dismissed */ }
    }, 'image/png');
  });

  document.getElementById('calc').addEventListener('click', calculate);
})();
