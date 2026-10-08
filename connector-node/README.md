# Connector node (laptop-side bridges)

These scripts run on the merchant's laptop next to the WhatsApp connector.
They are NOT part of the deployed website; copy them manually.

## Telegram bridge (v0)

Bridges a Telegram bot to OmniFlow through the SAME Control Plane endpoints
the WhatsApp connector already uses, with `channel="telegram"` and contacts
addressed as `tg:<chat_id>`.

1. Create a bot with @BotFather, copy the token.
2. On the laptop:

```
set OMNIFLOW_CP_URL=https://<your-control-plane>
set OMNIFLOW_SERVICE_KEY=<same key the WhatsApp connector uses>
set TELEGRAM_BOT_TOKEN=<token from BotFather>
python3 telegram_bridge.py
```

3. In the portal, conversations from the bot appear like any other chat
   (channel `telegram`, contact `tg:<chat_id>`). Broadcasts, sequences and
   COD asks queued for a `tg:` contact are delivered by this bridge; the
   WhatsApp bridge never sees them (command poll is channel-filtered).

## Instagram bridge (Meta Graph API) - retired in §256

**Not needed any more.** Since OmniFlow 256 the Control Plane sends
Instagram and Messenger replies (DMs, comment replies, away replies) itself
through the Graph API, like email, SMS and the API-mode social channels.
Stop any running `instagram_bridge.py` - nothing has to be restarted. Run
against a 256 Control Plane, the script says so and exits on its own.

Settings > Meta > **Run setup check** shows, live from the Graph API, what is
still missing (token permissions, webhook subscription, Page subscription,
Instagram-Page link, events arriving) and can fix the Page subscription and
the webhook registration with one click. App Review / Live mode is the only
step left in the Meta console. The webhook URL is
`/api/v1/public/meta/webhook` (the old `/instagram/webhook` keeps working).

Rollback only: with `OF_META_CP_SEND=0` on the Control Plane, replies wait
for this bridge again. Set the following on the laptop and run
`python3 instagram_bridge.py`:

```
export OMNIFLOW_CONTROL_PLANE_URL=https://<your-control-plane>
export OMNIFLOW_SERVICE_KEY=<same key the connector uses>
export OMNIFLOW_CLIENT_ID=<workspace id>
```

Instagram contacts use the canonical `ig:<scoped-user-id>` form. The same
conversation, one-reply, approvals, compliance, workflow and audit paths are
used for these messages.

Notes:
- Stdlib only (no pip installs).
- Opted-out contacts (Compliance page / STOP keyword) never receive queued
  sends - the Control Plane drops them at queue time.
- Escalated chats, saved replies and the customer profile work unchanged
  because the conversation store is channel-safe.

## Social login bridge (X, LinkedIn, Telegram personal) - §255

Login mode for the social channels: the laptop logs in to the merchant's
own account and the Control Plane keeps the queue, approvals, opt-outs and
audit. In API mode (the merchant's own app keys, Settings > Social channels)
nothing runs here - the Control Plane talks to the platform directly.

WARNING: login mode uses UNOFFICIAL libraries. The platforms do not allow
automated logins; the account can be challenged, rate limited or banned.
Use API mode when the platform offers it, and keep message volume human.

| Channel           | What login mode does                      | pip install    |
|-------------------|-------------------------------------------|----------------|
| `x`               | DMs, replies to mentions, posts           | `twikit`       |
| `linkedin`        | Personal messages only                    | `linkedin-api` |
| `telegram` (personal account; inbox channel `telegram_user`) | Private chats | `telethon` |

TikTok and YouTube have no login mode (API only).

1. In the portal: Settings > Social channels > pick the channel > mode
   **Login (laptop)** > switch on DMs / comments / publishing > turn it on.
2. On the laptop (Python 3.10+), install only what you use, e.g.
   `pip install twikit telethon`.
3. Set the environment and run it next to the WhatsApp connector:

```
set OMNIFLOW_CP_URL=https://<your-control-plane>
set OMNIFLOW_SERVICE_KEY=<same key the WhatsApp connector uses>
set SOCIAL_LOGIN_CHANNELS=x,telegram,linkedin
rem optional: OMNIFLOW_CLIENT_ID, OMNIFLOW_POLL_SECONDS (20), SOCIAL_FETCH_SECONDS (60), SOCIAL_SESSION_DIR

rem Telegram personal - api id / hash from https://my.telegram.org
set TELEGRAM_API_ID=<id>
set TELEGRAM_API_HASH=<hash>
set TELEGRAM_PHONE=+92...
rem TELEGRAM_PASSWORD only if two-step verification is on

rem X
set X_USERNAME=<handle>
set X_EMAIL=<email>
set X_PASSWORD=<password>
rem X_TOTP_SECRET if the account uses an authenticator app

rem LinkedIn
set LINKEDIN_EMAIL=<email>
set LINKEDIN_PASSWORD=<password>

python social_login_bridge.py
```

4. The first Telegram run asks for the login code in the console once; the
   session (and the X / LinkedIn cookies) are saved in `SOCIAL_SESSION_DIR`.
   Keep that folder private - it is the logged-in account. It is in the
   laptop folder only, never sent to the Control Plane.
5. The first run imports no old messages; only new ones arrive in the inbox.
   The card shows "Bridge online" while the script runs.

How it talks to the Control Plane (same key, no new secrets there):
- `POST /api/v1/connector/social/status` every loop (the card's bridge state;
  the reply says whether the channel is on).
- `POST /api/v1/connector/social/messages` for new DMs / mentions.
- `GET /api/v1/connector/whatsapp/commands?channel=<x|linkedin|telegram_user>`
  for replies and posts, acked as usual; the WhatsApp and Telegram-bot
  bridges never receive this work.
- `GET /api/v1/connector/away-replies?social=<channel>` for DM away replies
  (public comment replies are never automatic).
