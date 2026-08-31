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

## Control Plane endpoints ye UI expect karte hain (jab deploy hon)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/portal/channels/whatsapp` | `{state, account_name, phone, last_seen_at}` |
| POST | `/api/v1/portal/channels/whatsapp` | `{action}` → `{ok, message}` |
| GET | `/api/v1/portal/bot` | agent config (`agent_name`, `tone`, `greeting`, `fallback`, `working_hours_*`, `human_handoff_enabled`) |
| PUT | `/api/v1/portal/bot` | save agent config |

Auth: `Authorization: Bearer <access token>` (website khud forward karti hai).
404/501 ka matlab "module pending" — website gracefully handle karti hai.
