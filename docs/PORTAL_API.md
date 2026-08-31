# OmniFlow Portal API (BFF)

Ye website ke server-to-Control-Plane BFF endpoints ki documentation hai.
Inhe koi bhi internal tool ya integration same-origin session ke saath use kar
sakta hai. Saare responses `Cache-Control: no-store` ke saath aate hain.

Base URL (production): `https://omniflow-bice.vercel.app`

Authentication: HttpOnly cookies (`of_access_token` / `of_refresh_token`) —
login ke zariye set hoti hain. Browser ke ilawa kisi client ko ye cookies
chahiye hongi (login flow se).

---

## `GET /api/omniflow/portal/channels/whatsapp`

WhatsApp connector ka normalized status.

**200 Response:**
```json
{
  "configured": false,
  "state": "disconnected",
  "accountName": null,
  "phone": null,
  "lastSeenAt": null
}
```

- `configured: false` → Control Plane par connector module abhi deploy nahi hua.
  Jab backend endpoint live hoga, yeh field `true` ho jayegi aur UI khud active
  ho jayega (koi frontend change nahi chahiye).
- `state` ∈ `disconnected | connecting | connected | unknown`

## `POST /api/omniflow/portal/channels/whatsapp`

**Body:** `{ "action": "connect" | "disconnect" }`

**200 Response:** `{ "ok": true, "configured": true, "message": null }`

Errors: `403` (origin), `400` (unknown action), `401` (session), `503`.

## `GET /api/omniflow/portal/bot`

AI agent config (normalized). Backend module pending ho to defaults ke saath
`configured: false` return hota hai.

## `PUT /api/omniflow/portal/bot`

**Body:**
```json
{
  "agentName": "OmniFlow Assistant",
  "tone": "friendly | professional | concise",
  "greeting": "...",
  "fallback": "...",
  "workingHoursEnabled": true,
  "workingHoursStart": "09:00",
  "workingHoursEnd": "18:00",
  "humanHandoffEnabled": true
}
```

**200 Response:** `{ "ok": true, "configured": true }`
(`configured: false` = server module pending; website local draft rakhti hai.)

---

## Control Plane endpoints (LIVE — portal module deployed)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/portal/channels/whatsapp` | `{state, account_name, phone, last_seen_at}` |
| POST | `/api/v1/portal/channels/whatsapp` | `{action}` → `{ok, message}` (command queue) |
| GET | `/api/v1/portal/bot` | agent config (`agent_name`, `tone`, `greeting`, `fallback`, `working_hours_*`, `human_handoff_enabled`, `updated_at`) |
| PUT | `/api/v1/portal/bot` | save agent config → `{ok, updated_at}` |

Portal auth: `Authorization: Bearer <access token>` — backend extension token
ko main app ke in-process `GET /api/v1/auth/me` call se validate karta hai
(platform ke apne rules, koi duplicate validation nahi).

WhatsApp session server par NAHI chalti — status connector (customer ke
laptop) report karta hai; Connect/Disconnect commands table me queue hote
hain jo connector poll karta hai. Migration 008 tables (lazy auto-created):
`portal_whatsapp_status`, `portal_bot_configs`, `portal_connector_commands`.

---

## Control Plane CONNECTOR endpoints (laptop bridge ke liye)

Auth: `X-Omniflow-Key: <OMNIFLOW_SERVICE_KEY>` (server-to-device).
Tenant: body/query me `client_id` ya backend env `OMNIFLOW_CONNECTOR_USER_EMAIL`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/connector/whatsapp/status` | `{state, phone?, account_name?}` → portal status update |
| GET | `/api/v1/connector/whatsapp/commands` | pending commands (oldest first, `?limit=20`) |
| POST | `/api/v1/connector/whatsapp/commands/ack` | `{command_id, ok, note?}` |
| GET | `/api/v1/connector/bot` | tenant ka agent config (laptop bot isi se chalta hai) |

