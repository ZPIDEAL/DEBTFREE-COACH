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
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

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

module.exports = { configured, createCheckout, createPortal, webhook, APP_URL };
