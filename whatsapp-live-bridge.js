#!/usr/bin/env node
/**
 * whatsapp-live-bridge.js
 * ---------------------------------------------------------------------------
 * Official WhatsApp Web Multi-Device (wss://web.whatsapp.com/ws/chat) bridge
 * powered by @whiskeysockets/baileys + qrcode + pg.
 * Automatically managed by `python run_channel.py` (or runnable standalone via
 * `node whatsapp-live-bridge.js`). Zero Playwright / browser binary required!
 */
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// Load .env / .env.local if present
for (const envFile of [".env", ".env.local"]) {
  const full = path.join(process.cwd(), envFile);
  if (fs.existsSync(full)) {
    const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
      }
    }
  }
}

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.NEON_DATABASE_URL ||
  "";

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: connectionString.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
      max: 4,
    })
  : new Pool({
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || "postgres",
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "",
      max: 4,
    });

const activeSockets = new Map(); // clientId -> { sock, authDir, mode, phone, accountName }

function formatPairingCode(raw) {
  const cleaned = String(raw || "")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase();
  return cleaned.length === 8
    ? `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`
    : cleaned;
}

function extractPhoneFromJid(jid) {
  if (!jid) return null;
  const userPart = String(jid).split("@")[0].split(":")[0];
  const digits = userPart.replace(/\D/g, "");
  return digits.length >= 8 ? `+${digits}` : null;
}

async function updateDbStatus(clientId, fields) {
  try {
    await pool.query(
      `INSERT INTO portal_whatsapp_status
       (client_id, state, connection_mode, phone, account_name, qr_image_data, pairing_code, status_note, last_seen_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $2 = 'connected' THEN NOW() ELSE NULL END, NOW())
       ON CONFLICT (client_id) DO UPDATE
       SET state = EXCLUDED.state,
           connection_mode = EXCLUDED.connection_mode,
           phone = COALESCE(EXCLUDED.phone, portal_whatsapp_status.phone),
           account_name = COALESCE(EXCLUDED.account_name, portal_whatsapp_status.account_name),
           qr_image_data = EXCLUDED.qr_image_data,
           pairing_code = EXCLUDED.pairing_code,
           status_note = EXCLUDED.status_note,
           last_seen_at = CASE WHEN EXCLUDED.state = 'connected' THEN NOW() ELSE portal_whatsapp_status.last_seen_at END,
           updated_at = NOW()`,
      [
        clientId,
        fields.state || "disconnected",
        fields.connectionMode || "none",
        fields.phone || null,
        fields.accountName || null,
        fields.qrImageData || null,
        fields.pairingCode || null,
        fields.statusNote || null,
      ]
    );
  } catch (err) {
    // ignore transient DB error
  }
}

async function disconnectClient(clientId) {
  const existing = activeSockets.get(clientId);
  activeSockets.delete(clientId);
  if (existing && existing.sock) {
    try {
      await existing.sock.logout();
    } catch {}
    try {
      existing.sock.end(undefined);
    } catch {}
  }
  const authDir =
    existing?.authDir ||
    path.join(
      process.cwd(),
      "whatsapp_sessions",
      `baileys_client_${clientId}`
    );
  try {
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  } catch {}
  await updateDbStatus(clientId, {
    state: "disconnected",
    connectionMode: "none",
    phone: null,
    qrImageData: null,
    pairingCode: null,
    statusNote: null,
  });
}

async function startSessionForClient(clientId, mode, phone, accountName) {
  const baileys = require("@whiskeysockets/baileys");
  const QRCode = require("qrcode");
  const pino = require("pino");

  await disconnectClient(clientId);

  const authDir = path.join(
    process.cwd(),
    "whatsapp_sessions",
    `baileys_client_${clientId}`
  );
  fs.mkdirSync(authDir, { recursive: true });

  const makeWASocket = baileys.default || baileys.makeWASocket;
  const { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let version = [2, 3000, 1015901307];
  try {
    const latest = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((r) => setTimeout(() => r(null), 2500)),
    ]);
    if (latest && Array.isArray(latest.version)) {
      version = latest.version;
    }
  } catch {}

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  const entry = {
    sock,
    authDir,
    mode,
    phone: phone || null,
    accountName: accountName || `Workspace #${clientId} WhatsApp`,
    pairingRequested: false,
  };
  activeSockets.set(clientId, entry);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    if (mode === "qr" && update.qr) {
      try {
        const dataUrl = await QRCode.toDataURL(update.qr, {
          width: 260,
          margin: 2,
          color: { dark: "#111827", light: "#ffffff" },
        });
        await updateDbStatus(clientId, {
          state: "connecting",
          connectionMode: "qr",
          accountName: entry.accountName,
          qrImageData: dataUrl,
          pairingCode: null,
          statusNote: null,
        });
        console.log(`[WhatsApp Bridge] Live QR updated for Workspace #${clientId}`);
      } catch {}
    }

    if (
      mode === "pairing_code" &&
      !entry.pairingRequested &&
      (update.qr || update.connection === "connecting")
    ) {
      entry.pairingRequested = true;
      try {
        await new Promise((r) => setTimeout(r, 700));
        const digits = String(phone || "").replace(/\D/g, "");
        if (digits.length >= 8) {
          const rawCode = await sock.requestPairingCode(digits);
          const formatted = formatPairingCode(rawCode);
          await updateDbStatus(clientId, {
            state: "connecting",
            connectionMode: "pairing_code",
            phone: `+${digits}`,
            accountName: entry.accountName,
            qrImageData: null,
            pairingCode: formatted,
            statusNote: null,
          });
          console.log(
            `[WhatsApp Bridge] Official Pairing Code for Workspace #${clientId} (+${digits}): ${formatted}`
          );
        }
      } catch (err) {
        console.log(
          `[WhatsApp Bridge] Pairing code warning for Workspace #${clientId}: ${err.message}`
        );
      }
    }

    if (update.connection === "open") {
      const connectedPhone =
        extractPhoneFromJid(sock.user?.id) || entry.phone || "Linked Device";
      const connectedName =
        sock.user?.name || entry.accountName || `Workspace #${clientId} WhatsApp`;
      entry.phone = connectedPhone;
      await updateDbStatus(clientId, {
        state: "connected",
        connectionMode: mode,
        phone: connectedPhone,
        accountName: connectedName,
        qrImageData: null,
        pairingCode: null,
        statusNote: null,
      });
      console.log(
        `[WhatsApp Bridge] Workspace #${clientId} CONNECTED (${connectedPhone})`
      );
    }
  });

  // Forward incoming WhatsApp messages into portal_conversations & portal_messages
  sock.ev.on("messages.upsert", async (evt) => {
    if (evt.type !== "notify" || !Array.isArray(evt.messages)) return;
    for (const msg of evt.messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const remoteJid = msg.key.remoteJid || "";
        if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") {
          continue;
        }
        const senderPhone = extractPhoneFromJid(remoteJid) || remoteJid;
        const pushName = msg.pushName || senderPhone;
        const textBody =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          "";
        if (!textBody.trim()) continue;

        const convRes = await pool.query(
          `INSERT INTO portal_conversations
           (client_id, channel, contact_id, contact_name, status, last_message_preview, last_message_at, updated_at)
           VALUES ($1, 'whatsapp', $2, $3, 'open', $4, NOW(), NOW())
           ON CONFLICT (client_id, channel, contact_id) DO UPDATE
           SET contact_name = COALESCE(EXCLUDED.contact_name, portal_conversations.contact_name),
               last_message_preview = EXCLUDED.last_message_preview,
               last_message_at = NOW(),
               updated_at = NOW()
           RETURNING id`,
          [clientId, senderPhone, pushName, textBody.slice(0, 200)]
        );
        const convId = convRes.rows[0]?.id;
        if (convId) {
          await pool.query(
            `INSERT INTO portal_messages
             (conversation_id, client_id, direction, body, sender_name, status, created_at)
             VALUES ($1, $2, 'in', $3, $4, 'received', NOW())`,
            [convId, clientId, textBody, pushName]
          );
        }
      } catch {}
    }
  });
}

async function pollCommands() {
  try {
    // Clear any stale Playwright notice from portal_whatsapp_status
    await pool.query(
      `UPDATE portal_whatsapp_status
       SET status_note = NULL
       WHERE status_note ILIKE '%playwright%'`
    ).catch(() => null);

    const res = await pool.query(
      `SELECT id, client_id, action, payload
       FROM portal_connector_commands
       WHERE status = 'pending' AND channel = 'whatsapp'
       ORDER BY id ASC
       LIMIT 30`
    );

    for (const row of res.rows) {
      const cmdId = Number(row.id);
      const clientId = Number(row.client_id || 1);
      const action = String(row.action || "").toLowerCase();
      const payload =
        typeof row.payload === "object" && row.payload !== null
          ? row.payload
          : {};

      if (action === "start_qr" || action === "connect" || action === "reconnect") {
        await pool.query(
          `UPDATE portal_connector_commands
           SET status = 'done', result_note = 'Live QR session started', updated_at = NOW()
           WHERE id = $1`,
          [cmdId]
        );
        await startSessionForClient(
          clientId,
          "qr",
          null,
          payload.account_name || null
        );
      } else if (action === "request_pairing_code") {
        await pool.query(
          `UPDATE portal_connector_commands
           SET status = 'done', result_note = 'Official pairing code requested', updated_at = NOW()
           WHERE id = $1`,
          [cmdId]
        );
        await startSessionForClient(
          clientId,
          "pairing_code",
          payload.phone || "",
          payload.account_name || null
        );
      } else if (action === "disconnect") {
        await pool.query(
          `UPDATE portal_connector_commands
           SET status = 'done', result_note = 'Disconnected', updated_at = NOW()
           WHERE id = $1`,
          [cmdId]
        );
        await disconnectClient(clientId);
      } else if (action === "send_message") {
        const entry = activeSockets.get(clientId);
        const target = String(
          payload.contact_id || payload.external_user_id || payload.to || ""
        ).replace(/\D/g, "");
        const body = String(payload.body || payload.text || "").trim();
        if (entry?.sock && target && body) {
          try {
            await entry.sock.sendMessage(`${target}@s.whatsapp.net`, {
              text: body,
            });
          } catch {}
        }
        await pool.query(
          `UPDATE portal_connector_commands
           SET status = 'done', result_note = 'Sent', updated_at = NOW()
           WHERE id = $1`,
          [cmdId]
        );
      }
    }
  } catch {}
}

async function main() {
  console.log("[WhatsApp Multi-Device Bridge] Ready and listening for QR & Pairing requests...");
  await pollCommands();
  setInterval(pollCommands, 1800);
}

main();
