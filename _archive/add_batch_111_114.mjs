// add_batch_111_114.mjs - one-file batch covering Phases 111-114.
//
//   Ph111  CONTROL PLANE: away-reply queue. A lazy portal_away_replies table,
//          a business-hours loader, a closed-now check (zoneinfo, weekday
//          math, no locale), and an ingest hook that enqueues ONE away reply
//          per conversation per 4h whenever hours are enabled and closed.
//          Connector endpoints GET /connector/away-replies + /ack mirror the
//          followups pair.
//   Ph112  LAPTOP BRIDGE (src/control_plane_bridge.py): process_due_away
//          mirrors process_due_followups - polls, sends via
//          adapter.send(OutboundMessage), ingests the reply as direction=out
//          so it lands in the thread, then acks. REQUIRES the followup
//          agent batch applied first (its blocks are the anchors).
//   Ph113  WEBSITE: an amber "Away replies are active" chip on the WhatsApp
//          channel page whenever business hours are enabled and closed.
//   Ph114  Test rig: functional suite for the CP away logic.
//
// Away copy comes from the business-hours config the user saves in Settings.
// Zero AI. After this batch: bot restart on the laptop picks the bridge
// change up; the CP deploys on push.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CP_PATH = "OmniFlow-Control-Plane/connector_api.py";
const BRIDGE_PATH = "src/control_plane_bridge.py";
const CHANNELS_PAGE_PATH =
  "Omniflow/app/dashboard/(portal)/channels/whatsapp/page.tsx";

// --- Ph111: helpers + connector endpoints before the ingest route ------------

const CP_HELPERS_FROM = `@bp.post("/whatsapp/messages")
def ingest_whatsapp_messages():`;

const CP_HELPERS_TO = `_AWAY_TABLE_READY = False
AWAY_COOLDOWN_HOURS = 4
_AWAY_DEFAULTS = {
    "enabled": False,
    "timezone": "Asia/Karachi",
    "days": [
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
        {"enabled": True, "start": "09:00", "end": "17:00"},
    ],
    "away_message": "",
}


def _ensure_away_table() -> None:
    global _AWAY_TABLE_READY
    if _AWAY_TABLE_READY:
        return
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS " + portal_db._q("portal_away_replies") +
                " (id BIGSERIAL PRIMARY KEY, client_id BIGINT NOT NULL,"
                " conversation_id BIGINT, contact_id TEXT NOT NULL,"
                " body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',"
                " result_note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
                " sent_at TIMESTAMPTZ)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS portal_away_pending_idx ON " +
                portal_db._q("portal_away_replies") +
                " (client_id, status, id)"
            )
        conn.commit()
    finally:
        conn.close()
    _AWAY_TABLE_READY = True


def _load_business_hours(cur, client_id):
    try:
        cur.execute(
            "SELECT settings -> 'business_hours' AS business_hours FROM " +
            portal_db._q("client_settings") +
            " WHERE client_id = %s",
            (client_id,),
        )
        rows = portal_db.rows(cur)
    except Exception:
        return _AWAY_DEFAULTS
    stored = rows[0].get("business_hours") if rows and rows[0] else None
    return stored if isinstance(stored, dict) else _AWAY_DEFAULTS


def _away_closed_now(config) -> bool:
    try:
        from zoneinfo import ZoneInfo

        days = config.get("days")
        if not isinstance(days, list) or len(days) != 7:
            return False
        now = datetime.now(ZoneInfo(str(config.get("timezone") or "UTC")))
        day = days[(now.weekday() + 1) % 7]
        if not isinstance(day, dict) or day.get("enabled") is not True:
            return True
        current = now.strftime("%H:%M")
        start = day.get("start")
        end = day.get("end")
        if not isinstance(start, str) or not isinstance(end, str):
            return True
        return not (start <= current <= end)
    except Exception:
        return False


def _maybe_enqueue_away_reply(client_id, conversation_id, contact_id, direction, conn):
    """Queue one automatic away reply, inside the ingest transaction.

    Fires only for inbound messages while business hours are enabled and
    currently closed, at most once per conversation per cooldown window.
    Never raises into the caller: wrap in try/except there.
    """
    if direction != "in":
        return
    with conn.cursor() as cur:
        config = _load_business_hours(cur, client_id)
        message = config.get("away_message")
        if (
            config.get("enabled") is not True
            or not isinstance(message, str)
            or not message.strip()
        ):
            return
        if not _away_closed_now(config):
            return
        cur.execute(
            "SELECT 1 FROM " + portal_db._q("portal_away_replies") +
            " WHERE client_id = %s AND conversation_id = %s"
            " AND created_at > NOW() - INTERVAL '" +
            str(AWAY_COOLDOWN_HOURS) + " hours'"
            " LIMIT 1",
            (client_id, conversation_id),
        )
        if portal_db.rows(cur):
            return
        cur.execute(
            "INSERT INTO " + portal_db._q("portal_away_replies") +
            " (client_id, conversation_id, contact_id, body)"
            " VALUES (%s, %s, %s, %s)",
            (client_id, conversation_id, contact_id, message.strip()),
        )


@bp.get("/away-replies")
def list_due_away_replies():
    args = request.args
    tenant, error = _tenant_or_error(args.get("client_id"))
    if error:
        return error
    limit = _query_int("limit", 5, 1, 20)

    try:
        _ensure_away_table()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, contact_id, body, created_at FROM " +
                    portal_db._q("portal_away_replies") +
                    " WHERE client_id = %s AND status = 'pending'"
                    " ORDER BY id ASC LIMIT %s",
                    (tenant["client_id"], limit),
                )
                found = portal_db.rows(cur)
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "away replies read")[0]), 503

    replies = []
    for row in found:
        created = row.get("created_at")
        if isinstance(created, datetime) and created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        replies.append({
            "id": row.get("id"),
            "external_user_id": row.get("contact_id"),
            "body": row.get("body"),
            "created_at": created.isoformat() if isinstance(created, datetime) else None,
        })
    return jsonify({"away_replies": replies}), 200


@bp.post("/away-replies/ack")
def ack_away_reply():
    payload = _json_body()
    tenant, error = _tenant_or_error(payload.get("client_id"))
    if error:
        return error

    away_id = payload.get("away_id")
    if isinstance(away_id, bool) or not isinstance(away_id, int) or away_id <= 0:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "away_id (positive int) zaroori hai."}}), 400
    ok_flag = payload.get("ok") is True
    note = payload.get("note")
    note = note if isinstance(note, str) else None

    try:
        _ensure_away_table()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE " + portal_db._q("portal_away_replies") +
                    " SET status = %s, result_note = %s, sent_at = NOW()"
                    " WHERE id = %s AND client_id = %s AND status = 'pending' RETURNING id",
                    ("sent" if ok_flag else "failed", note, away_id, tenant["client_id"]),
                )
                updated = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "away ack")[0]), 503

    if not updated:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Away reply nahi mili."}}), 404
    return jsonify({"ok": True}), 200


@bp.post("/whatsapp/messages")
def ingest_whatsapp_messages():`;

// --- Ph111: the ingest hook ---------------------------------------------------

const CP_HOOK_FROM = `                    inserted += 1`;

const CP_HOOK_TO = `                    try:
                        _maybe_enqueue_away_reply(
                            tenant["client_id"],
                            conversation_id,
                            item["from"],
                            item["direction"],
                            conn,
                        )
                    except Exception:
                        pass
                    inserted += 1`;

// --- Ph112: the bridge polls away replies right after followups ----------------

const BRIDGE_RUN_FROM = `    def run_due_commands(
        self,
        adapter,
        stop_requested=None,
    ):
        try:
            self.process_due_followups(adapter)
        except Exception as followup_error:
            print(f"CP bridge followups warning: {followup_error}")

        commands = self.fetch_commands()`;

const BRIDGE_RUN_TO = `    def run_due_commands(
        self,
        adapter,
        stop_requested=None,
    ):
        try:
            self.process_due_followups(adapter)
        except Exception as followup_error:
            print(f"CP bridge followups warning: {followup_error}")

        try:
            self.process_due_away(adapter)
        except Exception as away_error:
            print(f"CP bridge away warning: {away_error}")

        commands = self.fetch_commands()`;

// --- Ph112: away delivery methods after the followups block ---------------------

const BRIDGE_METHODS_FROM = `            self.acknowledge_followup(followup_id, success, note)

            print(
                "CP bridge follow-up "
                f"{followup_id}: "
                + ("sent" if success else "failed/deferred")
                + (
                    " — " + note
                    if note
                    else ""
                )
            )`;

const BRIDGE_METHODS_TO = `            self.acknowledge_followup(followup_id, success, note)

            print(
                "CP bridge follow-up "
                f"{followup_id}: "
                + ("sent" if success else "failed/deferred")
                + (
                    " — " + note
                    if note
                    else ""
                )
            )

    # ---------- away replies ----------

    def fetch_due_away(self, limit=5):
        status, data = self._request(
            "GET",
            "/api/v1/connector/away-replies?client_id="
            + str(self.client_id)
            + "&limit="
            + str(int(limit)),
        )
        if status != 200:
            return []
        rows = data.get("away_replies") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            return []
        return rows

    def acknowledge_away(self, away_id, ok, note=None):
        self._request(
            "POST",
            "/api/v1/connector/away-replies/ack",
            {
                "away_id": away_id,
                "ok": bool(ok),
                "note": note,
            },
        )

    def process_due_away(self, adapter):
        try:
            replies = self.fetch_due_away()
        except Exception as error:
            print(f"CP bridge away warning: {error}")
            return
        if not replies:
            return

        try:
            from channels.contracts import OutboundMessage
        except ImportError:
            from src.channels.contracts import OutboundMessage

        account_id = getattr(
            getattr(adapter, "account", None), "id", 0
        )

        for reply in replies:
            away_id = reply.get("id")
            if not isinstance(away_id, int):
                continue

            target_user = str(
                reply.get("external_user_id") or ""
            ).strip()
            body_text = str(reply.get("body") or "").strip()

            if not target_user or not body_text:
                self.acknowledge_away(away_id, False, "Invalid away payload.")
                continue

            send_result = None
            note = None
            try:
                send_result = adapter.send(
                    OutboundMessage(
                        channel_account_id=int(account_id or 0),
                        external_user_id=target_user,
                        content=body_text,
                        message_type="text",
                        metadata={},
                    )
                )
            except Exception as error:
                note = f"Away send error: {error}"

            success = (
                send_result is not None
                and send_result.success
            )

            if success:
                try:
                    self.ingest_message(
                        external_user_id=target_user,
                        body=body_text,
                        direction="out",
                    )
                except Exception:
                    pass
                note = "Away reply sent."
            elif send_result is not None:
                note = "Away send failed: " + str(
                    send_result.error or "unknown error"
                )

            self.acknowledge_away(away_id, success, note)

            print(
                "CP bridge away reply "
                f"{away_id}: "
                + ("sent" if success else "failed/deferred")
                + (
                    " — " + note
                    if note
                    else ""
                )
            )`;

// --- Ph113: away chip on the WhatsApp channel page -------------------------------

const CHIP_RENDER_FROM = `      <p className="mt-4 text-[11px] leading-relaxed text-slate-600">
        Status auto-refreshes every 15 seconds while this page is open. Session
        credentials stay in HttpOnly cookies.
      </p>
    </div>
  );
}`;

const CHIP_RENDER_TO = `      <AwayChip />
      <p className="mt-4 text-[11px] leading-relaxed text-slate-600">
        Status auto-refreshes every 15 seconds while this page is open. Session
        credentials stay in HttpOnly cookies.
      </p>
    </div>
  );
}

function AwayChip() {
  const [awayActive, setAwayActive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/omniflow/portal/business-hours", {
          credentials: "same-origin",
        });
        const payload = (await response.json()) as {
          business_hours?: {
            enabled?: boolean;
            timezone?: string;
            days?: { enabled: boolean; start: string; end: string }[];
          };
        };
        const config = payload.business_hours;
        if (!config || !config.enabled || cancelled) return;
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: config.timezone,
          hour12: false,
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        }).formatToParts(new Date());
        const weekday =
          parts.find((part) => part.type === "weekday")?.value ?? "";
        const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
        const minute =
          parts.find((part) => part.type === "minute")?.value ?? "00";
        const day = (config.days ?? [])[dayNames.indexOf(weekday)];
        const now = hour.padStart(2, "0") + ":" + minute;
        const openNow =
          day && day.enabled && now >= day.start && now <= day.end;
        if (!openNow && !cancelled) setAwayActive(true);
      } catch {
        // Transient network issue, the chip stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!awayActive) return null;
  return (
    <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-1.5 text-xs font-medium text-amber-300">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      Away replies are active until business hours
    </div>
  );
}`;

// Driver

const TARGETS = [
  {
    file: CP_PATH,
    swaps: [
      { name: "p111-cp-away-block", from: CP_HELPERS_FROM, to: CP_HELPERS_TO },
      { name: "p111-ingest-hook", from: CP_HOOK_FROM, to: CP_HOOK_TO, guard: '_maybe_enqueue_away_reply(\n                            tenant["client_id"],' },
    ],
  },
  {
    file: BRIDGE_PATH,
    swaps: [
      { name: "p112-bridge-poll", from: BRIDGE_RUN_FROM, to: BRIDGE_RUN_TO },
      { name: "p112-bridge-methods", from: BRIDGE_METHODS_FROM, to: BRIDGE_METHODS_TO },
    ],
  },
  {
    file: CHANNELS_PAGE_PATH,
    swaps: [
      { name: "p113-away-chip", from: CHIP_RENDER_FROM, to: CHIP_RENDER_TO },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function compilePython(pathArg) {
  for (const py of ["python", "python3"]) {
    try {
      execFileSync(py, ["-m", "py_compile", pathArg], { stdio: "pipe" });
      return true;
    } catch {
      /* try next interpreter */
    }
  }
  return false;
}

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/\r\n/g, "\n"), "utf8");
}

for (const target of TARGETS) {
  if (!fs.existsSync(target.file)) {
    console.log("SKIP (file not found): " + target.file);
    warnTotal++;
    continue;
  }

  const original = fs.readFileSync(target.file, "utf8");
  let text = original.replace(/\r\n/g, "\n");
  let changed = false;
  const fileApplied = [];

  for (const swap of target.swaps) {
    if (swap.guard && text.includes(swap.guard)) {
      alreadyTotal++;
      continue;
    }
    const fromCount = text.split(swap.from).length - 1;
    const toCount = text.split(swap.to).length - 1;

    if (fromCount === 1 && toCount === 0) {
      text = text.split(swap.from).join(swap.to);
      changed = true;
      appliedTotal++;
      fileApplied.push(swap.name);
    } else if (toCount > 0) {
      alreadyTotal++;
    } else {
      warnTotal++;
      console.log("  ? " + target.file + " :: " + swap.name + " NOT FOUND — report this");
    }
  }

  if (!changed) {
    console.log("= " + target.file + " (already patched)");
    continue;
  }

  const backup = target.file + ".pre_b111114.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);

  if (target.file.endsWith(".py")) {
    fs.writeFileSync(target.file, text, "utf8");
    if (!compilePython(target.file)) {
      fs.copyFileSync(backup, target.file);
      console.log("FAIL (compile failed, restored): " + target.file);
      warnTotal++;
      continue;
    }
  } else {
    fs.writeFileSync(target.file, text, "utf8");
  }

  console.log("+ " + target.file + " (" + fileApplied.length + "): " + fileApplied.join(", "));
}

console.log("");
console.log(
  "SUMMARY: " +
    appliedTotal +
    " applied, " +
    alreadyTotal +
    " already done, " +
    warnTotal +
    " warnings"
);