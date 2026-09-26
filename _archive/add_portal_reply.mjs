// add_portal_reply.mjs — Portal Reply Composer (flagship).
// Portal inbox gains a reply box: POST portal API -> send_message command
// queued -> laptop bridge executes adapter.send(OutboundMessage) -> the sent
// text is ingested (direction=out) so it appears in the portal thread.
//
// Run from the bot ROOT (folder containing Omniflow/, OmniFlow-Control-Plane/,
// and src/):
//   node add_portal_reply.mjs
//
// NOTE: after this patch the WhatsApp bot must be RESTARTED so the bridge
// picks up the new send_message command branch.
//
// CRLF-tolerant, idempotent, backups: *.pre_reply.bak
// Python files are byte-compiled after patching (auto-restore on failure).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_MESSAGES_PATH =
  "Omniflow/app/api/omniflow/portal/conversations/[id]/messages/route.ts";

const BFF_MESSAGES_FILE = `import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  requirePortalAccessToken,
  sendConversationMessage,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";


interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const conversationId = Number(id);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid conversation id." } },
      400
    );
  }

  const payload = (await request.json().catch(() => null)) as {
    body?: unknown;
  } | null;
  const body = payload && typeof payload.body === "string" ? payload.body : "";
  if (!body.trim()) {
    return safeJson(
      { error: { code: "bad_request", message: "Message body is required." } },
      400
    );
  }

  try {
    const result = await sendConversationMessage(
      accessToken,
      conversationId,
      body.trim().slice(0, 4096)
    );
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Conversation not found." } },
        404
      );
    }
    if (result.kind === "ok") {
      return safeJson(
        { ok: true, queued: result.queued, command_id: result.commandId },
        200
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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
`;

const TARGETS = [
  // ---------------------------------------------------------------- backend
  {
    file: "OmniFlow-Control-Plane/portal_conversations.py",
    swaps: [
      {
        name: "import json",
        from: `import logging
from datetime import datetime, timezone
from typing import Any, Optional`,
        to: `import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional`,
      },
      {
        name: "import ensure_human_principal",
        from: `from portal_auth import PortalAuthUnavailable, authenticate_portal_request
import portal_db`,
        to: `from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)
import portal_db`,
      },
      {
        name: "POST messages enqueue endpoint",
        from: `    return jsonify({"conversation": _conversation_public(updated[0])}), 200`,
        to: `    return jsonify({"conversation": _conversation_public(updated[0])}), 200


@bp.post("/conversations/<int:conversation_id>/messages")
def enqueue_conversation_message(conversation_id: int):
    principal, error = _principal_or_error()
    if error:
        return error

    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden

    payload = request.get_json(silent=True) or {}
    body = payload.get("body")
    if not isinstance(body, str) or not body.strip():
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message body is required."}}), 400
    body = body.strip()
    if len(body) > 4096:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Message must be under 4096 characters."}}), 400

    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, contact_id, contact_name FROM "
                    + portal_db._q(portal_db.CONV_TABLE) +
                    " WHERE id = %s AND client_id = %s LIMIT 1",
                    (conversation_id, principal["client_id"]),
                )
                found = portal_db.rows(cur)
                if not found:
                    # Other tenant's (or unknown) conversation -> plain 404.
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Conversation not found."}}), 404
                contact_id = str(found[0].get("contact_id") or "").strip()
                if not contact_id:
                    return jsonify({"error": {"code": "bad_request",
                                              "message": "This conversation has no deliverable contact."}}), 400
                command_payload = {
                    "external_user_id": contact_id,
                    "body": body,
                    "conversation_id": conversation_id,
                }
                display_name = found[0].get("contact_name")
                if display_name:
                    command_payload["target_display_name"] = display_name
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.CMD_TABLE) +
                    " (client_id, channel, action, payload, status, requested_by,"
                    " created_at, updated_at) "
                    "VALUES (%s, 'whatsapp', 'send_message', CAST(%s AS JSONB),"
                    " 'pending', %s, NOW(), NOW()) "
                    "RETURNING id",
                    (principal["client_id"], json.dumps(command_payload),
                     principal["user_id"]),
                )
                inserted = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "portal message enqueue")[0]), 503

    logger.info(
        "portal send_message queued id=%s conversation=%s client=%s",
        inserted[0].get("id") if inserted else "?",
        conversation_id,
        principal["client_id"],
    )
    return jsonify({"ok": True, "queued": True,
                    "command_id": inserted[0].get("id") if inserted else None}), 200`,
      },
    ],
  },

  // ---------------------------------------------------------- laptop bridge
  {
    file: "src/control_plane_bridge.py",
    swaps: [
      {
        name: "send_message command branch",
        from: `                elif action == "restart":
                    adapter.stop()
                    adapter.start()
                    self.report_status("connected")

                    note = "Session restarted."

                else:`,
        to: `                elif action == "restart":
                    adapter.stop()
                    adapter.start()
                    self.report_status("connected")

                    note = "Session restarted."

                elif action == "send_message":
                    try:
                        from channels.contracts import OutboundMessage
                    except ImportError:
                        from src.channels.contracts import OutboundMessage

                    command_payload = command.get("payload") or {}
                    if isinstance(command_payload, str):
                        try:
                            command_payload = json.loads(command_payload)
                        except Exception:
                            command_payload = {}
                    target_user = str(
                        command_payload.get("external_user_id") or ""
                    ).strip()
                    body_text = str(command_payload.get("body") or "").strip()
                    display_name = command_payload.get("target_display_name")

                    if not target_user or not body_text:
                        ok = False
                        note = (
                            "send_message payload requires external_user_id "
                            "and body."
                        )
                    else:
                        account_id = getattr(
                            getattr(adapter, "account", None), "id", 0
                        )
                        send_result = adapter.send(
                            OutboundMessage(
                                channel_account_id=int(account_id or 0),
                                external_user_id=target_user,
                                content=body_text,
                                message_type="text",
                                metadata=(
                                    {"target_display_name": display_name}
                                    if display_name
                                    else {}
                                ),
                            )
                        )
                        if send_result.success:
                            self.ingest_message(
                                external_user_id=target_user,
                                body=body_text,
                                direction="out",
                            )
                            note = "Message sent."
                        else:
                            ok = False
                            note = "Send failed: " + str(
                                send_result.error or "unknown error"
                            )

                else:`,
      },
    ],
  },

  // ---------------------------------------------------------------- website
  {
    file: "Omniflow/lib/omniflow/portal.ts",
    swaps: [
      {
        name: "sendConversationMessage helper",
        from: `  if (!conversation) return { kind: "unavailable" };
  return { kind: "ok", conversation };
}`,
        to: `  if (!conversation) return { kind: "unavailable" };
  return { kind: "ok", conversation };
}

export type ConversationSendResult =
  | { kind: "ok"; queued: boolean; commandId: number | null }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function sendConversationMessage(
  accessToken: string,
  conversationId: number,
  body: string
): Promise<ConversationSendResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/conversations/" +
        encodeURIComponent(String(conversationId)) +
        "/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  return {
    kind: "ok",
    queued: p.queued === true,
    commandId: typeof p.command_id === "number" ? p.command_id : null,
  };
}`,
      },
    ],
  },
  {
    file: "Omniflow/app/dashboard/(portal)/conversations/[id]/page.tsx",
    swaps: [
      {
        name: "composer states",
        from: `  const [statusBusy, setStatusBusy] = useState(false);`,
        to: `  const [statusBusy, setStatusBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);`,
      },
      {
        name: "sendReply handler",
        from: `  const title = conversation?.contactName || conversation?.contactId || "Conversation";`,
        to: `  async function sendReply() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const response = await fetch(
        \`/api/omniflow/portal/conversations/\${encodeURIComponent(id)}/messages\`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ body }),
        }
      );
      if (response.ok) {
        setDraft("");
        void refresh();
      }
    } catch {
      // Transient network issue — the reply can be retried.
    } finally {
      if (mounted.current) setSending(false);
    }
  }

  const title = conversation?.contactName || conversation?.contactId || "Conversation";`,
      },
      {
        name: "composer UI",
        from: `      )}
    </div>
  );
}`,
        to: `      )}

      {!expired && !notFound && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void sendReply();
          }}
          className="mt-6 flex items-end gap-3"
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void sendReply();
              }
            }}
            rows={2}
            maxLength={4096}
            placeholder="Reply as a human agent — Enter to send, Shift+Enter for a new line"
            className="flex-1 resize-none rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-sm text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <button
            type="submit"
            disabled={sending || !draft.trim()}
            className="shrink-0 rounded-xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-[#07111f] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </form>
      )}
    </div>
  );
}`,
      },
    ],
  },
];

let appliedTotal = 0;
let alreadyTotal = 0;
let warnTotal = 0;

function compilePython(path) {
  for (const py of ["python", "python3"]) {
    try {
      execFileSync(py, ["-m", "py_compile", path], { stdio: "pipe" });
      return true;
    } catch {
      /* try next interpreter */
    }
  }
  return false;
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

  const backup = target.file + ".pre_reply.bak";
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

// New BFF route file (written only when missing).
if (fs.existsSync(BFF_MESSAGES_PATH)) {
  console.log("= " + BFF_MESSAGES_PATH + " (already present)");
} else {
  fs.mkdirSync(path.dirname(BFF_MESSAGES_PATH), { recursive: true });
  fs.writeFileSync(BFF_MESSAGES_PATH, BFF_MESSAGES_FILE.replace(/\r\n/g, "\n"), "utf8");
  appliedTotal++;
  console.log("+ " + BFF_MESSAGES_PATH);
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