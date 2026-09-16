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

Notes:
- Stdlib only (no pip installs).
- Opted-out contacts (Compliance page / STOP keyword) never receive queued
  sends - the Control Plane drops them at queue time.
- Escalated chats, saved replies and the customer profile work unchanged
  because the conversation store is channel-safe.
