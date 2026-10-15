// add_customer_notes.mjs — Phase 24: Customer Notes (contact-level CRM).
//
// Zero AI, no bridge changes -> NO bot restart. Conversation notes already
// exist (internal, per chat); this adds the missing CRM layer: notes that
// belong to the CUSTOMER (contact), visible from the Customers page no matter
// which chat they came from. "Ali always pays on Friday", "wholesale buyer,
// quote 10% off" — context the whole team should keep seeing.
//
//   - CP: new lazy-DDL table portal_customer_notes (client_id + contact_id
//     scoped, 1000-char notes, author from the session). GET/POST
//     /portal/customers/notes + DELETE /portal/customers/notes/<id>
//     (human-only writes, audited customer.note_added / customer.note_deleted).
//   - Website: portal.ts listCustomerNotes/addCustomerNote/deleteCustomerNote;
//     BFF customers/notes/route.ts (GET+POST) and customers/notes/[id]/route.ts
//     (DELETE). Customers page: each row gets a Notes column — toggling opens
//     an inline panel (list + add + delete) under the row; the row keeps
//     linking to the customer's chats.
//
// Run from the bot ROOT (folder containing Omniflow/ and OmniFlow-Control-Plane/):
//   node add_customer_notes.mjs
//
// Requires Phase 23 (add_autoassign_chats.mjs) to be applied first.
//
// CRLF-tolerant, idempotent, backups: *.pre_cnotes.bak
// Expected first run: 10 applied, 0 warnings (8 swaps + 2 new files).
// Expected rerun:     0 applied, 8 already done, 0 warnings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BFF_NOTES_PATH = "Omniflow/app/api/omniflow/portal/customers/notes/route.ts";
const BFF_NOTE_ID_PATH = "Omniflow/app/api/omniflow/portal/customers/notes/[id]/route.ts";

const CP_DB_PATH = "OmniFlow-Control-Plane/portal_db.py";
const CP_CONV_PATH = "OmniFlow-Control-Plane/portal_conversations.py";
const LIB_PORTAL_PATH = "Omniflow/lib/omniflow/portal.ts";
const PAGE_PATH = "Omniflow/app/dashboard/(portal)/customers/page.tsx";

// --------------------------------------------------------------------------
// Control Plane: portal_db.py (const + lazy DDL)
// --------------------------------------------------------------------------

const DB_CONST_FROM = `AUTOMATION_SETTINGS_TABLE = os.environ.get(
    "OF_AUTOMSETTINGS_TABLE", "portal_automation_settings"
)`;

const DB_CONST_TO = `AUTOMATION_SETTINGS_TABLE = os.environ.get(
    "OF_AUTOMSETTINGS_TABLE", "portal_automation_settings"
)
CUSTOMER_NOTES_TABLE = os.environ.get("OF_CUSTNOTES_TABLE", "portal_customer_notes")`;

const DB_DDL_FROM = `ALTER TABLE portal_automation_settings
  ADD COLUMN IF NOT EXISTS assign_enabled BOOLEAN NOT NULL DEFAULT FALSE;`;

const DB_DDL_TO = `ALTER TABLE portal_automation_settings
  ADD COLUMN IF NOT EXISTS assign_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS portal_customer_notes (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  contact_id TEXT NOT NULL,
  body TEXT NOT NULL,
  author_email TEXT,
  author_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_customer_notes
  ON portal_customer_notes (client_id, contact_id, id DESC);`;

// --------------------------------------------------------------------------
// Control Plane: portal_conversations.py (endpoints, tail append)
// --------------------------------------------------------------------------

const CP_TAIL_FROM = `            "Auto-assigned to " + email + " (least loaded).",
        )
    return email`;

const CP_TAIL_TO = `                "Auto-assigned to " + email + " (least loaded).",
        )
    return email


# ---------------------------------------------------------------------------
# Customer notes (contact-level CRM notes)
# ---------------------------------------------------------------------------

def _customer_note_public(row: Any) -> dict:
    return {
        "id": row.get("id"),
        "body": row.get("body"),
        "author_email": row.get("author_email"),
        "author_name": row.get("author_name"),
        "created_at": _iso(row.get("created_at")),
    }


@bp.get("/customers/notes")
def list_customer_notes():
    """Latest 50 notes for one contact, newest first."""
    principal, error = _principal_or_error()
    if error:
        return error
    contact_id = (request.args.get("contact_id") or "").strip()[:120]
    if not contact_id:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact_id is required."}}), 400
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT id, body, author_email, author_name, created_at"
                    " FROM " + portal_db._q(portal_db.CUSTOMER_NOTES_TABLE) +
                    " WHERE client_id = %s AND contact_id = %s"
                    " ORDER BY id DESC LIMIT 50",
                    (client_id, contact_id),
                )
                rows = portal_db.rows(cur)
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "customer notes read")[0]), 503
    return jsonify({
        "ok": True,
        "notes": [_customer_note_public(row) for row in rows],
    }), 200


@bp.post("/customers/notes")
def add_customer_note():
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden
    payload = request.get_json(silent=True) or {}
    contact_id = payload.get("contact_id")
    contact_id = contact_id.strip()[:120] if isinstance(contact_id, str) else ""
    if not contact_id:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contact_id is required."}}), 400
    body = payload.get("body")
    body = body.strip() if isinstance(body, str) else ""
    if not body:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Write the note first."}}), 400
    if len(body) > 1000:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Note must be 1000 characters or fewer."}}), 400
    author_email = str(principal.get("email") or "").strip().lower()[:120]
    author_name = str(principal.get("display_name") or "").strip()[:80]
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO " + portal_db._q(portal_db.CUSTOMER_NOTES_TABLE) +
                    " (client_id, contact_id, body, author_email, author_name)"
                    " VALUES (%s, %s, %s, %s, %s)"
                    " RETURNING id, body, author_email, author_name, created_at",
                    (client_id, contact_id, body, author_email, author_name),
                )
                rows = portal_db.rows(cur)
                note_row = rows[0] if rows else {}
                portal_db.log_action(
                    cur,
                    client_id,
                    "customer.note_added",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Customer note added for " + contact_id + ".",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "customer note add")[0]), 503
    return jsonify({"ok": True, "note": _customer_note_public(note_row)}), 200


@bp.delete("/customers/notes/<int:note_id>")
def delete_customer_note(note_id: int):
    principal, error = _principal_or_error()
    if error:
        return error
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return forbidden
    client_id = principal["client_id"]
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM " + portal_db._q(portal_db.CUSTOMER_NOTES_TABLE) +
                    " WHERE id = %s AND client_id = %s RETURNING id",
                    (note_id, client_id),
                )
                deleted = portal_db.rows(cur)
                if deleted:
                    portal_db.log_action(
                        cur,
                        client_id,
                        "customer.note_deleted",
                        "customer_user",
                        principal.get("user_id"),
                        None,
                        "Customer note deleted.",
                    )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "customer note delete")[0]), 503
    if not deleted:
        return jsonify({"error": {"code": "not_found",
                                  "message": "Note not found."}}), 404
    return jsonify({"ok": True}), 200`;

// --------------------------------------------------------------------------
// Website: lib/omniflow/portal.ts (inserted before the Growth banner)
// --------------------------------------------------------------------------

const LIB_GROWTH_BANNER = `// ---------------------------------------------------------------------------
// Growth: broadcasts, KB gap report, CSAT ratings
// ---------------------------------------------------------------------------`;

const LIB_NOTES_BLOCK = `// ---------------------------------------------------------------------------
// Customers: contact-level notes (CRM)
// ---------------------------------------------------------------------------

export interface CustomerNote {
  id: number;
  body: string;
  authorEmail: string;
  authorName: string;
  createdAt: string | null;
}

function normalizeCustomerNote(value: unknown): CustomerNote | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const id = typeof p.id === "number" ? p.id : null;
  const body = typeof p.body === "string" ? p.body : "";
  if (id === null || !body) return null;
  return {
    id,
    body,
    authorEmail: typeof p.author_email === "string" ? p.author_email : "",
    authorName: typeof p.author_name === "string" ? p.author_name : "",
    createdAt: typeof p.created_at === "string" ? p.created_at : null,
  };
}

export async function listCustomerNotes(
  accessToken: string,
  contactId: string
): Promise<CustomerNote[] | null> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/customers/notes?contact_id=" +
        encodeURIComponent(contactId.slice(0, 120))
    );
  } catch (error) {
    assertNotAuthError(error);
    return null;
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return null;
  const rawNotes = (payload as Record<string, unknown>).notes;
  if (!Array.isArray(rawNotes)) return [];
  const notes: CustomerNote[] = [];
  for (const raw of rawNotes) {
    const note = normalizeCustomerNote(raw);
    if (note) notes.push(note);
  }
  return notes;
}

export type CustomerNoteAddResult =
  | { kind: "ok"; note: CustomerNote }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function addCustomerNote(
  accessToken: string,
  contactId: string,
  body: string
): Promise<CustomerNoteAddResult> {
  let response: Response;
  try {
    response = await portalRequest(accessToken, "api/v1/portal/customers/notes", {
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
  if (!response.ok) return { kind: "unavailable" };

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const note = normalizeCustomerNote((payload as Record<string, unknown>).note);
  if (!note) return { kind: "unavailable" };
  return { kind: "ok", note };
}

export type CustomerNoteDeleteResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function deleteCustomerNote(
  accessToken: string,
  noteId: number
): Promise<CustomerNoteDeleteResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/customers/notes/" + encodeURIComponent(String(noteId)),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }

  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (response.status === 404) return { kind: "not_found" };
  return response.ok ? { kind: "ok" } : { kind: "unavailable" };
}

` + LIB_GROWTH_BANNER;

// --------------------------------------------------------------------------
// Website: BFF passthrough (new files)
// --------------------------------------------------------------------------

const BFF_NOTES_FILE = `import { ControlPlaneRequestError } from "../../../../../../lib/omniflow/control-plane";
import {
  addCustomerNote,
  listCustomerNotes,
  requirePortalAccessToken,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";

export async function GET(request: Request) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const url = new URL(request.url);
  const contactId = (url.searchParams.get("contact_id") || "").trim().slice(0, 120);
  if (!contactId) {
    return safeJson(
      { error: { code: "bad_request", message: "contact_id is required." } },
      400
    );
  }

  try {
    const notes = await listCustomerNotes(accessToken, contactId);
    if (notes === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return safeJson({ ok: true, notes }, 200);
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
  const noteBody = typeof body.body === "string" ? body.body.trim().slice(0, 1000) : "";
  if (!contactId || !noteBody) {
    return safeJson(
      { error: { code: "bad_request", message: "contact_id and note text are required." } },
      400
    );
  }

  try {
    const result = await addCustomerNote(accessToken, contactId, noteBody);
    if (result.kind === "ok") {
      return safeJson({ ok: true, note: result.note }, 200);
    }
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: "Note must be 1-1000 characters." } },
        400
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

const BFF_NOTE_ID_FILE = `import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";
import {
  deleteCustomerNote,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../../lib/omniflow/request-security";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await context.params;
  const noteId = Number.parseInt(id, 10);
  if (!Number.isFinite(noteId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid note id." } },
      400
    );
  }

  try {
    const result = await deleteCustomerNote(accessToken, noteId);
    if (result.kind === "ok") {
      return safeJson({ ok: true }, 200);
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Note not found." } },
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

// --------------------------------------------------------------------------
// Website: Customers page (4 swaps)
// --------------------------------------------------------------------------

const PAGE_STATE_FROM = `  const [search, setSearch] = useState("");`;

const PAGE_STATE_TO = `  const [search, setSearch] = useState("");
  const [notesOpenFor, setNotesOpenFor] = useState<string | null>(null);
  const [notesByContact, setNotesByContact] = useState<
    Record<
      string,
      { id: number; body: string; authorEmail: string; authorName: string; createdAt: string | null }[]
    >
  >({});
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);`;

const PAGE_HELPERS_FROM = `  function onSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      searchRef.current = value.trim();
      void refresh();
    }, 300);
  }`;

const PAGE_HELPERS_TO = `  function onSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      searchRef.current = value.trim();
      void refresh();
    }, 300);
  }

  async function toggleNotes(contactId: string) {
    if (notesOpenFor === contactId) {
      setNotesOpenFor(null);
      return;
    }
    setNotesOpenFor(contactId);
    setNoteError(null);
    if (notesByContact[contactId] !== undefined) return;
    try {
      const response = await fetch(
        "/api/omniflow/portal/customers/notes?contact_id=" +
          encodeURIComponent(contactId),
        { credentials: "same-origin", cache: "no-store" }
      );
      const payload = (await response.json().catch(() => null)) as {
        notes?: {
          id?: number;
          body?: string;
          author_email?: string;
          author_name?: string;
          created_at?: string | null;
        }[];
      } | null;
      const notes = (payload?.notes || [])
        .map((note) => ({
          id: typeof note.id === "number" ? note.id : 0,
          body: typeof note.body === "string" ? note.body : "",
          authorEmail: typeof note.author_email === "string" ? note.author_email : "",
          authorName: typeof note.author_name === "string" ? note.author_name : "",
          createdAt: typeof note.created_at === "string" ? note.created_at : null,
        }))
        .filter((note) => note.id > 0 && note.body);
      setNotesByContact((prev) => ({ ...prev, [contactId]: notes }));
    } catch {
      setNotesByContact((prev) => ({ ...prev, [contactId]: [] }));
    }
  }

  async function addNote(contactId: string) {
    const body = noteDraft.trim();
    if (noteBusy || !body) return;
    setNoteBusy(true);
    setNoteError(null);
    try {
      const response = await fetch("/api/omniflow/portal/customers/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ contact_id: contactId, body }),
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        note?: {
          id?: number;
          body?: string;
          author_email?: string;
          author_name?: string;
          created_at?: string | null;
        };
        error?: { message?: string };
      } | null;
      if (
        response.ok &&
        payload?.ok &&
        typeof payload.note?.id === "number" &&
        typeof payload.note?.body === "string"
      ) {
        const note = {
          id: payload.note.id,
          body: payload.note.body,
          authorEmail:
            typeof payload.note.author_email === "string" ? payload.note.author_email : "",
          authorName:
            typeof payload.note.author_name === "string" ? payload.note.author_name : "",
          createdAt:
            typeof payload.note.created_at === "string" ? payload.note.created_at : null,
        };
        setNotesByContact((prev) => ({
          ...prev,
          [contactId]: [note, ...(prev[contactId] || [])],
        }));
        setNoteDraft("");
      } else {
        setNoteError(payload?.error?.message || "Could not save the note. Try again shortly.");
      }
    } catch {
      setNoteError("Network error — try again.");
    } finally {
      setNoteBusy(false);
    }
  }

  async function removeNote(contactId: string, noteId: number) {
    if (noteBusy) return;
    setNoteBusy(true);
    setNoteError(null);
    try {
      const response = await fetch(
        "/api/omniflow/portal/customers/notes/" + String(noteId),
        { method: "DELETE", credentials: "same-origin" }
      );
      if (response.ok) {
        setNotesByContact((prev) => ({
          ...prev,
          [contactId]: (prev[contactId] || []).filter((note) => note.id !== noteId),
        }));
      } else {
        setNoteError("Could not delete the note. Try again shortly.");
      }
    } catch {
      setNoteError("Network error — try again.");
    } finally {
      setNoteBusy(false);
    }
  }`;

const PAGE_ROW_OPEN_FROM = `            <li key={customer.contactId}>
              <Link
                href={
                  "/dashboard/conversations?q=" +
                  encodeURIComponent(customer.contactId)
                }
                className="block rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 transition-colors duration-300 hover:border-white/[0.12] hover:bg-white/[0.03]"
              >`;

const PAGE_ROW_OPEN_TO = `            <li
              key={customer.contactId}
              className="overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.015]"
            >
              <div className="flex items-stretch">
              <Link
                href={
                  "/dashboard/conversations?q=" +
                  encodeURIComponent(customer.contactId)
                }
                className="min-w-0 flex-1 p-4 transition-colors duration-300 hover:bg-white/[0.03]"
              >`;

const PAGE_ROW_CLOSE_FROM = `              </Link>
            </li>
          ))}
        </ul>`;

const PAGE_ROW_CLOSE_TO = `              </Link>
                <div className="flex w-14 shrink-0 items-stretch border-l border-white/[0.05] sm:w-16">
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
                </div>
              </div>
              {notesOpenFor === customer.contactId && (
                <div className="border-t border-white/[0.05] p-4">
                  {notesByContact[customer.contactId] === undefined ? (
                    <p className="text-[11px] text-slate-600">Loading notes…</p>
                  ) : (notesByContact[customer.contactId] || []).length === 0 ? (
                    <p className="text-[11px] text-slate-600">
                      No notes yet — add context your team should always see
                      for this customer.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {(notesByContact[customer.contactId] || []).map((note) => (
                        <li
                          key={"note-" + String(note.id)}
                          className="rounded-xl border border-white/[0.05] bg-white/[0.01] px-3 py-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="min-w-0 whitespace-pre-wrap break-words text-xs text-slate-300">
                              {note.body}
                            </p>
                            <button
                              type="button"
                              onClick={() => void removeNote(customer.contactId, note.id)}
                              className="shrink-0 text-[10px] text-slate-600 transition-colors duration-300 hover:text-red-300"
                            >
                              Delete
                            </button>
                          </div>
                          <p className="mt-1 text-[10px] text-slate-600">
                            {note.authorName || note.authorEmail || "Team"}
                            {note.createdAt ? " · " + formatWhen(note.createdAt) : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <input
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                      maxLength={1000}
                      placeholder="Add a note about this customer…"
                      className="flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-white placeholder-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                    />
                    <button
                      type="button"
                      onClick={() => void addNote(customer.contactId)}
                      disabled={noteBusy || !noteDraft.trim()}
                      className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-2 text-xs font-medium text-cyan-200 transition-colors duration-300 hover:bg-cyan-400/[0.14] disabled:opacity-50"
                    >
                      {noteBusy ? "Saving…" : "Add note"}
                    </button>
                  </div>
                  {noteError && (
                    <p className="mt-2 text-[11px] text-red-300">{noteError}</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>`;

// --------------------------------------------------------------------------
// Driver
// --------------------------------------------------------------------------

const TARGETS = [
  {
    file: CP_DB_PATH,
    swaps: [
      { name: "db-const", from: DB_CONST_FROM, to: DB_CONST_TO },
      { name: "db-ddl", from: DB_DDL_FROM, to: DB_DDL_TO },
    ],
  },
  {
    file: CP_CONV_PATH,
    swaps: [
      { name: "cp-notes-endpoints", from: CP_TAIL_FROM, to: CP_TAIL_TO },
    ],
  },
  {
    file: LIB_PORTAL_PATH,
    swaps: [
      { name: "lib-notes-block", from: LIB_GROWTH_BANNER, to: LIB_NOTES_BLOCK },
    ],
  },
  {
    file: PAGE_PATH,
    swaps: [
      { name: "page-state", from: PAGE_STATE_FROM, to: PAGE_STATE_TO },
      { name: "page-helpers", from: PAGE_HELPERS_FROM, to: PAGE_HELPERS_TO },
      { name: "page-row-open", from: PAGE_ROW_OPEN_FROM, to: PAGE_ROW_OPEN_TO },
      { name: "page-row-close", from: PAGE_ROW_CLOSE_FROM, to: PAGE_ROW_CLOSE_TO },
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

  const backup = target.file + ".pre_cnotes.bak";
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
const NEW_FILES = [
  [BFF_NOTES_PATH, BFF_NOTES_FILE],
  [BFF_NOTE_ID_PATH, BFF_NOTE_ID_FILE],
];
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