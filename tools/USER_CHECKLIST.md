# OmniFlow — Deployment Verification Checklist (current state)

One page. Run the top block after EVERY patcher deploy; the rest only when noted.
Nothing here can break anything — these are read-only checks in the portal UI.

## Master run order (pending laptop batches - one sitting)
- [ ] Copy `add_batch_931_950_heal.mjs`, `add_batch_951_970_wati.mjs`,
      `add_batch_971_990_combined.mjs`, `add_batch_991_1010_cloud_lang.mjs`
      and `run_931_1010.sh` to the bot root; run `bash run_931_1010.sh`.
- [ ] Expect 10 / 10 / 27 / 14 applied, 0 warnings (re-run is safe).
- [ ] Restart the CP service AND the bot/bridge ONCE after all four finish.
- [ ] Commit + push both repos (the script prints the exact git commands),
      then work through the four batch sections below.

## After every deploy (2 minutes)
- [ ] Sign in loads the Overview; sidebar shows all items incl. **Win-back** (batch 411+).
- [ ] Conversations list opens; any thread opens with messages + composer.
- [ ] Analytics page renders its tiles.
- [ ] No browser console errors on Overview and Conversations.

## Interactive WhatsApp (891-910)
- [ ] A WhatsApp chat shows the **Interactive message** card; create a list
      template (3 options) and **Send** - the customer gets the menu (real
      buttons with a Cloud endpoint configured, otherwise a numbered list).
- [ ] Tapping an option lands its title in the chat and COD/keyword replies
      still work.

## Paid-status guard (911-930)
- [ ] As AGENT: pressing **Paid** on an open link shows the owners-only note
      under the row; **Returned** with a reason still works.
- [ ] As owner: **Paid** marks the link paid (the button now actually works
      on the web - it was silently broken before).
- [ ] After the 851 repair: Growth page shows **Customer insights** and
      **Top products** with real rows.

## After the laptop heal (931-950)
- [ ] Growth page shows **Customer insights** + **Top products** with real
      rows (the analytics depth feature is finally live end-to-end).
- [ ] A WhatsApp chat shows the **Interactive message** card; Settings shows
      the **Payments** and **Data & backup** cards.

## WATI templates (951-970)
- [ ] Settings shows the **WATI templates** card; tenant URL + API token save
      (token masked), **Sync approved templates** reports a count.
- [ ] A WhatsApp chat's card shows **WATI templates**; sending one (with
      Value1 | Value2 parameters) delivers the approved template and the
      thread shows the outbound "(template)" row.

## Money guard (811-830)
- [ ] From an AGENT login: recording an advance on a checkout link shows the
      inline owners-only message; saving a link WITH a discount is blocked too.
- [ ] As owner: advances and discounts still save normally.

## Payment gateway (831-850)
- [ ] Settings shows the **Payments** card - gateway is OFF by default.
- [ ] Add JazzCash (or Easypaisa) credentials, toggle sandbox if testing, save -
      the readout masks them (****last4).
- [ ] An unpaid checkout link's customer page shows **Pay <due> online** and it
      opens the hosted checkout page.

## Analytics depth (851-870)
- [ ] Growth page shows **Customer insights** (tier chips vip/repeat/new).
- [ ] Growth page shows **Top products** (units sold + revenue).

## Data safety (871-890)
- [ ] Settings shows **Data & backup**; **Download backup (JSON)** saves a file.
- [ ] **Run cleanup now** reports closed/purged counts.

## Recommendations (371-390)
- [ ] A chat with product mentions shows the **Recommendations** card (reason chips).
- [ ] A customer profile shows **Recommended next** (top 3).
- [ ] After marking a checkout link **Paid**, that item never returns in that contact's
      recommendations; co-purchased siblings rank first. Open-cart items never appear.

## Churn radar (391-410)
- [ ] Growth page shows **Churn radar** (top 5, score + reason).
- [ ] At-risk customer profiles show the amber/rose **Churn** chip (hover = reason).

## Daily digest (611-630)
- [ ] Growth page shows the **Daily digest** card - your WhatsApp number,
      on/off, hour. Save works.
- [ ] The next day you receive ONE WhatsApp summary (paid orders, open
      carts, returns) - not more than one per day.

## Link composer (751-770)
- [ ] Checkout links section has **+ New checkout link** - customer WhatsApp
      id, title, item rows, expiry - and the created link appears in the list.

## Discounts (771-790)
- [ ] Composer and Edit panel have a **Discount (Rs)** box; the row total and
      the customer's page show the discounted amount (`- 500 off`).

## Customer page 2.0 (711-730)
- [ ] Open a /c/ link: status chips (ordered / paid / shipped / delivered),
      item line totals, and - after an advance - **Advance received** +
      **Due on delivery**; paid links show **Paid in full**.

## Courier tracking (791-810)
- [ ] Shipped/paid links show a **Tracking** button - save the courier +
      tracking number and the row shows `TCS ABC123`; the customer's page
      shows the same card.

## WhatsApp share (731-750)
- [ ] An open link shows **Send on WhatsApp** - the customer gets the order
      summary with the link in chat.

## Link advances (691-710)
- [ ] Edit an open link -> **Advance received (Rs)**: record an advance and
      the row shows `due <remaining>`; the full amount flips the link to
      **paid** automatically.
- [ ] Closed links refuse advances.

## Link expiry & views (671-690)
- [ ] Edit an open link -> **Link expiry** select (No expiry / 3 / 7 / 14 /
      30 days); the row shows `3d left`, `Ends today`, then `Expired`.
- [ ] Open the /c/ link a couple of times -> the row shows `N views`.
- [ ] An expired open link tells the customer the link has expired; paid
      links always stay viewable.

## Link edit & duplicate (651-670)
- [ ] An OPEN checkout link shows **Edit** (change title/items, total
      recomputes) and **Duplicate** (fresh open link with a new token).
- [ ] Paid links show no Edit button.

## Exports (631-650)
- [ ] "Export revenue CSV" downloads the paid-orders spreadsheet.
- [ ] The Returns card's **Export CSV** downloads the returns ledger.

## Returns / RTO (591-610)
- [ ] Growth page shows the **Returns** card with a total count.
- [ ] Mark a paid order **Returned** -> pick a reason -> customer gets the
      return message, the order shows in Returns and drops from revenue.

## Cart recovery (571-590)
- [ ] Growth card shows the **Cart recovery** section - toggle on, gaps
      2/24/48 hours, Save.
- [ ] Leave a checkout link open past the first gap -> the customer gets
      up to 3 reminders; marking the link Paid stops them.

## Order updates (551-570)
- [ ] Growth page shows the **Order status updates** card (on/off toggle +
      three message boxes). Save works.
- [ ] Mark a checkout link Paid -> the customer chat shows the payment
      message; then Shipped -> shipping message; then Delivered.

## VIP customers (531-550)
- [ ] Inbox rows for your best repeat buyers show a green **★ vip** chip (3+ paid
      orders). Hover it to see the exact paid-order count. New/low-order
      conversations show no chip and load exactly as before.

## Daily brief (511-530)
- [ ] Overview shows the **Today** card: week revenue + delta, items to recover,
      at-risk count. It hides itself if the data is unavailable.
- [ ] Growth page **Restock radar** loads (was broken by the app.py anchor miss);
      profile **Lifetime value** card works.

## Revenue & pipeline (451-470)
- [ ] Growth page top card shows Revenue / Orders / Buyers / Pipeline tiles; the
      7/14/30/60 switcher sits on this card and the delta chip turns green/red.
- [ ] Top items lists best-sellers with up/down/steady chips; Pipeline Rs equals
      the sum of open cart values.

## Customer value (491-510)
- [ ] A paying customer's profile shows **Lifetime value** (Rs total, orders,
      avg, favourite item, reorder gap, tier chip).
- [ ] Customers page shows the **Top customers** strip linking to profiles.

## Restock radar (471-490)
- [ ] Growth page shows the Restock radar card: Stock up / Watch / Slow movers
      with weekly rates, % of revenue and last-sold age.

## Win-back (411-430)
- [ ] **Win-back** page lists: open carts (1d+), reorder-due repeat buyers, quiet payers.
- [ ] **Copy message** copies; **Open WhatsApp** opens wa.me with the right number.
- [ ] **Send via WhatsApp** delivers on the connected number (bridge running) and the
      button becomes "Sent"; a second press shows the note line, never double-sends.
- [ ] Empty workspace shows the three empty states; nothing ever auto-sends.

## Deploy fixes (both Vercel errors)
- [ ] **add_batch_1151_1160_fixes.mjs** chala kar dono repos me
      changes commit karein - CP repo me **poora folder** add karein
      (`git add OmniFlow-Control-Plane`, alag-alag files nahi) -
      CP Vercel deploy phir se green (500s khatam) aur website build
      green (media Download chalta he).

## Instant navigation (B13 - pure website speed)
- [ ] Website redeploy ke baad page kholein (Conversations,
      Customers, Broadcasts, Settings...) - har heavy page par
      **foran skeleton** (pulse animation) dikhta he, purana page
      freeze nahi hota. Navigation me zeher jaisa wait khatam.
- [ ] Agar koi page load na ho to ab toota hua screen nahi - ek
      saaf Roman-Urdu card ("Page load nahi ho saka" + Try again).

## FIX + Performance (B12 - Settings page card)
- [ ] Pehle B11 me agar patcher ne 2 warnings diye the (bridge anchor
      NOT FOUND) - woh **add_batch_1131_1140_perf.mjs** se fix ho
      jate hain: output me ab "+ send_media_message inserted" aur
      "+ send_media dispatch branch inserted" dikhna chahiye, **koi
      warning nahi**. (Bot/bridge restart zaroori - bridge badla.)
- [ ] Settings page me naya **Performance** card: rows (conversations
      / messages / orders), live query timings (ms) aur **Indexes
      healthy** chip + Refresh. Ye sirf report he - kuch block nahi
      hota; database indexes CP ke pehle run par khud ban jate hain
      (sab pages tez hote hain).

## Media & voice (B11 - sidebar -> Media)
- [ ] Sidebar me naya **Media** page he. Image / PDF / audio upload
      karein (max 8 MB) - library me kind chip + size ke sath
      dikhega. **Download** aur **Delete** foran kaam karte hain.
- [ ] **Send**: kisi asset par Send -> customer number (+ caption) ->
      queued. Customer ke WhatsApp par image/PDF/audio pahunchti he
      aur thread me "Image sent: ..." show hota he. (Bot par Cloud
      API env pehle se he - waise hi chalega.)
- [ ] **Transcribe** (sirf audio): voice note -> text + Copy. Is ke
      liye CP service env me **OMNIFLOW_STT_API_KEY** lagana he
      (openai-compatible; OMNIFLOW_STT_BASE/MODEL optional) - ek
      env line + CP restart, koi code change nahi.

## Courier connector (B10 - sidebar -> Courier)
- [ ] Sidebar me naya **Courier** page he - abhi **Not configured**
      chip dikhega (koi credentials nahi). Kuch live nahi hota jab
      tak aap khud credentials na dalein.
- [ ] Jab credentials milen: provider (Leopards / TCS) chunein, API
      key + password/secret paste karein -> **Save** ->
      **Test connection** (green message aana chahiye) ->
      **Connector: on**. Bus - live ho gaya, kuch redeploy nahi.
- [ ] **Book parcel** form se COD parcel book karein - tracking
      number foran milta he (address me kami ho to ready sawal bhi).
- [ ] **Bookings** list me har parcel ka status chip + **Track**
      button (delivered / returned / in transit waghera).

## HOTFIX - Vercel build (run this FIRST, before anything else)
- [ ] Copy the new **fix_portal_exports.mjs** to the bot root and run:
      `node fix_portal_exports.mjs` - expect **2 restored / 9 already
      present / 0 warnings** (it puts back exactly the missing
      putAlertSettings / markAlertsRead exports that broke the
      Vercel build). Re-run safe.
- [ ] Then commit + push the website repo and let Vercel redeploy -
      the build is green again. (The B8/B9 patchers now include this
      same repair, so future runs cannot reopen it.)

## COD intelligence + address check (B9 - COD page cards)
- [ ] The COD page now has two cards above the requests list:
      **COD risk check** and **Address check**.
- [ ] Risk check: enter a customer number (one with delivered orders)
      -> a 0-100 score with the WHY list (return history, confirm
      speed, order value, city) and a Proceed / Collect advance /
      Hold chip. Nothing is blocked automatically - advisory only.
- [ ] Set the hold threshold + turn **Staff tasks: on**, then check a
      risky customer -> "Staff task created" and it appears in the
      list below; **Done** clears it.
- [ ] Address check: paste a messy address -> the cleaned one-liner
      (Copy), city + phone extracted, and for anything missing a
      ready Roman-Urdu question with Copy - paste it into the chat.

## Revenue recovery + negotiation + AI copy (B8)
- [ ] Overview (dashboard home) shows the **Revenue recovery** card
      under the Daily Brief. An old open checkout link or unconfirmed
      COD appears as an item - **Follow up** queues the fixed polite
      Roman-Urdu message; **Dismiss** hides it.
- [ ] **Auto: on** on that card - from then on NEW recovery items get
      their follow-up queued automatically (one per item, ever).
- [ ] Settings -> **Negotiation bounds**: set min price + max discount
      %, save, then Quick check (1000 / 880) -> **COUNTER** at the
      floor (900) with a ready Roman-Urdu reply. The floor can never
      be crossed - the assistant only words the offer.
- [ ] Broadcasts -> **AI copy helper**: type a topic, pick Roman Urdu /
      اردو / English -> two short variants with Copy buttons. Without
      an AI key it still works (template copy) and says so.
- [ ] Vercel deploy is green again (the patcher restored the missing
      portal.ts exports - putAlertSettings / getGrowthBundle).

## Memory + Journey + Explain (B7 - Customer 360 cards)
- [ ] Open a customer's 360 page: two new cards - **Memory** and
      **Journey** (above "Recommended next").
- [ ] Memory: add a note (e.g. "sirf evening me delivery mangta he") -
      it appears with its kind; Edit changes it inline; Delete removes
      it; **Forget all** wipes everything about this customer (data
      safety) after one confirm.
- [ ] Journey: New / Engaged / Customer chips appear (seeded
      automatically). Click **Customer** - the chip turns green and
      "Last move" appears. Add your own stage with the inline field.
- [ ] The automation: mark one of this customer's checkout links FULLY
      paid - the contact lands on "Customer" with source **(auto)**.
- [ ] "Why this happened" (same card) lists the audit rows for this
      customer - checkout.advance, journey.stage, ai.answer...

## AI Brain (B6 - autonomy + grounded drafts)
- [ ] Settings shows the new **AI Brain** card: three levels (Off / Suggest
      only / Auto-answer) + an optional reply-tone field. Default is
      "Suggest only" - nothing auto-sends until you switch it yourself.
- [ ] With an LLM key set (OF_LLM_API_KEY + CP restart): press Save on a
      tone, then ask the brain for a draft on a real conversation
      (console: fetch("/api/omniflow/portal/brain/draft",
      {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({conversation_id: <id>})}).then(r=>r.json()).then(console.log))
      - you get a draft + grounding (kb/order ids), and NOTHING is sent.
- [ ] Switch to **Auto-answer**: an inbound customer question on a known
      topic gets exactly ONE brain reply (no double-send with the KB);
      the answer never promises refunds/discounts/dates.
- [ ] GET /api/v1/portal/brain/trace in the browser shows the decision,
      confidence and which tools were used.
- [ ] Switch back to **Suggest only** (or **Off**): auto-answers stop
      immediately - that is the rollback switch.

## Failure alerts (B5 - bell + Daily Brief v2)
- [ ] The dashboard sidebar footer now has a bell. Fresh workspace: quiet,
      no badge.
- [ ] Force a dead delivery (pause the WhatsApp provider, trigger a send,
      let it fail ~5 times): the badge appears with a count, the dropdown
      lists the failure with its error, and the home Daily Brief shows the
      amber "Needs attention" block with a recommended action.
- [ ] "Mark all read" clears the badge; a NEW failure alerts again (dedupe
      only suppresses unread duplicates).
- [ ] "Turn off" stops alerts for this tenant (the per-tenant switch);
      "Turn on" re-enables. OF_ALERTS=0 is the global switch.

## Growth speed + trace (B4 - rollups & observability)
- [ ] Open the Growth page twice in a row: the second open should feel
      instant (the bundle is cached ~45s); the whole page now costs ONE
      Control-Plane round trip instead of ~14.
- [ ] Break it on purpose (set OF_BUNDLE=0 + restart CP): the Growth page
      still loads exactly as before (it silently falls back to the old
      parallel calls). Turn it back on.
- [ ] In the CP log: fast clicks print nothing new; a slow request (>0.4s)
      prints one JSON line with trace_id / path / duration_ms - and every
      response carries an X-Of-Trace-Id header you can quote back to the log.

## Roman-Urdu intent (B3 - LLM layer)
- [ ] WITHOUT a key nothing changes: the CP still runs on keywords (set
      OF_LLM_API_KEY + restart to switch the LLM on).
- [ ] With a key: send "mera order kahan pohncha" (Roman Urdu) where the KB
      has an order-tracking entry -> the right auto-reply still comes (one
      only, per B2); "kitne din me delivery hogi" hits the shipping entry.
- [ ] COD: reply "haan kar do" -> request confirmed; "nahi cancel karo" ->
      declined; "agle hafte karna" -> stays pending (asked again later by
      design).
- [ ] Kill switch check: OF_LLM_ENABLED=0 + restart -> behaviour identical
      to B2 (keywords), no errors in the CP log.

## One-reply + rate limits (B2 - security pack)
- [ ] Send a message that triggers an automation (e.g. "tracking" while away
      hours are ON): the customer gets exactly ONE automatic reply, not two;
      the thread still gets language detection and routing as before.
- [ ] portal_events for that message shows claimed_by = away / cod / kb
      (whoever replied first) - SELECT id, claimed_by FROM portal_events
      ORDER BY id DESC LIMIT 5;
- [ ] Open one checkout link ~70 times within a minute (or curl -s
      localhost:PORT/api/v1/public/checkout/<token> in a loop): after the
      60th hit the reply becomes {"error":{"code":"rate_limited"...}} with
      HTTP 429; a minute later it works again. Normal customers never see
      this - only floods do.

## Deliveries queue (B1 - event core)
- [ ] Settings -> Deliveries: the four count chips load (Queued / Retrying /
      Failed / Delivered) and the list stays quiet when all is healthy.
- [ ] After any send failure (e.g. provider paused during a template send):
      the row moves to Retrying with the attempt count climbing, then to
      Failed after ~5 tries; Replay re-queues it and it delivers.
- [ ] The same customer message delivered twice by a webhook replay creates
      only ONE conversation entry (check the thread after a bridge restart
      with overlapping polls).

## Saved catalog + coupons + self-serve (971-990)
- [ ] Settings -> "Saved catalog": add a product (name + price like "Rs 2,500"),
      edit it, delete it; duplicate names are refused.
- [ ] Settings -> "Coupon codes": create EID25 (25%, max uses 5); the row shows
      usage counts; Pause stops it; Delete removes it.
- [ ] Growth -> "+ New checkout link": saved items appear as "From saved
      catalog" chips; tapping one fills a row with the price.
- [ ] Open an order link on a phone: "Have a coupon code?" applies EID25 and
      the Total drops + a coupon row appears; "Remove coupon" restores it.
- [ ] Same page: "Change address" and "Cancel order" send requests; Growth
      shows them under "Customer change requests" with Approve/Decline;
      approving an address updates the link, approving a cancel closes it,
      and the customer gets a WhatsApp note either way.
- [ ] Broadcasts -> "Schedule for later": your saved segments appear in the
      audience dropdown; schedule one to a segment and it sends on time.
- [ ] Settings -> Business hours: Urdu + Roman Urdu away-message fields exist;
      with them filled, an out-of-hours message gets the matching reply.
- [ ] On Android the installed app's long-press menu shows Inbox / Broadcasts /
      COD / Customers shortcuts.

## Cloud API templates + KB languages + insights (991-1010)
- [ ] Restart the CP service once AND the bot/bridge after applying (bridge
      gained new code this time).
- [ ] With Cloud API env vars set, within ~10 minutes the chat card shows a
      "Cloud API templates" section listing your Meta-approved template names;
      fill parameters like "Ahmed | K-01" and press Send -> the template
      arrives on the customer's WhatsApp and the chat shows a
      "Cloud API template" row. (Rejections - e.g. an unapproved template -
      show as a note on the row, no text fallback is sent.)
- [ ] Settings -> Knowledge base: every entry now has a Language select
      (auto/en/ur/roman) and the list has a language filter. Tag a delivery
      entry as Urdu, set that customer's language to Urdu under Customers,
      then message them "delivery" -> the Urdu answer auto-replies.
      (Heads-up: this batch also fixes an old bug - keyword auto-replies
      never actually fired before because of a broken text-normalizer; they
      work from now on, in every language.)
- [ ] Growth -> Customer insights shows a "Customer languages" chip row
      (ur 12, roman 7, ...) built from the stored per-customer languages.

## Batch 179 (B16): catalog import + advance-COD
- [ ] Settings -> Saved catalog -> "Import from store": save your
      WooCommerce/Shopify URL + keys, Import now -> items appear with a
      source + stock chip; re-import updates them in place.
- [ ] Growth -> new checkout link -> "Advance %" field works: the public
      link shows the pay-now amount and the on-delivery balance.

## Batch 178 (B15): setup wizard + plans
- [ ] Sidebar "Setup wizard" -> pick your business type -> the preview
      shows exactly what will be created -> Activate -> counts note
      appears and the bot/KB/replies/alerts pages show the seeds.
- [ ] Settings -> "Plan & usage" card shows live usage bars (workspace
      starts on Unlimited) and switching plans works both ways.

## Batch 177 (buildfix): one patcher, everything current
- [ ] Website `npm run build` passes (kb `lang` error + portal.ts export
      error gone).
- [ ] Routine from now on: run the patcher, then `git add -A` in the
      website repo and `git add OmniFlow-Control-Plane` in the CP repo
      (never partial staging), commit, push both.

## Batch 176 (B14): English UI + AI Brain + operations analytics + courier
- [ ] Every page reads in professional English (no Roman strings left in
      cards, errors, placeholders or empty states).
- [ ] Sidebar + command palette + overview quick links all show "AI Brain";
      the page saves autonomy + tone.
- [ ] Overview shows the "Operations - last 30 days" card with real numbers
      (paid orders, revenue, chats, messages, courier bookings, recovery,
      CSAT).
- [ ] Dashboard navigation feels instant on every page (skeleton first).
- [ ] Courier page: "+ Add courier" -> add a company (e.g. Leopards) with
      key + password -> Test shows ok -> Connect. Book a parcel with mode
      draft -> a violet "draft" row appears -> Confirm -> tracking number.
      Switch the row's mode to auto -> the next booking books instantly.

## Batch 180 (B17): plan enforcement + AI dedupe + grouped nav + overview cards
- [ ] Run `node add_batch_1201_1210_b17.mjs` in the bot root (both repos),
      then commit/push BOTH repos (CP: whole folder, website: git add -A).
- [ ] Configure AI is the ONLY AI page: sidebar has no "AI Brain" entry,
      opening /dashboard/ai-brain lands on Configure AI, and the page shows
      behaviour + follow-ups + the autonomy/tone card together.
- [ ] Sidebar reads in six groups (Inbox, Sell, Audience, Content,
      Insights, Workspace) with Overview first.
- [ ] Overview shows the new "Plan & usage" card (plan badge + four
      used/limit rows) and the "COD confirmations" pending count.
- [ ] Growth checkout rows: an open link with Advance % shows the
      "Pay Rs X now · Rs Y on delivery" badge.
- [ ] Record an advance on a link with a customer contact: the customer
      receives "Rs X received ... Rs Y will be collected on delivery."
      (and the covering payment sends the paid thank-you).
- [ ] On the Free plan: create a 21st KB entry -> blocked with a message
      about the 20-entry limit; legacy workspaces see no change.
- [ ] Sequences: "Add people" and Cancel still work (repo copies of the
      enroll/cancel routes restored - nothing changes on the laptop).

## Batch 181 (B18): multi-brand prep (brands + tagging)
- [ ] Run `node add_batch_1211_1220_b18.mjs` in the bot root (both repos),
      then commit/push BOTH repos (CP: whole folder, website: git add -A).
- [ ] Settings -> Brands: add a brand (e.g. "Studio A"), rename it, hide
      and show it - the row shows how many KB / catalog / link items use it.
- [ ] Knowledge base + Saved catalog + Growth checkout composer now show a
      Brand select (only when at least one brand exists).
- [ ] Tag one KB entry and one checkout link: the growth link row shows the
      brand chip and the public order page eyebrow reads "<Brand> . order
      summary".
- [ ] Plan & usage shows a "Brands" bar; on the Free plan a 2nd brand is
      blocked with the plan-limit message (legacy/pro: unlimited).
- [ ] Delete the test brand: the tagged entry/link are still there, just
      untagged - nothing was deleted.
- [ ] Untagged everything (default): KB answers, catalog rows and checkout
      links behave exactly as before.

## Batch 182 (B19): admin panel provider inputs (unblock the parked list)
- [ ] Run `node add_batch_1221_1230_b19.mjs` in the bot root (B18's patcher
      too if not yet run), then commit/push BOTH repos (CP: whole folder,
      website: git add -A).
- [ ] /admin/integrations -> Email: paste SMTP (or Brevo) settings + "Reports
      to" -> Save -> "Send test email" arrives in the inbox -> password-reset
      codes now mail out too.
- [ ] "Send weekly report now" delivers the per-workspace weekly digest.
- [ ] AI engine: paste any OpenAI-compatible base URL + key -> Save -> flip
      "True sentiment" and "KB auto-draft" ON (answer drafts now carry a
      saveable KB entry; sentiment answers with the engine).
- [ ] Voice (Twilio), Video, Payments keys save with masked boxes and the
      "Saved" chip - they arm those channels for launch.
- [ ] Phone verification switch saves the Ph9 decision; WhatsApp E2E card
      stores the live test number for the laptop run.
- [ ] Leave everything blank = nothing changes (env-var behavior stays).

## Batch 183 (B21): key-powered channels (the buttons go live)
- [ ] Run `node add_batch_1231_1240_b21.mjs` in the bot root (B18/B19 too if
      not yet), then commit/push BOTH repos (CP: whole folder, website:
      git add -A).
- [ ] Save Twilio keys (Admin > Integrations > Voice) -> open a WhatsApp
      conversation -> "Call the customer" -> Place call -> the phone rings.
- [ ] Save Whereby/Daily/Zoom keys -> "Video invite" -> Create & send ->
      the link lands in the customer's WhatsApp.
- [ ] Save the Stripe secret key -> workspace Payments settings -> pick
      "Stripe (platform keys)" -> enable -> a link's Pay online goes through
      Stripe Checkout and marks the order paid on return.
- [ ] Flip Phone verification ON -> a checkout link now asks "Send my code"
      -> the 6-digit code arrives on WhatsApp -> verify -> Pay online.
- [ ] With the AI key saved: conversation Agent assist -> "Draft with AI" ->
      the draft shows with "Save as KB answer".
- [ ] Catalog + knowledge-base cards show the "All brands" filter.
- [ ] Keys NOT saved = buttons show a clean "not configured" message and
      everything else is unchanged.

## Batch 184 (B22): multi-brand storefront (public store pages)
- [ ] Settings -> Brands -> rename a brand: the slug field cleans itself
      ("Studio B!" -> "studio-b"); junk is rejected, duplicates get a
      clear error.
- [ ] A brand with a slug shows a "Store" link on the Brands card - it
      opens the public page in a new tab.
- [ ] The public store page lists that brand's ACTIVE catalog items with
      pictures and prices; an unknown link shows a clean not-found card.
- [ ] Place an order with a phone number: the checkout link arrives on
      that WhatsApp number and completes like any checkout link.
- [ ] Ordering 4 times in 10 minutes from the same number hits the
      "try again shortly" limit.
- [ ] OPTIONAL: OMNIFLOW_SITE_URL set on the CP makes store/checkout
      links use the real domain.

## Batch 185 (B23): voice inbound + voicemail recordings
- [ ] Twilio console: set the number's "A call comes in" webhook to
      https://<CP-domain>/api/v1/public/voice/incoming (POST).
- [ ] Call the number from a phone: the greeting plays and a voicemail
      can be left.
- [ ] The conversation's Call card shows the caller with an "In" badge
      and an audio player - playback works.
- [ ] Unknown numbers still get logged (no badge conversation match).
- [ ] OPTIONAL: custom "greeting" in Admin > Integrations voice group;
      OMNIFLOW_SITE_URL set for the record action URL.

## Batch 186 (B24): Pakistan-only payments + true sentiment
- [ ] Settings > Payments: only JazzCash + Easypaisa in the provider
      list (Stripe gone); keys save and the card shows masks.
- [ ] A checkout link's "Pay online" posts to the gateway (sandbox tick
      = test gateway) and a paid test shows the link as paid.
- [ ] Admin > Integrations: AI engine key saved + "True sentiment (LLM)"
      ON -> the Assist card's Sentiment chip shows "AI" on classified
      messages; switch OFF = plain chip (word-list engine).

## Standing checks (older batches, spot-check monthly)
- [ ] Keyword alerts + routing rules still fire (Growth page).
- [ ] Checkout links: create → open link → mark Paid (COD flow).
- [ ] Saved replies insert; broadcasts compose; sequences view.
- [ ] Knowledge base search finds an entry; auto-reply toggle persists.
- [ ] Customers: notes add/delete, tags add/remove, CSV export works.
- [ ] Weekly report email arrives (only if SMTP/Brevo key configured — still pending).

## Still parked (need inputs, not code)
- Voice/video/payments channels — provider keys required.
- AI-locked: KB auto-draft, true sentiment — locked by owner decision.
- Ph9 phone verification — parked.
- Real WhatsApp E2E on the connector — test on laptop with the live number.

## Laptop repair (bad copy) - ONE patcher, sab theek
- [ ] Copy tools/patchers/add_batch_1301_1310_full_restore.mjs to the bot root (C:\Users\Ahmed Ansari\Desktop\whatsapp-ai-bot). Purane patchers (redesign/hotfix1) ki zaroorat nahi - ye SAB kuch restore karta hai (790 files: site + portal + admin + blog + lib glue + postcss + lockfile + favicon).
- [ ] node add_batch_1301_1310_full_restore.mjs   (pehli bar: applied jitni files missing thin, warnings = folder accidents; dusri bar: applied 0, already 790).
- [ ] rmdir /s /q node_modules
- [ ] npm install
- [ ] npm run build   (ab @theme bhi compile hoga - postcss.config.mjs restore ho chuki hai).
- [ ] Supabase SQL editor: db/blog_posts.sql ek dafa (blog admin ke liye).
- [ ] Rollback: har file ke sath *.pre_restore.bak bana hai.
