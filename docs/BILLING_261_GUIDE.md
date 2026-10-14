<!-- §261 -->
# Client billing (batch 261): how to apply and use it

This batch adds the owner's client billing: what each client owes OmniFlow, what is
paid, and when each plan expires. It is one patcher, `billing_261.mjs`.

Scope: payments are recorded by hand (a payment gateway comes later). Invoices are not
included. Currency defaults to PKR and is set in the billing rules.

## 1. What the patcher changes

Control Plane (also written to `omniflow-backend-patch/`):

- `portal_billing.py` (new): owner routes under `/api/v1/admin/billing`, the ledger and
  the expiry rule. Tables are created the first time the owner opens the billing page.
- `portal_plans.py`: a client's plan goes to Free when the saved expiry rule says so.
  A client with no billing row is not changed.
- `app.py`: registers the billing routes.

Website:

- `lib/omniflow/admin-billing-core.ts` (new): labels, money text, tones.
- `lib/omniflow/admin-billing.ts` (new): calls the Control Plane with the service key on the server.
- `app/admin/(panel)/customers/billing/` (new): the billing page and its server actions.
- `app/admin/(panel)/page.tsx`: a "Client billing" card on the admin dashboard.
- `lib/omniflow/admin-control-plane.ts`: `adminRequest` is exported for the billing module.
- `tools/cp-testrig/billing_harness_261.mjs` and `test_billing_261.py` (tests).

Database: the billing tables are created on first use. The checkout links table
(`portal_checkout_links`) gets a `paid_at` column and a trigger that stamps it when an
order first becomes paid. The column is backfilled once from the last update time.

## 2. Before you apply

1. Batch 259 must already be applied: the patcher checks for the 259 dashboard and nav,
   and stops with "Nothing was written" if they are missing.
2. Batches 259r2 and 260 (analytics) are not needed for billing, and billing does not
   change the analytics files.
3. Keep the Control Plane and the website on the same commit when you deploy.

## 3. Apply the patcher

1. Copy `billing_261.mjs` into the website root (the folder that has `package.json`,
   for example `D:\whatsapp-ai-bot`).
2. Open a terminal in that folder and run:

   ```
   node billing_261.mjs
   ```

3. Read the output. Each file should say `applied`. Run it a second time: every file
   should say `already`, and nothing changes.
4. Check the website compiles: `npx tsc --noEmit` must finish with no errors.

## 4. Deploy

1. Control Plane: commit and deploy `OmniFlow-Control-Plane/` (for example
   `git add OmniFlow-Control-Plane`, commit, push). No bridge restart is needed.
2. Website: `git add -A`, commit, deploy the website.
3. No SQL file has to be run by hand.

## 5. Set up the owner view

Open `/admin/customers/billing` (or the "Open client billing" button on the dashboard).

1. Billing rules (save once):
   - Currency: PKR is the default. Confirm this is the currency you bill in.
   - Commission base: pick one of the three options (see section 6).
   - When a plan expires: flag only, grace days then Free, or Free at once.
   - Grace days and the "expiring soon" window (days). Both default to 7.
2. For each client, open **Manage**:
   - Plan: billing kind (Free, Subscription with a fixed fee per period, or Commission
     as a percent of sales), the fee, the period length in days, the commission percent,
     **Billing starts** (the date the amounts start counting), **Paid until** (the expiry
     date), and an optional note. Save plan.
   - Record a payment: pays for subscription fee or commission, amount, date received
     (not in the future), method, reference, note. Record payment.
   - Latest payments: delete a mistaken payment (deleting is immediate).

## 6. How the numbers work

Ledger rule: fee and commission are counted from **Billing starts** up to today.
Payments received in that range are set against the amount. Pending = due - paid,
never below zero.

- Subscription: due = fee x number of periods started since Billing starts.
  Example: fee 1500, period 30 days, starts 65 days ago: 3 periods, so 4500 is due.
- Commission: due = commission % x sales in the chosen base, counted since Billing starts.

Commission base options:

- Paid sales, counting orders later cancelled: orders that were ever paid. Paid time
  comes from the new `paid_at` stamp. Orders paid before the stamp existed take their
  paid time from their last update, which is an approximation. Orders that were already
  cancelled before the stamp existed are not counted in this option, because their paid
  history was not recorded.
- Paid sales, minus cancelled orders: orders that are paid, shipped or delivered now.
- Delivered orders only.

Refunds: the platform records a refunded order as cancelled. Partial refunds are not
deducted (the platform does not track them).

Expiry (the paid-until date):

- Flag only: the plan stays on; the client shows as expired.
- Grace days, then Free: the plan stays on for the grace days after expiry, then the
  client panel shows the Free plan.
- Free at once: the client panel shows the Free plan on the day after expiry.

Expiry states: none, active, expiring soon (within the window), in grace period,
expired, moved to Free. A plan that expires today is still on for today.

Dates are the Control Plane server's calendar date.

## 7. Checks

Laptop (optional):

- `node billing_harness_261.mjs` (from `tools/cp-testrig/`): 9 checks on labels and money text.
- `python test_billing_261.py` (from `tools/cp-testrig/`): structure, the route contract,
  and the ledger on a real Postgres (needs `pgserver`, `psycopg2`, `flask`).

## 8. Troubleshooting

- The page says client billing is not available: the Control Plane is not reachable, or
  the service key is wrong. Check `OMNIFLOW_SERVICE_KEY` (or `OMNIFLOW_ADMIN_API_KEY`) on
  the Control Plane and in the website environment.
- A save says a field is invalid: the message names the field (for example a currency
  that is not 3 letters, or a date in the future for a payment).
- A client shows "Not set up": the client has a business profile but no billing plan yet.
  Open Manage and save a plan.

## 9. Not included in this batch

- Invoices and receipts (skipped for now).
- A payment gateway (payments are manual).
- Partial refunds, several currencies, and reminders by email.
