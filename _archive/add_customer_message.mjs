// add_customer_message.mjs - Phase 27: message a customer from the customers page.
//
// Adds POST /portal/customers/message (queues one send_message command for a
// WhatsApp contact, attributed to the signed-in user) and a Message composer
// on the customers page rows. No bridge changes, no restart.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_MESSAGE_PATH = "Omniflow/app/api/omniflow/portal/customers/message/route.ts";

const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const PAGE_PATH = "Omniflow/app/dashboard/(portal)/customers/page.tsx";

// Control Plane: portal_conversations.py

const CP_TAIL_FROM = `    if not deleted:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Note not found."}}), 404
    return jsonify({"ok": True}), 200`;

const CP_TAIL_TO = `    if not deleted:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Note not found."}}), 404
    return jsonify({"ok": True}), 200


@bp.post("/customers/message")
def send_customer_message():
    """Queue one WhatsApp message to a contact from the customers page."""
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden
    payload = request.get_json(silent=True) or {}
    contact_id = payload.get("contact_id")
    contact_id = contact_id.strip()[:120] if isinstance(contact_id, str) else ""
    body = payload.get("body")
    body = body.strip() if isinstance(body, str) else ""
    if not contact_id:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact_id is required."}}), 400
    if not body:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Write the message first."}}), 400
    if len(body) > 1000:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message must be 1000 characters or fewer."}}), 400
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, contact_name FROM "
                    + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE client_id = %s AND contact_id = %s"
                    " AND channel = 'whatsapp'"
                    " ORDER BY id DESC LIMIT 1",
                    (client_id, contact_id),
                )
                rows = portal_db.rows(cur)
                if not rows:
                    return jsonify({"error": {"code": "contact_not_found",
                                              "message": "No WhatsApp chat exists for this contact."}}), 404
                display = str(rows[0].get("contact_name") or "").strip()
                message_payload = {
                    "external_user_id": contact_id,
                    "body": body[:1000],
                    "source": "manual",
                }
                if display:
                    message_payload["target_display_name"] = display
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
                    " (client_id, channel, action, payload, status, requested_by,"
                    " created_at, updated_at) "
                    "VALUES (%s, 'whatsapp', 'send_message', CAST(%s AS JSONB),"
                    " 'pending', %s, NOW(), NOW()) "
                    "RETURNING id",
                    (client_id, json.dumps(message_payload), principal.get("user_id")),
                )
                inserted = portal_db.rows(cur)
                command_id = int(inserted[0].get("id") or 0) if inserted else 0
                portal_db.log_action(
                    cur,
                    client_id,
                    "message.manual_queued",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Manual message queued for " + contact_id + ".",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "manual message")[0]), 503
    return jsonify({"ok": True, "command_id": command_id}), 200`;

// Website: lib/omniflow/portal.ts

const LIB_GROWTH_BANNER = `// ---------------------------------------------------------------------------
// Growth: broadcasts, KB gap report, CSAT ratings
// ---------------------------------------------------------------------------`;

const LIB_MESSAGE_BLOCK = `export type CustomerMessageResult =
  | { kind: "ok"; commandId: number | null }
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function sendCustomerMessage(
  accessToken: string,
  contactId: string,
  body: string
): Promise<CustomerMessageResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId.slice(0, 120), body }),
    });
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  const p =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  return {
    kind: "ok",
    commandId: typeof p.command_id === "number" ? p.command_id : null,
  };
}

` + LIB_GROWTH_BANNER;

// Website: BFF passthrough

const BFF_MESSAGE_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  sendCustomerMessage,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function POST(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    payload = null;
  }
  const body =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const contactId = typeof body.contact_id === "string" ? body.contact_id.trim().slice(0, 120) : "";
  const text = typeof body.body === "string" ? body.body.trim().slice(0, 1000) : "";
  if (!contactId || !text) {
    return safeJson(
      { error: { code: "bad_request", message: "contact_id and message text are required." } },
      400
    );
  }

  try {
    const result = await sendCustomerMessage(accessToken, contactId, text);
    if (result.kind === "ok") {
      return safeJson({ ok: true, command_id: result.commandId }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: "Message must be 1-1000 characters." } },
        400
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "contact_not_found", message: "No WhatsApp chat exists for this contact." } },
        404
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.isUnauthorized) {
      return safeJson(
        { error: { code: "unauthorized", message: "Session expired." } },
        401
      );
    }
    return safeJson(
      { error: { code: "portal_unavailable", message: "Try again shortly." } },
      503
    );
  }
}
`;

// Website: customers page

const PAGE_STATE_FROM = `  const [noteError, setNoteError] = useState<string | null>(null);`;

const PAGE_STATE_TO = `  const [noteError, setNoteError] = useState<string | null>(null);
  const [msgOpenFor, setMsgOpenFor] = useState<string | null>(null);
  const [msgDraft, setMsgDraft] = useState("");
  const [msgBusy, setMsgBusy] = useState(false);
  const [msgStatus, setMsgStatus] = useState<string | null>(null);`;

const PAGE_HELPERS_FROM = `      } else {
        setNoteError("Could not delete the note. Try again shortly.");
      }
    } catch {
      setNoteError("Network error — try again.");
    } finally {
      setNoteBusy(false);
    }
  }`;

const PAGE_HELPERS_TO = `      } else {
        setNoteError("Could not delete the note. Try again shortly.");
      }
    } catch {
      setNoteError("Network error — try again.");
    } finally {
      setNoteBusy(false);
    }
  }

  async function sendMessage(contactId: string) {
    const text = msgDraft.trim();
    if (msgBusy || !text) return;
    setMsgBusy(true);
    setMsgStatus(null);
    try {
      const response = await fetch("/api/omniflow/portal/customers/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ contact_id: contactId, body: text }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (response.ok && payload?.ok) {
        setMsgStatus("Message queued. It goes out from your connected number.");
        setMsgDraft("");
      } else {
        setMsgStatus(payload?.error?.message || "Could not send. Try again shortly.");
      }
    } catch {
      setMsgStatus("Network error, try again.");
    } finally {
      setMsgBusy(false);
    }
  }`;

const PAGE_CELL_FROM = `                <div className="flex w-14 shrink-0 items-stretch border-l border-white/[0.05] sm:w-16">
                  <button
                    type="button"
                    onClick={() => void toggleNotes(customer.contactId)}
                    className={
                      "h-full w-full text-[10px] font-semibold uppercase tracking-wider transition-colors duration-300 " +
                      (notesOpenFor === customer.contactId
                        ? "bg-cyan-400/[0.08] text-cyan-200"
                        : "text-slate-500 hover:text-white")
                    }
                  >
                    Notes
                  </button>
                </div>`;

const PAGE_CELL_TO = `                <div className="flex w-14 shrink-0 flex-col border-l border-white/[0.05] sm:w-16">
                  <button
                    type="button"
                    onClick={() => void toggleNotes(customer.contactId)}
                    className={
                      "flex-1 text-[10px] font-semibold uppercase tracking-wider transition-colors duration-300 " +
                      (notesOpenFor === customer.contactId
                        ? "bg-cyan-400/[0.08] text-cyan-200"
                        : "text-slate-500 hover:text-white")
                    }
                  >
                    Notes
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNotesOpenFor(null);
                      setMsgStatus(null);
                      setMsgOpenFor(msgOpenFor === customer.contactId ? null : customer.contactId);
                    }}
                    className={
                      "flex-1 border-t border-white/[0.05] text-[10px] font-semibold uppercase tracking-wider transition-colors duration-300 " +
                      (msgOpenFor === customer.contactId
                        ? "bg-cyan-400/[0.08] text-cyan-200"
                        : "text-slate-500 hover:text-white")
                    }
                  >
                    Message
                  </button>
                </div>`;

const PAGE_PANEL_FROM = `                  {noteError && (
                    <p className="mt-2 text-[11px] text-red-300">{noteError}</p>
                  )}
                </div>
              )}
            </li>
          ))}`;

const PAGE_PANEL_TO = `                  {noteError && (
                    <p className="mt-2 text-[11px] text-red-300">{noteError}</p>
                  )}
                </div>
              )}
              {msgOpenFor === customer.contactId && (
                <div className="border-t border-white/[0.05] p-4">
                  <textarea
                    value={msgDraft}
                    onChange={(event) => setMsgDraft(event.target.value)}
                    maxLength={1000}
                    rows={3}
                    placeholder="Type your message..."
                    className="w-full resize-none rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                  />
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[10px] text-slate-600">
                      {msgDraft.trim().length}/1000
                    </span>
                    <button
                      type="button"
                      onClick={() => void sendMessage(customer.contactId)}
                      disabled={msgBusy || !msgDraft.trim()}
                      className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
                    >
                      {msgBusy ? "Sending..." : "Send message"}
                    </button>
                  </div>
                  {msgStatus && (
                    <p className="mt-2 text-[11px] text-slate-400">{msgStatus}</p>
                  )}
                </div>
              )}
            </li>
          ))}`;

// Driver

const TARGETS = [
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-message-endpoint", from: CP_TAIL_FROM, to: CP_TAIL_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-send-message", from: LIB_GROWTH_BANNER, to: LIB_MESSAGE_BLOCK },
    ],
  },
  {
    file: PAGE_PATH,
    swaps: [
      { name: "page-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "page-helpers", from: PAGE_HELPERS_FROM, to: PAGE_HELPERS_TO },
      { name: "page-action-cell", from: PAGE_CELL_FROM, to: PAGE_CELL_TO },
      { name: "page-message-panel", from: PAGE_PANEL_FROM, to: PAGE_PANEL_TO },
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

  const backup = target.file + ".pre_cmsg.bak";
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

// New files (written only when missing).
const NEW_FILES = [[BFF_MESSAGE_PATH, BFF_MESSAGE_FILE]];
for (const [newPath, newContent] of NEW_FILES) {
  if (fs.existsSync(newPath)) {
    console.log("= " + newPath + " (already present)");
  } else {
    writeFileEnsuringDir(newPath, newContent);
    appliedTotal++;
    console.log("+ " + newPath);
  }
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