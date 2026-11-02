# API Reference - Response Delay

## Overview

The Response Delay API allows you to configure how long the bot waits before sending a WhatsApp reply. You can set different delays for different clients.

## Endpoints

### GET /api/v1/omniflow/portal/bot/whatsapp-response-delay

Get the response delay for a specific client.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| client_id | string | Yes | The client ID to get the delay for |

**Response:**

```json
{
  "client_id": "1",
  "responseDelaySeconds": 120
}
```

### POST /api/v1/omniflow/portal/bot/whatsapp-response-delay

Set the response delay for a specific client.

**Request Body:**

```json
{
  "client_id": "1",
  "responseDelaySeconds": 120
}
```

**Response:**

```json
{
  "success": true,
  "client_id": "1",
  "responseDelaySeconds": 120
}
```

### GET /api/v1/omniflow/portal/bot/analytics

Get analytics data for all clients.

**Response:**

```json
{
  "total_clients": 2,
  "total_messages": 150,
  "avg_response_delay": 120,
  "avg_response_time": 3.5,
  "overall_satisfaction": 85.5,
  "clients": [
    {
      "client_id": "1",
      "client_name": "Production Test WhatsApp",
      "total_messages": 100,
      "avg_response_delay": 100,
      "avg_response_time": 3.2,
      "satisfaction_score": 88.0
    },
    {
      "client_id": "4",
      "client_name": "Isolation Test WhatsApp",
      "total_messages": 50,
      "avg_response_delay": 150,
      "avg_response_time": 4.0,
      "satisfaction_score": 80.0
    }
  ],
  "updated_at": "2024-01-15T10:30:00.000Z"
}
```

## Response Delay Values

| Delay | Duration | Description |
|-------|----------|-------------|
| 0 | Instant | Bot replies immediately |
| 1-60 | 1-60 seconds | Fast response |
| 61-300 | 1-5 minutes | Medium response |
| 301-3600 | 5-60 minutes | Slow response |

## Authentication

All endpoints require authentication via Control Plane token. The token is passed in the `Authorization` header.

```
Authorization: Bearer <your-token>
```

## Rate Limiting

| Endpoint Type | Limit |
|---------------|-------|
| Admin endpoints | 30 requests/minute |
| Bot config | 60 requests/minute |
| General API | 120 requests/minute |

## Errors

| Status | Description |
|--------|-------------|
| 400 | Bad request (invalid parameters) |
| 401 | Authentication required |
| 403 | Insufficient permissions |
| 429 | Rate limit exceeded |
| 500 | Server error |
