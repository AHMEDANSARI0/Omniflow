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

## Instagram bridge (Meta Graph API)

Instagram credentials stay in the workspace Control Plane. This worker only
polls the existing command queue and asks the Control Plane to deliver each
command through Meta's Instagram Graph API; it never stores provider secrets.
The public webhook is configured at:
`/api/v1/public/instagram/webhook`.

Set the following on the laptop and run `python3 instagram_bridge.py`:

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
