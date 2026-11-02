# Deployment Guide - Response Delay Feature

## Overview

This guide covers deploying the Response Delay feature to production. The feature allows you to configure per-client response delays for the WhatsApp bot.

## Prerequisites

- Node.js 18+
- PostgreSQL database with the `response_delays` table
- Control Plane access with valid API key
- Admin access to the portal

## Database Setup

Run this SQL to create the required tables:

```sql
-- Response delay per client
CREATE TABLE IF NOT EXISTS response_delays (
  client_id TEXT PRIMARY KEY,
  response_delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK (response_delay_seconds >= 0 AND response_delay_seconds <= 3600),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Clients table
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  client_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'whatsapp',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default clients
INSERT INTO clients (id, client_id, name, platform, status) VALUES
  ('cli-001', '1', 'Production Test WhatsApp', 'whatsapp', 'active'),
  ('cli-002', '4', 'Isolation Test WhatsApp', 'whatsapp', 'active');
```

## Environment Variables

Add these to your `.env` file:

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/yourdb

# Control Plane
OMNIFLOW_SERVICE_KEY=your-service-key-here
OMNIFLOW_CP_BASE_URL=https://omniflow-control-plane-rho.vercel.app
OMNIFLOW_CLIENT_ID=1

# HTTP settings
OMNIFLOW_HTTP_TIMEOUT_SECONDS=8
OMNIFLOW_COMMAND_POLL_SECONDS=15
```

## Local Development

1. Install dependencies:
   ```
   npm install
   ```

2. Start the development server:
   ```
   npm run dev
   ```

3. Open http://localhost:3000

4. Go to **Admin > Bot Settings** to configure response delay

5. Go to **Admin > Analytics** to view metrics

## Testing

### Test Response Delay

1. Set a delay (e.g., 120 seconds) in Bot Settings
2. Save changes
3. Send a WhatsApp message to the bot
4. Verify the bot waits 120 seconds before replying

### Test Per-Client Delays

1. In Bot Settings, select a different client from the dropdown
2. Set a different delay for that client
3. Save changes
4. Send a message from that client's WhatsApp number
5. Verify the client-specific delay is applied

### Test Analytics

1. Go to **Admin > Analytics**
2. Verify you can see:
   - Total clients
   - Total messages
   - Average response delay
   - Average response time
   - Overall satisfaction score
   - Per-client metrics

## Production Deployment

### 1. Database Migration

Run the SQL commands from the [Database Setup](#database-setup) section on your production database.

### 2. Environment Variables

Set these environment variables in your production environment:

```env
DATABASE_URL=postgresql://user:password@prod-db:5432/prod-db
OMNIFLOW_SERVICE_KEY=prod-service-key-here
OMNIFLOW_CP_BASE_URL=https://omniflow-control-plane-rho.vercel.app
OMNIFLOW_CLIENT_ID=1
NODE_ENV=production
```

### 3. Deploy to Vercel

1. Connect your GitHub repository to Vercel
2. Configure the environment variables in Vercel dashboard
3. Deploy the application

### 4. Verify Deployment

1. Open your production URL
2. Log in to the admin panel
3. Go to **Bot Settings** and verify the response delay settings work
4. Go to **Analytics** and verify the metrics are displayed
5. Send a test WhatsApp message and verify the delay is applied

## Troubleshooting

### Response Delay Not Working

- Check that the response delay is set for the correct client
- Check that the Control Plane API is responding
- Check the server logs for errors
- Try setting delay to 0 (instant) to verify the bot responds

### Database Connection Issues

- Verify `DATABASE_URL` is correct
- Check that the database is accessible from the application
- Check database credentials

### Control Plane API Issues

- Verify `OMNIFLOW_SERVICE_KEY` is correct
- Check that `OMNIFLOW_CP_BASE_URL` is correct
- Check the Control Plane status page

## API Reference

For detailed API documentation, see [API Reference](./api-reference.md).
