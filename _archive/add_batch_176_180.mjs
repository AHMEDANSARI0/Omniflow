// add_batch_176_180.mjs - one-file batch covering Phases 176-180.
//
//   Ph176  Manual enrollment: POST /portal/sequences/<id>/enrollments takes
//          up to 50 pasted contacts (+92 formats, bare digits, jids),
//          normalizes them, and enrolls every one that already has a chat -
//          deduped, step 1 delay applied, skipped list reported back.
//   Ph177  Cancel: DELETE /portal/sequences/<id>/enrollments/<eid> flips an
//          ACTIVE enrollment to cancelled so the poll stops delivering it.
//   Ph178  portal.ts clients + BFF (POST on the enrollments route, NEW
//          [eid] DELETE route at 8-deep).
//   Ph179  Sequences page: Add people dialog (one number per line, result
//          note) and a Cancel action on active rows in the People log.
//   Ph180  Regression coverage (test_sequence_ops, in the repo test rig).
//
// Zero AI. Touches both repos. NO restart. Vercel deploys on push.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const BACKUP_TAG = ".pre_b176180.bak";

const CP_SWAP_FROM = `    ]}), 200\n\n\ndef maybe_enroll_new_contact`;

const CP_SWAP_TO = `    ]}), 200\n\n\ndef _normalize_contact(value: Any) -> str:
    """Normalize a pasted phone number or id to the WhatsApp jid form."""
    text = str(value or "").strip()
    for char in (" ", "-", "(", ")"):
        text = text.replace(char, "")
    if not text:
        return ""
    if "@" not in text:
        text = text.lstrip("+") + "@c.us"
    return text


@bp.post("/sequences/<int:sequence_id>/enrollments")
def enroll_contacts(sequence_id: int):
    """Manually enroll pasted contacts into a sequence."""
    principal, error = _principal_or_error()
    if error:
        return error
    payload = request.get_json(silent=True) or {}
    raw = payload.get("contacts")
    if not isinstance(raw, list):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "contacts must be a list."}}), 400
    seen: list = []
    for item in raw[:50]:
        contact = _normalize_contact(item)
        if contact and contact not in seen:
            seen.append(contact)
    if not seen:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "No valid contacts."}}), 400
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (sequence_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Sequence not found."}}), 404
                cur.execute(
                    "INSERT INTO " + portal_db._q(ENROLLMENTS_TABLE) +
                    " (client_id, sequence_id, conversation_id, contact_id,"
                    " contact_name, current_step, next_at)"
                    " SELECT %s, %s, c.id, c.contact_id, c.contact_name, 0,"
                    " NOW() + make_interval(hours => COALESCE(MIN(st.delay_hours), 0))"
                    " FROM " + portal_db._q(portal_db.CONV_TABLE) + " c"
                    " LEFT JOIN " + portal_db._q(STEPS_TABLE) +
                    " st ON st.sequence_id = %s AND st.step_no = 1"
                    " WHERE c.client_id = %s AND c.contact_id = ANY(%s)"
                    " AND NOT EXISTS (SELECT 1 FROM " + portal_db._q(ENROLLMENTS_TABLE) +
                    " e WHERE e.sequence_id = %s AND e.conversation_id = c.id)"
                    " GROUP BY c.id, c.contact_id, c.contact_name"
                    " RETURNING contact_id",
                    (principal["client_id"], sequence_id, sequence_id,
                     principal["client_id"], seen, sequence_id),
                )
                enrolled_rows = portal_db.rows(cur)
                enrolled_ids = {row.get("contact_id") for row in enrolled_rows}
                skipped = [c for c in seen if c not in enrolled_ids]
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "sequence.enrolled_manually",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Enrolled " + str(len(enrolled_rows)) + " contact(s) into"
                    " sequence " + str(sequence_id) + ".",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "sequence enroll")[0]), 503
    return jsonify({"enrolled": len(enrolled_rows), "skipped": skipped}), 200


@bp.delete("/sequences/<int:sequence_id>/enrollments/<int:enrollment_id>")
def cancel_enrollment(sequence_id: int, enrollment_id: int):
    """Stop an active enrollment."""
    principal, error = _principal_or_error()
    if error:
        return error
    try:
        portal_db.ensure_tables()
        conn = portal_db._conn()
        try:
            _ensure_seq_tables(conn)
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM " + portal_db._q(SEQUENCES_TABLE) +
                    " WHERE id = %s AND client_id = %s",
                    (sequence_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Sequence not found."}}), 404
                cur.execute(
                    "UPDATE " + portal_db._q(ENROLLMENTS_TABLE) +
                    " SET status = 'cancelled'"
                    " WHERE id = %s AND sequence_id = %s AND client_id = %s"
                    " AND status = 'active' RETURNING id",
                    (enrollment_id, sequence_id, principal["client_id"]),
                )
                if not portal_db.rows(cur):
                    return jsonify({"error": {"code": "not_found",
                                              "message": "Enrollment not found or not active."}}), 404
                portal_db.log_action(
                    cur,
                    principal["client_id"],
                    "sequence.enrollment_cancelled",
                    "customer_user",
                    principal.get("user_id"),
                    None,
                    "Cancelled enrollment " + str(enrollment_id) + ".",
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as error:
        return jsonify(portal_db.portal_unavailable(error, "enrollment cancel")[0]), 503
    return jsonify({"ok": True}), 200\n\ndef maybe_enroll_new_contact`;

const PORTAL_TS_CLIENTS = `export type SequenceEnrollResult =
  | { kind: "ok"; enrolled: number; skipped: string[] }
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

export async function enrollSequenceContacts(
  accessToken: string,
  sequenceId: number,
  contacts: string[]
): Promise<SequenceEnrollResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) + "/enrollments",
      { method: "POST", body: JSON.stringify({ contacts }) }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 400) return { kind: "invalid" };
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") return { kind: "unavailable" };
  const p = payload as Record<string, unknown>;
  if (typeof p.enrolled !== "number") return { kind: "unavailable" };
  return {
    kind: "ok",
    enrolled: p.enrolled,
    skipped: Array.isArray(p.skipped)
      ? p.skipped.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export type SequenceCancelResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

export async function cancelSequenceEnrollment(
  accessToken: string,
  sequenceId: number,
  enrollmentId: number
): Promise<SequenceCancelResult> {
  let response: Response;
  try {
    response = await portalRequest(
      accessToken,
      "api/v1/portal/sequences/" + String(sequenceId) +
        "/enrollments/" + String(enrollmentId),
      { method: "DELETE" }
    );
  } catch (error) {
    assertNotAuthError(error);
    return { kind: "unavailable" };
  }
  if (response.status === 404) return { kind: "not_found" };
  if (response.status === 401) throw new ControlPlaneRequestError(401, "unauthorized");
  if (!response.ok) return { kind: "unavailable" };
  return { kind: "ok" };
}

`;

const ENROLL_ROUTE_FULL = `import {
  enrollSequenceContacts,
  listSequenceEnrollments,
  requirePortalAccessToken,
} from "../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../lib/omniflow/control-plane";


export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await params;
  const sequenceId = Number.parseInt(id, 10);
  if (!Number.isFinite(sequenceId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid sequence id." } },
      400
    );
  }

  try {
    const enrollments = await listSequenceEnrollments(accessToken, sequenceId);
    if (enrollments === null) {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return new Response(JSON.stringify({ enrollments }), {
      status: 200,
      headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
    });
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id } = await params;
  const sequenceId = Number.parseInt(id, 10);
  if (!Number.isFinite(sequenceId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid sequence id." } },
      400
    );
  }

  let contacts: unknown = null;
  try {
    const payload: unknown = await request.json();
    if (payload !== null && typeof payload === "object") {
      contacts = (payload as Record<string, unknown>).contacts;
    }
  } catch {
    contacts = null;
  }
  if (!Array.isArray(contacts)) {
    return safeJson(
      { error: { code: "bad_request", message: "contacts must be a list." } },
      400
    );
  }
  const cleaned = contacts
    .filter((item): item is string => typeof item === "string")
    .slice(0, 50);
  if (cleaned.length === 0) {
    return safeJson(
      { error: { code: "bad_request", message: "No valid contacts." } },
      400
    );
  }

  try {
    const result = await enrollSequenceContacts(accessToken, sequenceId, cleaned);
    if (result.kind === "invalid") {
      return safeJson(
        { error: { code: "bad_request", message: "No valid contacts." } },
        400
      );
    }
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Sequence not found." } },
        404
      );
    }
    if (result.kind !== "ok") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return new Response(
      JSON.stringify({ enrolled: result.enrolled, skipped: result.skipped }),
      { status: 200, headers: { ...noStoreHeaders(), "Content-Type": "application/json" } }
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

const CANCEL_ROUTE_FULL = `import {
  cancelSequenceEnrollment,
  requirePortalAccessToken,
} from "../../../../../../../../lib/omniflow/portal";
import {
  noStoreHeaders,
  safeJson,
} from "../../../../../../../../lib/omniflow/request-security";
import { ControlPlaneRequestError } from "../../../../../../../../lib/omniflow/control-plane";


export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; eid: string }> }
) {
  const accessToken = await requirePortalAccessToken();
  if (!accessToken) {
    return safeJson(
      { error: { code: "unauthorized", message: "Sign in required." } },
      401
    );
  }

  const { id, eid } = await params;
  const sequenceId = Number.parseInt(id, 10);
  const enrollmentId = Number.parseInt(eid, 10);
  if (!Number.isFinite(sequenceId) || !Number.isFinite(enrollmentId)) {
    return safeJson(
      { error: { code: "bad_request", message: "Invalid id." } },
      400
    );
  }

  try {
    const result = await cancelSequenceEnrollment(
      accessToken,
      sequenceId,
      enrollmentId
    );
    if (result.kind === "not_found") {
      return safeJson(
        { error: { code: "not_found", message: "Enrollment not found." } },
        404
      );
    }
    if (result.kind !== "ok") {
      return safeJson(
        { error: { code: "portal_unavailable", message: "Try again shortly." } },
        503
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...noStoreHeaders(), "Content-Type": "application/json" },
    });
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

const PAGE_FULL = `"use client";

import { useCallback, useEffect, useState } from "react";

interface Step {
  step_no: number;
  delay_hours: number;
  body: string;
}

interface Sequence {
  id: number;
  name: string;
  enabled: boolean;
  steps: Step[];
  activeEnrollments: number;
}

interface DraftStep {
  delay_hours: number;
  body: string;
}

export default function SequencesPage() {
  const [sequences, setSequences] = useState<Sequence[] | null>(null);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<DraftStep[]>([
    { delay_hours: 0, body: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteTone, setNoteTone] = useState("neutral");
  const [openLog, setOpenLog] = useState<number | null>(null);
  const [enrollments, setEnrollments] = useState<
    { id: number; contact_name: string | null; current_step: number; status: string }[]
  >([]);
  const [addOpenFor, setAddOpenFor] = useState<number | null>(null);
  const [addDraft, setAddDraft] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addNote, setAddNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/omniflow/portal/sequences", {
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (payload !== null && typeof payload === "object") {
        const list = (payload as { sequences?: Sequence[] }).sequences;
        setSequences(Array.isArray(list) ? list : []);
      }
    } catch {
      setSequences([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addStep = () => {
    setDraft((current) =>
      current.length < 5
        ? [...current, { delay_hours: 24, body: "" }]
        : current
    );
  };

  const patchStep = (index: number, changes: Partial<DraftStep>) => {
    setDraft((current) =>
      current.map((step, i) => (i === index ? { ...step, ...changes } : step))
    );
  };

  const create = useCallback(async () => {
    if (!name.trim() || draft.some((step) => !step.body.trim())) {
      setNoteTone("amber");
      setNote("Give the series a name and fill every step's message.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/omniflow/portal/sequences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, steps: draft }),
      });
      if (response.ok) {
        setNoteTone("emerald");
        setNote("Series created. Toggle it on to enroll new contacts.");
        setName("");
        setDraft([{ delay_hours: 0, body: "" }]);
        void load();
        return;
      }
      setNoteTone("amber");
      setNote("Could not create. Check steps (1-5, 0-168h each).");
    } catch {
      setNoteTone("amber");
      setNote("Could not create. Try again.");
    } finally {
      setBusy(false);
    }
  }, [name, draft, load]);

  const setEnabled = useCallback(
    async (row: Sequence, enabled: boolean) => {
      setBusy(true);
      try {
        await fetch("/api/omniflow/portal/sequences/" + String(row.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        });
        void load();
      } catch {
        void load();
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const remove = useCallback(
    async (row: Sequence) => {
      setBusy(true);
      try {
        await fetch("/api/omniflow/portal/sequences/" + String(row.id), {
          method: "DELETE",
        });
        void load();
      } catch {
        void load();
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const showLog = useCallback(
    async (id: number) => {
      if (openLog === id) {
        setOpenLog(null);
        return;
      }
      setOpenLog(id);
      setEnrollments([]);
      try {
        const response = await fetch(
          "/api/omniflow/portal/sequences/" + String(id) + "/enrollments",
          { cache: "no-store" }
        );
        const payload: unknown = await response.json().catch(() => null);
        if (payload !== null && typeof payload === "object") {
          const list = (payload as { enrollments?: typeof enrollments }).enrollments;
          setEnrollments(Array.isArray(list) ? list : []);
        }
      } catch {
        setEnrollments([]);
      }
    },
    [openLog]
  );

  const openAdd = useCallback((id: number) => {
    setAddOpenFor(id);
    setAddDraft("");
    setAddNote(null);
  }, []);

  const submitAdd = useCallback(
    async (id: number) => {
      const contacts = addDraft
        .split(/[,;\\n]+/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (addBusy || contacts.length === 0) return;
      setAddBusy(true);
      setAddNote(null);
      try {
        const response = await fetch(
          "/api/omniflow/portal/sequences/" + String(id) + "/enrollments",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contacts }),
          }
        );
        const payload = (await response.json().catch(() => null)) as {
          enrolled?: number;
          skipped?: string[];
        } | null;
        if (response.ok && payload && typeof payload.enrolled === "number") {
          const skipped = Array.isArray(payload.skipped) ? payload.skipped.length : 0;
          setAddNote(
            "Enrolled " + String(payload.enrolled) +
              (skipped > 0 ? " \\u00b7 " + String(skipped) + " skipped (no chat yet)" : "")
          );
          setAddDraft("");
          void load();
        } else {
          setAddNote("Could not add people. Try again.");
        }
      } catch {
        setAddNote("Could not add people. Try again.");
      } finally {
        setAddBusy(false);
      }
    },
    [addBusy, addDraft, load]
  );

  const cancelEnrollment = useCallback(
    async (sequenceId: number, enrollmentId: number) => {
      try {
        await fetch(
          "/api/omniflow/portal/sequences/" + String(sequenceId) +
            "/enrollments/" + String(enrollmentId),
          { method: "DELETE" }
        );
      } catch {
        // Transient network issue — reopening the log refreshes it.
      }
      void showLog(sequenceId);
    },
    [showLog]
  );

  return (
    <main className="min-h-screen bg-[#07111f] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400/70">
            Workspace
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Sequences</h1>
          <p className="mt-1.5 text-sm text-slate-400">
            A multi-message series that new contacts receive automatically,
            step by step. Great for welcome flows and first-order care.
          </p>
        </div>

        <div className="mb-6 rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4 sm:p-5">
          <h2 className="text-sm font-semibold text-white">New series</h2>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Series name, e.g. Welcome flow"
            className="mt-3 w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
          />
          <div className="mt-3 space-y-2">
            {draft.map((step, index) => (
              <div
                key={index}
                className="rounded-xl border border-white/[0.06] bg-white/[0.01] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] uppercase tracking-wider text-slate-500">
                    Step {index + 1}
                    {index === 0
                      ? " \\u00b7 sends after this many hours"
                      : " \\u00b7 waits this many hours"}
                  </p>
                  {draft.length > 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((current) => current.filter((_, i) => i !== index))
                      }
                      className="text-[11px] text-slate-500 transition hover:text-rose-300"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={168}
                    value={step.delay_hours}
                    onChange={(event) =>
                      patchStep(index, {
                        delay_hours: Math.max(
                          0,
                          Math.min(168, Number(event.target.value) || 0)
                        ),
                      })
                    }
                    className="w-20 shrink-0 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-sm text-white outline-none focus:border-cyan-400/40"
                  />
                  <span className="shrink-0 text-xs text-slate-500">hours</span>
                </div>
                <textarea
                  value={step.body}
                  onChange={(event) => patchStep(index, { body: event.target.value })}
                  rows={2}
                  maxLength={1000}
                  placeholder={"Use {name} and it becomes each customer's first name."}
                  className="mt-2 w-full rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-sm text-white placeholder:text-slate-600 outline-none focus:border-cyan-400/40"
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {draft.length < 5 ? (
              <button
                type="button"
                onClick={addStep}
                className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
              >
                + Add step
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              className="rounded-xl bg-cyan-400/15 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-400/25 disabled:opacity-50"
            >
              {busy ? "Working\\u2026" : "Create series"}
            </button>
            {note ? (
              <p
                className={
                  "text-xs " +
                  (noteTone === "emerald" ? "text-emerald-300" : "text-amber-300")
                }
              >
                {note}
              </p>
            ) : null}
          </div>
        </div>

        {sequences === null ? (
          <p className="text-sm text-slate-500">Loading\\u2026</p>
        ) : sequences.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] px-5 py-8 text-center">
            <p className="text-sm text-slate-400">No series yet.</p>
            <p className="mt-1 text-xs text-slate-600">
              Create one above; every brand-new contact will walk through it.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {sequences.map((row) => (
              <li
                key={row.id}
                className="rounded-2xl border border-white/[0.06] bg-white/[0.015] p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-200">{row.name}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {row.steps.length} step{row.steps.length === 1 ? "" : "s"} \\u00b7{" "}
                      {row.activeEnrollments} active
                      {row.enabled ? " \\u00b7 enrolling" : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void setEnabled(row, !row.enabled)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      {row.enabled ? "Turn off" : "Turn on"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void showLog(row.id)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      {openLog === row.id ? "Hide people" : "People"}
                    </button>
                    <button
                      type="button"
                      onClick={() => openAdd(row.id)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                    >
                      Add people
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(row)}
                      className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:border-rose-400/40 hover:text-rose-300"
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {openLog === row.id ? (
                  <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3">
                    {enrollments.length === 0 ? (
                      <p className="text-xs text-slate-500">No enrollments yet.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {enrollments.map((enrollment) => (
                          <li
                            key={enrollment.id}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="truncate text-slate-300">
                              {enrollment.contact_name || "Customer"}
                            </span>
                            <span
                              className={
                                enrollment.status === "completed"
                                  ? "text-emerald-300"
                                  : "text-amber-300"
                              }
                            >
                              {enrollment.status === "completed"
                                ? "completed"
                                : "step " + String(enrollment.current_step + 1) + " pending"}
                            </span>
                            {enrollment.status === "active" ? (
                              <button
                                type="button"
                                onClick={() => void cancelEnrollment(row.id, enrollment.id)}
                                className="text-[11px] text-slate-500 transition hover:text-rose-300"
                              >
                                Cancel
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
                {addOpenFor === row.id ? (
                  <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.01] p-3">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500">
                      Add people to {row.name}
                    </p>
                    <textarea
                      value={addDraft}
                      onChange={(event) => setAddDraft(event.target.value)}
                      rows={3}
                      placeholder={"One number per line\\n+92 300 1234567"}
                      className="mt-2 w-full rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition-colors duration-300 focus:border-cyan-400/40"
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void submitAdd(row.id)}
                        disabled={addBusy || !addDraft.trim()}
                        className="rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-3 py-1.5 text-xs font-medium text-cyan-200 transition hover:bg-cyan-400/[0.14] disabled:opacity-50"
                      >
                        {addBusy ? "Adding..." : "Add to sequence"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddOpenFor(null)}
                        className="rounded-lg border border-white/[0.08] px-3 py-1.5 text-xs text-slate-300 transition hover:text-white"
                      >
                        Close
                      </button>
                      {addNote ? (
                        <span className="text-[11px] text-slate-400">{addNote}</span>
                      ) : null}
                    </div>
                    <p className="mt-2 text-[10px] text-slate-600">
                      Only customers who already have a chat are added. Everyone keeps
                      their own step position.
                    </p>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
`;


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

function writeFull(pathArg, content, marker, name) {
  if (fs.existsSync(pathArg)) {
    const text = fs.readFileSync(pathArg, "utf8").replace(/\r\n/g, "\n");
    if (text.includes(marker)) {
      alreadyTotal++;
      console.log("= " + pathArg + " (already patched)");
      return;
    }
    const backup = pathArg + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(pathArg, backup);
  } else {
    fs.mkdirSync(path.dirname(pathArg), { recursive: true });
  }
  fs.writeFileSync(pathArg, content.replace(/\r\n/g, "\n"), "utf8");
  appliedTotal++;
  console.log("+ " + pathArg + " (rewritten): " + name);
}

const CP_FILE = "OmniFlow-Control-Plane/portal_sequences.py";
if (!fs.existsSync(CP_FILE)) {
  console.log("SKIP (file not found): " + CP_FILE);
  warnTotal++;
} else {
  const original = fs.readFileSync(CP_FILE, "utf8").replace(/\r\n/g, "\n");
  if (original.includes("_normalize_contact")) {
    alreadyTotal++;
    console.log("= " + CP_FILE + " (already patched)");
  } else if (original.split(CP_SWAP_FROM).length - 1 === 1) {
    const backup = CP_FILE + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(CP_FILE, backup);
    fs.writeFileSync(CP_FILE, original.replace(CP_SWAP_FROM, CP_SWAP_TO), "utf8");
    if (!compilePython(CP_FILE)) {
      fs.copyFileSync(backup, CP_FILE);
      console.log("FAIL (compile failed, restored): " + CP_FILE);
      warnTotal++;
    } else {
      appliedTotal++;
      console.log("+ " + CP_FILE + " (1): p176-manual-enroll");
    }
  } else {
    warnTotal++;
    console.log("  ? " + CP_FILE + " :: p176-manual-enroll NOT FOUND — report this");
  }
}

const PORTAL_TS = "Omniflow/lib/omniflow/portal.ts";
if (!fs.existsSync(PORTAL_TS)) {
  console.log("SKIP (file not found): " + PORTAL_TS);
  warnTotal++;
} else {
  const original = fs.readFileSync(PORTAL_TS, "utf8").replace(/\r\n/g, "\n");
  if (original.includes("enrollSequenceContacts")) {
    alreadyTotal++;
    console.log("= " + PORTAL_TS + " (already patched)");
  } else if (original.split("export type ConversationStatusResult =").length - 1 === 1) {
    const backup = PORTAL_TS + BACKUP_TAG;
    if (!fs.existsSync(backup)) fs.copyFileSync(PORTAL_TS, backup);
    fs.writeFileSync(
      PORTAL_TS,
      original.replace(
        "export type ConversationStatusResult =",
        PORTAL_TS_CLIENTS + "export type ConversationStatusResult ="
      ),
      "utf8"
    );
    appliedTotal++;
    console.log("+ " + PORTAL_TS + " (1): p178-portal-clients");
  } else {
    warnTotal++;
    console.log("  ? " + PORTAL_TS + " :: p178-portal-clients NOT FOUND — report this");
  }
}

writeFull(
  "Omniflow/app/api/omniflow/portal/sequences/[id]/enrollments/route.ts",
  ENROLL_ROUTE_FULL,
  "export async function POST",
  "p178-bff-enroll-post"
);
writeFull(
  "Omniflow/app/api/omniflow/portal/sequences/[id]/enrollments/[eid]/route.ts",
  CANCEL_ROUTE_FULL,
  "cancelSequenceEnrollment",
  "p178-bff-cancel"
);
writeFull(
  "Omniflow/app/dashboard/(portal)/sequences/page.tsx",
  PAGE_FULL,
  "Add people",
  "p179-sequences-page"
);

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