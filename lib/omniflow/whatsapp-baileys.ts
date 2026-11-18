import fs from "fs";
import os from "os";
import path from "path";
import { neonEnabled, neonQuery } from "../db/neon";

// Use dynamic runtime require so Next.js 16 Turbopack never statically bundles
// @whiskeysockets/baileys or its optional peer dependencies (jimp, sharp, etc.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runtimeRequire = new Function("mod", "return require(mod)") as (
  mod: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => any;

export interface BaileysSessionSnapshot {
  state: "connected" | "connecting" | "disconnected";
  connectionMode: "qr" | "pairing_code" | "none";
  phone: string | null;
  accountName: string | null;
  qrImageData: string | null;
  pairingCode: string | null;
  lastSeenAt: string | null;
}

type ActiveBaileysEntry = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sock: any;
  authDir: string;
  snapshot: BaileysSessionSnapshot;
};

const globalForBaileys = globalThis as unknown as {
  __omniflowBaileysMap?: Map<number, ActiveBaileysEntry>;
};

function getBaileysMap(): Map<number, ActiveBaileysEntry> {
  if (!globalForBaileys.__omniflowBaileysMap) {
    globalForBaileys.__omniflowBaileysMap = new Map();
  }
  return globalForBaileys.__omniflowBaileysMap;
}

function resolveAuthDir(clientId: number): string {
  const tmpDir = path.join(
    os.tmpdir(),
    "omniflow_whatsapp_sessions",
    `baileys_client_${clientId}`
  );
  try {
    fs.mkdirSync(/*turbopackIgnore: true*/ tmpDir, { recursive: true });
  } catch {
    // ignore
  }
  return tmpDir;
}

function formatPairingCode(raw: string): string {
  const cleaned = String(raw || "")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase();
  if (cleaned.length === 8) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
  }
  return cleaned;
}

function extractPhoneFromJid(jid: string | undefined | null): string | null {
  if (!jid) return null;
  const userPart = String(jid).split("@")[0].split(":")[0];
  const digits = userPart.replace(/\D/g, "");
  return digits.length >= 8 ? `+${digits}` : null;
}

async function syncSnapshotToNeon(
  clientId: number,
  snap: BaileysSessionSnapshot
): Promise<void> {
  if (!neonEnabled()) return;
  try {
    await neonQuery(
      `INSERT INTO portal_whatsapp_status
       (client_id, state, connection_mode, phone, account_name, qr_image_data, pairing_code, status_note, last_seen_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, NOW())
       ON CONFLICT (client_id) DO UPDATE
       SET state = EXCLUDED.state,
           connection_mode = EXCLUDED.connection_mode,
           phone = COALESCE(EXCLUDED.phone, portal_whatsapp_status.phone),
           account_name = COALESCE(EXCLUDED.account_name, portal_whatsapp_status.account_name),
           qr_image_data = EXCLUDED.qr_image_data,
           pairing_code = EXCLUDED.pairing_code,
           status_note = NULL,
           last_seen_at = COALESCE(EXCLUDED.last_seen_at, portal_whatsapp_status.last_seen_at),
           updated_at = NOW()`,
      [
        clientId,
        snap.state,
        snap.connectionMode,
        snap.phone,
        snap.accountName,
        snap.qrImageData,
        snap.pairingCode,
        snap.lastSeenAt,
      ]
    );
  } catch {
    // ignore DB sync errors
  }
}

export function getBaileysMemorySnapshot(
  clientId: number
): BaileysSessionSnapshot | null {
  const entry = getBaileysMap().get(clientId);
  return entry ? { ...entry.snapshot } : null;
}

export async function disconnectBaileysSession(clientId: number): Promise<void> {
  const map = getBaileysMap();
  const existing = map.get(clientId);
  map.delete(clientId);

  if (existing?.sock) {
    try {
      await existing.sock.logout();
    } catch {
      // ignore
    }
    try {
      existing.sock.end(undefined);
    } catch {
      // ignore
    }
  }

  const authDir = existing?.authDir || resolveAuthDir(clientId);
  try {
    if (fs.existsSync(/*turbopackIgnore: true*/ authDir)) {
      fs.rmSync(/*turbopackIgnore: true*/ authDir, {
        recursive: true,
        force: true,
      });
    }
  } catch {
    // ignore
  }
}

export async function startBaileysQrSession(
  clientId: number,
  accountName?: string | null
): Promise<BaileysSessionSnapshot> {
  await disconnectBaileysSession(clientId);

  const authDir = resolveAuthDir(clientId);
  const label = accountName?.trim() || `Workspace #${clientId} WhatsApp`;

  const snapshot: BaileysSessionSnapshot = {
    state: "connecting",
    connectionMode: "qr",
    phone: null,
    accountName: label,
    qrImageData: null,
    pairingCode: null,
    lastSeenAt: null,
  };

  try {
    const baileys = runtimeRequire("@whiskeysockets/baileys");
    const QRCode = runtimeRequire("qrcode");
    const pino = runtimeRequire("pino");

    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version: [number, number, number] = [2, 3000, 1015901307];
    try {
      const latest = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise<null>((r) => setTimeout(() => r(null), 2500)),
      ]);
      if (latest && Array.isArray(latest.version)) {
        version = latest.version as [number, number, number];
      }
    } catch {
      // use fallback version
    }

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 20000,
    });

    const entry: ActiveBaileysEntry = {
      sock,
      authDir,
      snapshot,
    };
    getBaileysMap().set(clientId, entry);

    sock.ev.on("creds.update", saveCreds);

    const firstQrPromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 6500);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sock.ev.on("connection.update", async (update: any) => {
        if (update.qr) {
          try {
            const dataUrl: string = await QRCode.toDataURL(update.qr, {
              width: 260,
              margin: 2,
              color: { dark: "#111827", light: "#ffffff" },
            });
            entry.snapshot.qrImageData = dataUrl;
            entry.snapshot.state = "connecting";
            entry.snapshot.connectionMode = "qr";
            await syncSnapshotToNeon(clientId, entry.snapshot);
            clearTimeout(timer);
            resolve();
          } catch {
            // ignore QR render error
          }
        }

        if (update.connection === "open") {
          const connectedPhone =
            extractPhoneFromJid(sock.user?.id) || entry.snapshot.phone;
          const connectedName =
            sock.user?.name || entry.snapshot.accountName || label;
          entry.snapshot.state = "connected";
          entry.snapshot.connectionMode = "qr";
          entry.snapshot.phone = connectedPhone;
          entry.snapshot.accountName = connectedName;
          entry.snapshot.qrImageData = null;
          entry.snapshot.pairingCode = null;
          entry.snapshot.lastSeenAt = new Date().toISOString();
          await syncSnapshotToNeon(clientId, entry.snapshot);
          clearTimeout(timer);
          resolve();
        }
      });
    });

    await firstQrPromise;
  } catch {
    // Fallback to whatsapp-live-bridge.js on the laptop if serverless outbound WS is restricted
  }

  return { ...snapshot };
}

export async function requestBaileysPairingCode(
  clientId: number,
  e164Phone: string,
  accountName?: string | null
): Promise<BaileysSessionSnapshot> {
  await disconnectBaileysSession(clientId);

  const authDir = resolveAuthDir(clientId);
  const label = accountName?.trim() || `WhatsApp (${e164Phone})`;
  const phoneDigits = e164Phone.replace(/\D/g, "");

  const snapshot: BaileysSessionSnapshot = {
    state: "connecting",
    connectionMode: "pairing_code",
    phone: e164Phone,
    accountName: label,
    qrImageData: null,
    pairingCode: null,
    lastSeenAt: null,
  };

  try {
    const baileys = runtimeRequire("@whiskeysockets/baileys");
    const pino = runtimeRequire("pino");

    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version: [number, number, number] = [2, 3000, 1015901307];
    try {
      const latest = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise<null>((r) => setTimeout(() => r(null), 2500)),
      ]);
      if (latest && Array.isArray(latest.version)) {
        version = latest.version as [number, number, number];
      }
    } catch {
      // use fallback version
    }

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 20000,
    });

    const entry: ActiveBaileysEntry = {
      sock,
      authDir,
      snapshot,
    };
    getBaileysMap().set(clientId, entry);

    sock.ev.on("creds.update", saveCreds);

    let pairingRequested = false;

    const codePromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 7500);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sock.ev.on("connection.update", async (update: any) => {
        if (
          !pairingRequested &&
          (update.qr || update.connection === "connecting")
        ) {
          pairingRequested = true;
          try {
            await new Promise((r) => setTimeout(r, 600));
            const rawCode: string = await sock.requestPairingCode(phoneDigits);
            if (rawCode) {
              const formatted = formatPairingCode(rawCode);
              entry.snapshot.pairingCode = formatted;
              entry.snapshot.state = "connecting";
              entry.snapshot.connectionMode = "pairing_code";
              await syncSnapshotToNeon(clientId, entry.snapshot);
              clearTimeout(timer);
              resolve();
            }
          } catch {
            // allow retry or bridge fallback
          }
        }

        if (update.connection === "open") {
          const connectedPhone =
            extractPhoneFromJid(sock.user?.id) || e164Phone;
          const connectedName = sock.user?.name || label;
          entry.snapshot.state = "connected";
          entry.snapshot.connectionMode = "pairing_code";
          entry.snapshot.phone = connectedPhone;
          entry.snapshot.accountName = connectedName;
          entry.snapshot.qrImageData = null;
          entry.snapshot.pairingCode = null;
          entry.snapshot.lastSeenAt = new Date().toISOString();
          await syncSnapshotToNeon(clientId, entry.snapshot);
          clearTimeout(timer);
          resolve();
        }
      });
    });

    await codePromise;
  } catch {
    // Fallback to whatsapp-live-bridge.js on the laptop if serverless outbound WS is restricted
  }

  return { ...snapshot };
}
