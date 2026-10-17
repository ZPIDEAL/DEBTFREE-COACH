/* ============================================================
   DebtFree Coach v2 — Stripe billing.
   $9.99/month recurring subscription with a 7-DAY FREE TRIAL:
   card is collected at checkout, the first charge happens 7 days
   later, and cancelling during the trial means never being charged.
   All keys come from environment variables only.
   ============================================================ */
'use strict';

const store = require('./db');

const SECRET = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const SAVE20_COUPON = process.env.STRIPE_SAVE20_COUPON || '';
const ANNUAL_PRICE_ID = process.env.STRIPE_ANNUAL_PRICE_ID || '';
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

const BLUEPRINT_CENTS = 1900; // $19 one-time

const configured = () => Boolean(SECRET && PRICE_ID);

let stripe = null;
if (SECRET) {
  stripe = require('stripe')(SECRET);
}

const iso = unixTs => (unixTs ? new Date(unixTs * 1000).toISOString() : null);

function subToRow(sub) {
  return {
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
    status: sub.status,
    trial_end: iso(sub.trial_end),
    current_period_end: iso(sub.current_period_end),
    cancel_at_period_end: !!sub.cancel_at_period_end,
  };
}

/* POST /api/billing/checkout — start (or restart) the subscription. */
async function createCheckout(req, res) {
  if (!configured()) {
    return res.status(503).json({
      error: 'Online checkout is not configured yet (Stripe keys missing). ' +
             'The owner needs to add STRIPE_SECRET_KEY and STRIPE_PRICE_ID on the server.',
    });
  }
  try {
    const userId = req.user.user_id;
    const existing = store.getSubscription(userId);
    let customerId = existing && existing.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { userId: String(userId) },
      });
      customerId = customer.id;
      store.upsertSubscription(userId, { stripe_customer_id: customerId, status: 'incomplete' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7, // 7-day free trial, card collected upfront
        metadata: { userId: String(userId) },
      },
      success_url: `${APP_URL}/app?subscribed=1`,
      cancel_url: `${APP_URL}/?billing=cancelled`,
      metadata: { userId: String(userId) },
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e.message);
    res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
}

/* POST /api/billing/portal — self-serve cancel / manage payment method. */
async function createPortal(req, res) {
  if (!SECRET) {
    return res.status(503).json({ error: 'Billing portal is not configured yet (Stripe keys missing).' });
  }
  const sub = store.getSubscription(req.user.user_id);
  if (!sub || !sub.stripe_customer_id) {
    return res.status(400).json({ error: 'No billing customer found for this account yet.' });
  }
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${APP_URL}/app`,
    });
    res.json({ url: portal.url });
  } catch (e) {
    console.error('Stripe portal error:', e.message);
    res.status(502).json({ error: 'Could not open the billing portal. Please try again.' });
  }
}

/* ---------- cancel-save flow ---------- */

function activeSubRow(userId) {
  const s = store.getSubscription(userId);
  if (!s || !s.stripe_subscription_id) return null;
  if (!['trialing', 'active', 'past_due'].includes(s.status)) return null;
  if (s.cancel_at_period_end) return null;
  return s;
}

/* GET /api/billing/save-offer — is the customer eligible for a save offer? */
async function saveOfferStatus(req, res) {
  const sub = activeSubRow(req.user.user_id);
  const offer = store.getSaveOffer(req.user.user_id);
  res.json({
    eligible: !!sub,
    downsellAvailable: !!sub && !(offer && offer.downsell_used),
    downsellConfigured: Boolean(SAVE20_COUPON && ANNUAL_PRICE_ID),
    blueprintOwned: store.hasBlueprintPurchase(req.user.user_id),
  });
}

/* POST /api/billing/downsell {choice: 'monthly'|'annual'} — apply the
   too-expensive save offer. One use per customer, enforced in the DB. */
async function applyDownsell(req, res) {
  if (!SECRET) return res.status(503).json({ error: 'Billing is not configured yet.' });
  const choice = req.body && req.body.choice;
  if (choice !== 'monthly' && choice !== 'annual') {
    return res.status(400).json({ error: 'Pick monthly or annual.' });
  }
  const sub = activeSubRow(req.user.user_id);
  if (!sub) return res.status(400).json({ error: 'No active subscription to discount.' });
  const offer = store.getSaveOffer(req.user.user_id);
  if (offer && offer.downsell_used) {
    return res.status(400).json({ error: 'This one-time offer was already used on this account.' });
  }
  try {
    if (choice === 'monthly') {
      if (!SAVE20_COUPON) return res.status(503).json({ error: 'Discount is not configured yet.' });
      // 20% off forever -> $9.99 becomes $7.99/mo on all future invoices.
      await stripe.subscriptions.update(sub.stripe_subscription_id, { coupon: SAVE20_COUPON });
    } else {
      if (!ANNUAL_PRICE_ID) return res.status(503).json({ error: 'Annual plan is not configured yet.' });
      const live = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
      const itemId = live.items.data[0] && live.items.data[0].id;
      if (!itemId) return res.status(502).json({ error: 'Could not read the current subscription.' });
      await stripe.subscriptions.update(sub.stripe_subscription_id, {
        items: [{ id: itemId, price: ANNUAL_PRICE_ID }],
        proration_behavior: 'create_prorations',
      });
    }
    store.markDownsellUsed(req.user.user_id);
    // Refresh the local subscription row from Stripe.
    const updated = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    store.upsertSubscription(req.user.user_id, subToRow(updated));
    res.json({ ok: true, choice });
  } catch (e) {
    console.error('Downsell error:', e.message);
    res.status(502).json({ error: 'Could not apply the offer. Please try again.' });
  }
}

/* POST /api/billing/cancel {reason} — cancel at end of the billing period.
   The cancel button stays available through every step of the save flow. */
async function cancelSubscription(req, res) {
  if (!SECRET) return res.status(503).json({ error: 'Billing is not configured yet.' });
  const valid = ['too_expensive', 'not_using', 'other'];
  const reason = valid.includes(req.body && req.body.reason) ? req.body.reason : 'other';
  const s = store.getSubscription(req.user.user_id);
  if (!s || !s.stripe_subscription_id) {
    return res.status(400).json({ error: 'No subscription found for this account.' });
  }
  try {
    const updated = await stripe.subscriptions.update(s.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
    store.upsertSubscription(req.user.user_id, subToRow(updated));
    store.recordCancelReason(req.user.user_id, reason);
    res.json({ ok: true, cancelAt: iso(updated.cancel_at || updated.current_period_end) });
  } catch (e) {
    console.error('Cancel error:', e.message);
    res.status(502).json({ error: 'Could not cancel. Please try again or contact support.' });
  }
}

/* POST /api/billing/blueprint-checkout — $19 one-time Blueprint PDF. */
async function blueprintCheckout(req, res) {
  if (!configured()) return res.status(503).json({ error: 'Checkout is not configured yet.' });
  const userId = req.user.user_id;
  if (store.hasBlueprintPurchase(userId)) {
    return res.status(400).json({ error: 'You already own the Blueprint.' });
  }
  const bp = require('./blueprint');
  if (!bp.buildBlueprintData(userId)) {
    return res.status(400).json({ error: 'Finish your debt setup first — the Blueprint is built from your numbers.' });
  }
  try {
    const sub = store.getSubscription(userId);
    const customerId = sub && sub.stripe_customer_id;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId || undefined,
      customer_email: !customerId ? req.user.email : undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: BLUEPRINT_CENTS,
          product_data: { name: 'Debt-Free Date Blueprint (personalized PDF)' },
        },
        quantity: 1,
      }],
      success_url: `${APP_URL}/app?blueprint=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/app?blueprint=cancelled`,
      metadata: { userId: String(userId), type: 'blueprint' },
    });
    store.markOtoOffered(userId);
    res.json({ url: session.url });
  } catch (e) {
    console.error('Blueprint checkout error:', e.message);
    res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
}

/* GET /api/billing/blueprint?session_id= — verify purchase, stream the PDF. */
async function blueprintDownload(req, res) {
  if (!SECRET) return res.status(503).json({ error: 'Billing is not configured yet.' });
  const userId = req.user.user_id;
  try {
    if (!store.hasBlueprintPurchase(userId)) {
      const sessionId = req.query.session_id;
      if (!sessionId) return res.status(402).json({ error: 'Blueprint purchase required.' });
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const ok = session.payment_status === 'paid'
        && session.metadata && String(session.metadata.userId) === String(userId)
        && session.metadata.type === 'blueprint';
      if (!ok) return res.status(402).json({ error: 'Blueprint purchase required.' });
      store.recordBlueprintPurchase(userId, session.id, session.amount_total || BLUEPRINT_CENTS);
    }
    const bp = require('./blueprint');
    const data = bp.buildBlueprintData(userId);
    if (!data) return res.status(400).json({ error: 'No debt data to print yet.' });
    const pdf = await bp.generateBlueprintPDF(data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="debt-free-date-blueprint.pdf"');
    res.send(pdf);
  } catch (e) {
    console.error('Blueprint download error:', e.message);
    res.status(502).json({ error: 'Could not generate your Blueprint. Please try again.' });
  }
}
/* POST /webhooks/stripe — signature-verified event receiver.
   NOTE: this route must receive the RAW request body (see server.js). */
async function webhook(req, res) {
  if (!SECRET || !WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Stripe webhooks are not configured on this server.' });
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (e) {
    console.warn('Stripe webhook signature failure:', e.message);
    return res.status(400).json({ error: 'Invalid webhook signature.' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        // One-time Blueprint purchase (no subscription on the session).
        if (session.mode === 'payment') {
          const md = session.metadata || {};
          const userId = Number(md.userId);
          if (md.type === 'blueprint' && userId && session.payment_status === 'paid') {
            store.recordBlueprintPurchase(userId, session.id, session.amount_total || BLUEPRINT_CENTS);
          }
          break;
        }
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const userId = Number(session.metadata.userId || sub.metadata.userId);
        if (userId) store.upsertSubscription(userId, subToRow(sub));
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const userId = Number(sub.metadata.userId);
        if (userId) store.upsertSubscription(userId, subToRow(sub));
        else {
          // Fall back: match by subscription id (e.g. trials started elsewhere).
          const row = store.db.prepare(
            'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?').get(sub.id);
          if (row) store.upsertSubscription(row.user_id, subToRow(sub));
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const row = store.db.prepare(
          'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?').get(sub.id);
        if (row) store.setSubscriptionStatus(row.user_id, 'canceled'); // access revoked
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId = typeof invoice.subscription === 'string'
          ? invoice.subscription : invoice.subscription && invoice.subscription.id;
        if (subId) {
          const row = store.db.prepare(
            'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?').get(subId);
          if (row) store.setSubscriptionStatus(row.user_id, 'past_due'); // flag for dunning
        }
        break;
      }
      default:
        break; // ignore everything else
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Stripe webhook handler error:', e.message);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
}

module.exports = {
  configured, createCheckout, createPortal, webhook, APP_URL,
  saveOfferStatus, applyDownsell, cancelSubscription,
  blueprintCheckout, blueprintDownload,
};
