# NOOR STORE checkout (test mode only)

- Railway volume mounted at /data is REQUIRED before deployment. SQLite stock persists there.
- Stripe test secret key: STRIPE_SECRET_KEY (sk_test_...)
- Stripe test webhook endpoint: https://noor-store-web-production.up.railway.app/api/stripe-webhook
- Stripe webhook events: checkout.session.completed, checkout.session.expired, checkout.session.async_payment_failed
- Stripe webhook signing secret: STRIPE_WEBHOOK_SECRET (whsec_...)
- Set CHECKOUT_ENABLED=true only after volume, webhook and end-to-end test are verified.
- PUBLIC_STORE_URL=https://naruhito22-collab.github.io/noor-store/
- Stock initialized at 9 for each of 18 artworks; existing quantities are never reset on restart.
- Do not enable live charges: server only accepts sk_test_ keys.
- Before production: ensure reliable reconciliation of delayed asynchronous payments and checkout expiry, shipping/legal pages, refund policy, order fulfillment workflow, and alerting.
