"""Customer Identity engine (MASTER-UPGRADE engine 1): one person, many
handles - WhatsApp ids, phone numbers, e-mails, Instagram/Facebook
usernames, web visitor ids - resolved deterministically, with a
confidence + source per handle, duplicate detection across the
workspace, a SAFE (reversible) merge and an audit trail.

Audit-first (what already existed and stays):

* ``portal_contact_identities`` (portal_contacts) - pairwise WhatsApp
  "links" keyed by a derived identity_key. It is the READ MODEL the
  customer profile (``linked_channels``) and agent assist still consume,
  so this engine imports its rows once per workspace (``migrate_legacy``)
  and keeps it in sync after every merge/split (``_legacy_sync``). The
  old ``POST /contacts/link`` keeps working; ``/identity/merge`` is the
  new front door.
* ``POST /customers/merge`` (portal_conversations) - the HARD merge that
  physically moves chats/stages/COD rows onto one contact id. That is a
  destructive history operation the owner chooses explicitly; identity
  linking here never moves data, so it can always be split again.

Resolution rules are data, not AI: phone numbers are normalised to E.164
digits (local ``03xx`` numbers get the workspace default country code,
WhatsApp JIDs are unwrapped), e-mails are lower-cased, usernames lose
their ``@``/URL prefix. ``resolve(cur, client_id, channel, raw)`` is the
one call the upcoming channel adapters make to map any inbound handle to
a person. Fail-soft everywhere: a missing table or a bad handle means
"no identity", never a broken request.
"""

import logging
import os
import re
from typing import Any, Dict, List, Optional, Set, Tuple

from flask import Blueprint, jsonify, request

import portal_db
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.portal-identity")

bp = Blueprint("portal_identity", __name__, url_prefix="/api/v1/portal")

IDENTITIES_TABLE = "portal_identities"
HANDLES_TABLE = "portal_identity_handles"
DISMISSALS_TABLE = "portal_identity_dismissals"
LEGACY_TABLE = "portal_contact_identities"

#: Channels a handle can live on. ``whatsapp`` handles are the
#: conversation contact ids; everything else is an alias the owner or an
#: adapter attaches.
CHANNELS: Tuple[str, ...] = (
    "whatsapp", "phone", "email", "instagram", "facebook", "tiktok", "web",
    "other")
#: Channels the owner may add by hand from the profile card.
OWNER_CHANNELS: Tuple[str, ...] = (
    "phone", "email", "instagram", "facebook", "tiktok", "web", "other")
SOURCES: Tuple[str, ...] = ("owner", "system", "legacy", "import", "adapter")
STATUS_ACTIVE, STATUS_MERGED = "active", "merged"

DEFAULT_COUNTRY_CODE = re.sub(
    r"\D", "", os.environ.get("OF_DEFAULT_COUNTRY_CODE", "92") or "92") or "92"
MAX_HANDLES = int(os.environ.get("OF_IDENTITY_HANDLES_MAX", "12") or 12)
SCAN_MAX = int(os.environ.get("OF_IDENTITY_SCAN_MAX", "3000") or 3000)
SUGGESTIONS_MAX = 100
MAX_HANDLE_CHARS = 120
MAX_NAME_CHARS = 120

CONF_EXACT = 1.0
CONF_SAME_PHONE = 0.95
CONF_SAME_NAME = 0.4

_DDL_READY = False
_MIGRATED: Set[int] = set()

_DDL = """
CREATE TABLE IF NOT EXISTS portal_identities (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  primary_contact_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  merged_into BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_identities_client
  ON portal_identities (client_id, status);
CREATE TABLE IF NOT EXISTS portal_identity_handles (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  identity_id BIGINT NOT NULL,
  channel TEXT NOT NULL,
  handle TEXT NOT NULL,
  raw_handle TEXT NOT NULL DEFAULT '',
  confidence NUMERIC(4,3) NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, channel, handle)
);
CREATE INDEX IF NOT EXISTS idx_portal_identity_handles_identity
  ON portal_identity_handles (client_id, identity_id);
CREATE TABLE IF NOT EXISTS portal_identity_dismissals (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  contact_a TEXT NOT NULL,
  contact_b TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, contact_a, contact_b)
);
CREATE TABLE IF NOT EXISTS portal_contact_identities (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  channel TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, channel, contact_id)
);
"""


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


# ---------------------------------------------------------------------------
# Normalisation (pure - the rig pins these tables)
# ---------------------------------------------------------------------------

_JID_RE = re.compile(r"^\+?(\d{6,20})(?::\d+)?@(s\.whatsapp\.net|c\.us|lid|g\.us)$",
                     re.IGNORECASE)
_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s.]{2,24}$")
_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,59}$")
_URL_PREFIX_RE = re.compile(
    r"^(?:https?://)?(?:www\.|m\.)?(?:instagram\.com|facebook\.com|fb\.com|"
    r"tiktok\.com)/(?:@)?", re.IGNORECASE)
_WS_RE = re.compile(r"\s+")


def normalize_phone(raw: Any, country_code: Optional[str] = None) -> str:
    """Digits only, international, no '+'. Handles WhatsApp JIDs, ``00``
    prefixes, ``+`` and local ``0xxx`` numbers (default country code).
    Returns "" when the value is not a usable phone number (incl. @lid
    ids, which are not phone numbers at all)."""
    text = str(raw or "").strip()
    if not text:
        return ""
    jid = _JID_RE.match(text)
    if jid:
        if jid.group(2).lower() in ("lid", "g.us"):
            return ""
        digits = jid.group(1)
        plus = True
    else:
        plus = text.startswith("+")
        digits = re.sub(r"\D", "", text)
    if not digits:
        return ""
    if digits.startswith("00"):
        digits = digits[2:]
    elif not plus and digits.startswith("0") and 10 <= len(digits) <= 11:
        digits = (country_code or DEFAULT_COUNTRY_CODE) + digits[1:]
    if len(digits) < 7 or len(digits) > 15:
        return ""
    return digits


def normalize_email(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    if text.startswith("mailto:"):
        text = text[7:]
    return text if _EMAIL_RE.match(text) else ""


def normalize_username(raw: Any) -> str:
    text = _URL_PREFIX_RE.sub("", str(raw or "").strip())
    text = text.split("?")[0].rstrip("/").lstrip("@").strip().lower()
    return text if _USERNAME_RE.match(text) else ""


def normalize_handle(channel: Any, raw: Any) -> Tuple[str, str]:
    """(channel, normalised handle) or ("", "") when unusable."""
    ch = str(channel or "").strip().lower()
    if ch == "wa":
        ch = "whatsapp"
    if ch not in CHANNELS:
        return "", ""
    text = str(raw or "").strip()
    if not text or len(text) > 200:
        return "", ""
    if ch in ("whatsapp", "phone"):
        digits = normalize_phone(text)
        if digits:
            return ch, digits
        if ch == "whatsapp":
            jid = _JID_RE.match(text)
            if jid and jid.group(2).lower() == "lid":
                return ch, "lid:" + jid.group(1)
        return "", ""
    if ch == "email":
        handle = normalize_email(text)
        return (ch, handle) if handle else ("", "")
    if ch in ("instagram", "facebook", "tiktok"):
        handle = normalize_username(text)
        return (ch, handle) if handle else ("", "")
    handle = _WS_RE.sub(" ", text)[:MAX_HANDLE_CHARS].lower()
    return (ch, handle) if handle else ("", "")


def normalize_name(raw: Any) -> str:
    """Comparable person name: lower-case, single spaces, letters/digits
    only. Needs at least two words and five characters to count as a
    duplicate hint (single first names are far too common)."""
    text = re.sub(r"[^\w\s]", " ", str(raw or ""), flags=re.UNICODE)
    text = _WS_RE.sub(" ", text).strip().lower()
    if len(text) < 5 or len(text.split(" ")) < 2:
        return ""
    return text


# ---------------------------------------------------------------------------
# Shaping
# ---------------------------------------------------------------------------

def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)


def _handle_public(row: Dict[str, Any]) -> Dict[str, Any]:
    try:
        confidence = float(row.get("confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    return {
        "id": int(row.get("id") or 0),
        "channel": str(row.get("channel") or ""),
        "handle": str(row.get("handle") or ""),
        "raw": str(row.get("raw_handle") or row.get("handle") or ""),
        "confidence": round(confidence, 3),
        "source": str(row.get("source") or "system"),
        "created_at": _iso(row.get("created_at")),
    }


def _identity_public(row: Dict[str, Any],
                     handles: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "id": int(row.get("id") or 0),
        "display_name": str(row.get("display_name") or ""),
        "primary_contact": str(row.get("primary_contact_id") or ""),
        "status": str(row.get("status") or STATUS_ACTIVE),
        "handles": [_handle_public(h) for h in handles],
        "contacts": [str(h.get("raw_handle") or h.get("handle") or "")
                     for h in handles if h.get("channel") == "whatsapp"],
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
    }


# ---------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------

def _identity_by_id(cur, client_id: int,
                    identity_id: int) -> Optional[Dict[str, Any]]:
    cur.execute(
        "SELECT id, client_id, display_name, primary_contact_id, status,"
        " merged_into, created_at, updated_at FROM "
        + portal_db._q(IDENTITIES_TABLE) +
        " WHERE id = %s AND client_id = %s",
        (identity_id, client_id),
    )
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def _follow_merges(cur, client_id: int,
                   row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Merged identities point at their survivor; follow at most 5 hops."""
    hops = 0
    while row and row.get("status") == STATUS_MERGED and row.get("merged_into") \
            and hops < 5:
        row = _identity_by_id(cur, client_id, int(row["merged_into"]))
        hops += 1
    return row


def find_by_handle(cur, client_id: int, channel: str,
                   handle: str) -> Optional[Dict[str, Any]]:
    """Identity row that owns (channel, normalised handle), or None."""
    cur.execute(
        "SELECT i.id, i.client_id, i.display_name, i.primary_contact_id,"
        " i.status, i.merged_into, i.created_at, i.updated_at FROM "
        + portal_db._q(HANDLES_TABLE) + " h JOIN "
        + portal_db._q(IDENTITIES_TABLE) + " i ON i.id = h.identity_id"
        " WHERE h.client_id = %s AND h.channel = %s AND h.handle = %s",
        (client_id, channel, handle),
    )
    rows = portal_db.rows(cur)
    return _follow_merges(cur, client_id, rows[0]) if rows else None


def handles_of(cur, client_id: int, identity_id: int) -> List[Dict[str, Any]]:
    cur.execute(
        "SELECT id, identity_id, channel, handle, raw_handle, confidence,"
        " source, created_at FROM " + portal_db._q(HANDLES_TABLE) +
        " WHERE client_id = %s AND identity_id = %s ORDER BY id ASC",
        (client_id, identity_id),
    )
    return portal_db.rows(cur)


def _insert_handle(cur, client_id: int, identity_id: int, channel: str,
                   handle: str, raw: str, confidence: float,
                   source: str) -> Optional[int]:
    cur.execute(
        "INSERT INTO " + portal_db._q(HANDLES_TABLE) +
        " (client_id, identity_id, channel, handle, raw_handle, confidence,"
        " source) VALUES (%s, %s, %s, %s, %s, %s, %s)"
        " ON CONFLICT (client_id, channel, handle) DO NOTHING RETURNING id",
        (client_id, identity_id, channel, handle, raw[:200],
         max(0.0, min(1.0, float(confidence))),
         source if source in SOURCES else "system"),
    )
    rows = portal_db.rows(cur)
    return int(rows[0]["id"]) if rows else None


def resolve(cur, client_id: int, channel: str, raw: Any,
            display_name: str = "", create: bool = True,
            source: str = "system") -> Optional[Dict[str, Any]]:
    """Map (channel, raw handle) to a person. Creates the identity when
    unknown (``create=True``) - this is the adapter entry point. WhatsApp
    ids also register their phone-number alias so an owner-added phone
    or an SMS/voice handle for the same number lands on the same person.
    Returns None for unusable handles."""
    ch, handle = normalize_handle(channel, raw)
    if not handle:
        return None
    found = find_by_handle(cur, client_id, ch, handle)
    phone_alias = handle if ch in ("whatsapp", "phone") and handle.isdigit() else ""
    if found is None and phone_alias:
        other = "phone" if ch == "whatsapp" else "whatsapp"
        found = find_by_handle(cur, client_id, other, phone_alias)
        if found is not None:
            _insert_handle(cur, client_id, int(found["id"]), ch, handle,
                           str(raw), CONF_EXACT, source)
    if found is not None:
        return found
    if not create:
        return None
    name = _WS_RE.sub(" ", str(display_name or "").strip())[:MAX_NAME_CHARS]
    cur.execute(
        "INSERT INTO " + portal_db._q(IDENTITIES_TABLE) +
        " (client_id, display_name, primary_contact_id) VALUES (%s, %s, %s)"
        " RETURNING id, client_id, display_name, primary_contact_id, status,"
        " merged_into, created_at, updated_at",
        (client_id, name, str(raw).strip()[:200] if ch == "whatsapp" else ""),
    )
    rows = portal_db.rows(cur)
    identity = rows[0] if rows else {"id": 0, "client_id": client_id,
                                     "display_name": name,
                                     "primary_contact_id": "",
                                     "status": STATUS_ACTIVE}
    identity_id = int(identity.get("id") or 0)
    _insert_handle(cur, client_id, identity_id, ch, handle, str(raw),
                   CONF_EXACT, source)
    if phone_alias:
        _insert_handle(cur, client_id, identity_id,
                       "phone" if ch == "whatsapp" else "whatsapp",
                       phone_alias, str(raw), CONF_EXACT, source)
    return identity


def identity_for_contact(cur, client_id: int, contact_id: str,
                         display_name: str = "",
                         create: bool = True) -> Optional[Dict[str, Any]]:
    return resolve(cur, client_id, "whatsapp", contact_id, display_name,
                   create=create)


def linked_contact_ids(cur, client_id: int, contact_id: str) -> List[str]:
    """Other WhatsApp contact ids that belong to the same person (read
    only - never creates anything). [] when unknown."""
    identity = identity_for_contact(cur, client_id, contact_id, create=False)
    if identity is None:
        return []
    out: List[str] = []
    for row in handles_of(cur, client_id, int(identity["id"])):
        if row.get("channel") != "whatsapp":
            continue
        raw = str(row.get("raw_handle") or row.get("handle") or "")
        if raw and raw != contact_id and raw not in out:
            out.append(raw)
    return out


# ---------------------------------------------------------------------------
# Legacy read model (portal_contact_identities) - import once, sync always
# ---------------------------------------------------------------------------

def _legacy_sync(cur, client_id: int, identity_id: int,
                 handles: List[Dict[str, Any]]) -> None:
    """Mirror the identity's WhatsApp contacts into the legacy pair table
    so the profile's linked_channels / agent assist stay correct."""
    contacts = [str(h.get("raw_handle") or h.get("handle") or "")
                for h in handles if h.get("channel") == "whatsapp"]
    contacts = [c for c in contacts if c]
    if not contacts:
        return
    key = "idn:" + str(identity_id)
    values = ", ".join(["(%s, 'whatsapp', %s, %s)"] * len(contacts))
    params: List[Any] = []
    for contact in contacts:
        params.extend([client_id, contact, key])
    cur.execute(
        "INSERT INTO " + portal_db._q(LEGACY_TABLE) +
        " (client_id, channel, contact_id, identity_key) VALUES " + values +
        " ON CONFLICT (client_id, channel, contact_id)"
        " DO UPDATE SET identity_key = EXCLUDED.identity_key",
        tuple(params),
    )


def _legacy_forget(cur, client_id: int, contact_id: str) -> None:
    cur.execute(
        "DELETE FROM " + portal_db._q(LEGACY_TABLE) +
        " WHERE client_id = %s AND channel = 'whatsapp' AND contact_id = %s",
        (client_id, contact_id),
    )


def migrate_legacy(cur, client_id: int) -> int:
    """Import pre-engine pairwise links (identity_key 'id:a-b') as real
    identities. Idempotent (imported rows are re-keyed to 'idn:<id>') and
    runs once per workspace per process. Returns the number of contacts
    linked."""
    if client_id in _MIGRATED:
        return 0
    _MIGRATED.add(client_id)
    cur.execute(
        "SELECT identity_key, contact_id FROM " + portal_db._q(LEGACY_TABLE) +
        " WHERE client_id = %s AND identity_key NOT LIKE 'idn:%%'"
        " ORDER BY identity_key, id",
        (client_id,),
    )
    groups: Dict[str, List[str]] = {}
    for row in portal_db.rows(cur):
        key = str(row.get("identity_key") or "")
        contact = str(row.get("contact_id") or "")
        if key and contact and contact not in groups.setdefault(key, []):
            groups[key].append(contact)
    linked = 0
    for key, contacts in groups.items():
        if len(contacts) < 2:
            # a stale single row: re-key so it is not scanned again
            cur.execute(
                "UPDATE " + portal_db._q(LEGACY_TABLE) +
                " SET identity_key = %s WHERE client_id = %s"
                " AND identity_key = %s",
                ("idn:0", client_id, key),
            )
            continue
        keep = contacts[0]
        for other in contacts[1:]:
            if merge(cur, client_id, keep, other, actor_user_id=None,
                     source="legacy", audit=False):
                linked += 1
    return linked


# ---------------------------------------------------------------------------
# Mutations (all audited)
# ---------------------------------------------------------------------------

def merge(cur, client_id: int, keep_contact: str, merge_contact: str,
          actor_user_id: Optional[int] = None, source: str = "owner",
          audit: bool = True) -> Optional[Dict[str, Any]]:
    """SAFE merge: every handle of ``merge_contact``'s identity moves to
    ``keep_contact``'s identity; the emptied identity is marked merged
    (kept for history, followed on lookups). No conversation row is
    touched - ``split`` undoes it. Returns the surviving identity."""
    keep = identity_for_contact(cur, client_id, keep_contact)
    if keep is None:
        return None
    other = identity_for_contact(cur, client_id, merge_contact)
    if other is None:
        return None
    keep_id, other_id = int(keep["id"]), int(other["id"])
    if keep_id != other_id:
        cur.execute(
            "UPDATE " + portal_db._q(HANDLES_TABLE) +
            " SET identity_id = %s WHERE client_id = %s AND identity_id = %s",
            (keep_id, client_id, other_id),
        )
        cur.execute(
            "UPDATE " + portal_db._q(IDENTITIES_TABLE) +
            " SET status = 'merged', merged_into = %s, updated_at = NOW()"
            " WHERE id = %s AND client_id = %s",
            (keep_id, other_id, client_id),
        )
        cur.execute(
            "UPDATE " + portal_db._q(IDENTITIES_TABLE) +
            " SET display_name = CASE WHEN display_name = '' THEN %s"
            " ELSE display_name END, updated_at = NOW()"
            " WHERE id = %s AND client_id = %s",
            (str(other.get("display_name") or "")[:MAX_NAME_CHARS], keep_id,
             client_id),
        )
    handles = handles_of(cur, client_id, keep_id)
    _legacy_sync(cur, client_id, keep_id, handles)
    if audit:
        portal_db.log_action(
            cur, client_id, "identity.merged", "customer_user", actor_user_id,
            None, ("Linked " + merge_contact + " with " + keep_contact
                   + " (" + source + ")")[:200],
        )
    keep["handles"] = handles
    return keep


def split(cur, client_id: int, contact_id: str,
          actor_user_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """Undo a link: the contact (and its phone alias) moves to a fresh
    identity. None when the contact is not linked to anything."""
    identity = identity_for_contact(cur, client_id, contact_id, create=False)
    if identity is None:
        return None
    identity_id = int(identity["id"])
    handles = handles_of(cur, client_id, identity_id)
    mine = [h for h in handles if h.get("channel") == "whatsapp"
            and str(h.get("raw_handle") or h.get("handle") or "") == contact_id]
    others = [h for h in handles if h.get("channel") == "whatsapp"
              and str(h.get("raw_handle") or h.get("handle") or "") != contact_id]
    if not mine or not others:
        return None
    digits = normalize_phone(contact_id)
    move_ids = [int(h["id"]) for h in mine]
    move_ids += [int(h["id"]) for h in handles
                 if h.get("channel") == "phone" and digits
                 and str(h.get("handle") or "") == digits]
    cur.execute(
        "INSERT INTO " + portal_db._q(IDENTITIES_TABLE) +
        " (client_id, display_name, primary_contact_id) VALUES (%s, %s, %s)"
        " RETURNING id, client_id, display_name, primary_contact_id, status,"
        " merged_into, created_at, updated_at",
        (client_id, "", contact_id[:200]),
    )
    rows = portal_db.rows(cur)
    fresh = rows[0] if rows else {"id": 0, "display_name": "",
                                  "primary_contact_id": contact_id,
                                  "status": STATUS_ACTIVE}
    fresh_id = int(fresh.get("id") or 0)
    cur.execute(
        "UPDATE " + portal_db._q(HANDLES_TABLE) +
        " SET identity_id = %s WHERE client_id = %s AND id = ANY(%s)",
        (fresh_id, client_id, move_ids),
    )
    if str(identity.get("primary_contact_id") or "") == contact_id:
        cur.execute(
            "UPDATE " + portal_db._q(IDENTITIES_TABLE) +
            " SET primary_contact_id = %s, updated_at = NOW()"
            " WHERE id = %s AND client_id = %s",
            (str(others[0].get("raw_handle") or others[0].get("handle") or ""),
             identity_id, client_id),
        )
    _legacy_forget(cur, client_id, contact_id)
    portal_db.log_action(
        cur, client_id, "identity.split", "customer_user", actor_user_id, None,
        ("Unlinked " + contact_id + " from identity " + str(identity_id))[:200],
    )
    fresh["handles"] = handles_of(cur, client_id, fresh_id)
    return fresh


def add_handle(cur, client_id: int, contact_id: str, channel: str, raw: Any,
               actor_user_id: Optional[int] = None,
               confidence: float = CONF_EXACT,
               source: str = "owner") -> Tuple[str, Any]:
    """Attach an alias to the contact's identity.
    Returns ("ok", handle) | ("invalid", message) | ("limit", message) |
    ("conflict", other_primary_contact) - a handle owned by ANOTHER
    person is never stolen silently; the owner merges explicitly."""
    ch, handle = normalize_handle(channel, raw)
    if not handle or ch not in OWNER_CHANNELS:
        return "invalid", "That handle is not valid for this channel."
    identity = identity_for_contact(cur, client_id, contact_id)
    if identity is None:
        return "invalid", "Unknown contact."
    identity_id = int(identity["id"])
    owner = find_by_handle(cur, client_id, ch, handle)
    if owner is not None and int(owner["id"]) != identity_id:
        return "conflict", str(owner.get("primary_contact_id") or "")
    handles = handles_of(cur, client_id, identity_id)
    for existing in handles:
        if existing.get("channel") == ch and existing.get("handle") == handle:
            return "ok", _handle_public(existing)
    if len(handles) >= MAX_HANDLES:
        return "limit", "This customer already has the maximum number of handles."
    new_id = _insert_handle(cur, client_id, identity_id, ch, handle, str(raw),
                            confidence, source)
    portal_db.log_action(
        cur, client_id, "identity.handle_added", "customer_user",
        actor_user_id, None,
        ("Added " + ch + " " + handle + " to " + contact_id)[:200],
    )
    return "ok", {"id": int(new_id or 0), "channel": ch, "handle": handle,
                  "raw": str(raw).strip()[:200],
                  "confidence": round(float(confidence), 3),
                  "source": source, "created_at": None}


def remove_handle(cur, client_id: int, handle_id: int,
                  actor_user_id: Optional[int] = None) -> str:
    """"ok" | "not_found" | "protected" (WhatsApp ids are conversation
    keys - use split, never delete)."""
    cur.execute(
        "SELECT id, channel, handle FROM " + portal_db._q(HANDLES_TABLE) +
        " WHERE id = %s AND client_id = %s",
        (handle_id, client_id),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return "not_found"
    if rows[0].get("channel") == "whatsapp":
        return "protected"
    cur.execute(
        "DELETE FROM " + portal_db._q(HANDLES_TABLE) +
        " WHERE id = %s AND client_id = %s",
        (handle_id, client_id),
    )
    portal_db.log_action(
        cur, client_id, "identity.handle_removed", "customer_user",
        actor_user_id, None,
        ("Removed " + str(rows[0].get("channel")) + " "
         + str(rows[0].get("handle")))[:200],
    )
    return "ok"


def dismiss(cur, client_id: int, contact_a: str, contact_b: str,
            actor_user_id: Optional[int] = None) -> None:
    first, second = sorted((contact_a, contact_b))
    cur.execute(
        "INSERT INTO " + portal_db._q(DISMISSALS_TABLE) +
        " (client_id, contact_a, contact_b) VALUES (%s, %s, %s)"
        " ON CONFLICT (client_id, contact_a, contact_b) DO NOTHING",
        (client_id, first, second),
    )
    portal_db.log_action(
        cur, client_id, "identity.dismissed", "customer_user", actor_user_id,
        None, ("Not the same person: " + first + " / " + second)[:200],
    )


# ---------------------------------------------------------------------------
# Duplicate detection (deterministic)
# ---------------------------------------------------------------------------

def duplicates(cur, client_id: int, limit: int = 50,
               contact: Optional[str] = None) -> Dict[str, Any]:
    """Candidate pairs the owner should look at. Evidence, strongest
    first: the same phone number behind two contact ids (JID vs bare
    number, 0-prefixed imports) -> 0.95; the same two-word name -> 0.4.
    Pairs already on one identity or dismissed are skipped."""
    limit = max(1, min(SUGGESTIONS_MAX, int(limit or 50)))
    cur.execute(
        "SELECT contact_id, MAX(contact_name) AS contact_name,"
        " MAX(last_message_at) AS last_at FROM "
        + portal_db._q(portal_db.CONV_TABLE) +
        " WHERE client_id = %s GROUP BY contact_id"
        " ORDER BY MAX(last_message_at) DESC NULLS LAST LIMIT %s",
        (client_id, SCAN_MAX),
    )
    contacts = portal_db.rows(cur)
    cur.execute(
        "SELECT identity_id, channel, handle, raw_handle FROM "
        + portal_db._q(HANDLES_TABLE) + " WHERE client_id = %s",
        (client_id,),
    )
    handle_rows = portal_db.rows(cur)
    cur.execute(
        "SELECT contact_a, contact_b FROM " + portal_db._q(DISMISSALS_TABLE) +
        " WHERE client_id = %s",
        (client_id,),
    )
    dismissed = {(str(r.get("contact_a")), str(r.get("contact_b")))
                 for r in portal_db.rows(cur)}

    identity_of: Dict[str, int] = {}
    members: Dict[int, Set[str]] = {}
    for row in handle_rows:
        if row.get("channel") != "whatsapp":
            continue
        raw = str(row.get("raw_handle") or row.get("handle") or "")
        ident = int(row.get("identity_id") or 0)
        identity_of[raw] = ident
        members.setdefault(ident, set()).add(raw)
    linked_identities = sum(1 for ids in members.values() if len(ids) > 1)

    names: Dict[str, str] = {}
    by_phone: Dict[str, List[str]] = {}
    by_name: Dict[str, List[str]] = {}
    for row in contacts:
        cid = str(row.get("contact_id") or "")
        if not cid:
            continue
        names[cid] = str(row.get("contact_name") or "")
        digits = normalize_phone(cid)
        if digits:
            by_phone.setdefault(digits, []).append(cid)
        name = normalize_name(row.get("contact_name"))
        if name:
            by_name.setdefault(name, []).append(cid)

    seen: Set[Tuple[str, str]] = set()
    out: List[Dict[str, Any]] = []

    def consider(a: str, b: str, reason: str, confidence: float) -> None:
        if a == b:
            return
        pair = tuple(sorted((a, b)))
        if pair in seen or pair in dismissed:
            return
        if contact and contact not in pair:
            return
        ia, ib = identity_of.get(a), identity_of.get(b)
        if ia is not None and ia == ib:
            return
        seen.add(pair)
        out.append({
            "contact_a": a, "name_a": names.get(a, ""),
            "contact_b": b, "name_b": names.get(b, ""),
            "reason": reason, "confidence": confidence,
        })

    for digits, ids in by_phone.items():
        for i in range(len(ids)):
            for j in range(i + 1, min(len(ids), i + 7)):
                consider(ids[i], ids[j], "same_phone", CONF_SAME_PHONE)
    for name, ids in by_name.items():
        for i in range(len(ids)):
            for j in range(i + 1, min(len(ids), i + 4)):
                consider(ids[i], ids[j], "same_name", CONF_SAME_NAME)
    out.sort(key=lambda item: -item["confidence"])
    return {
        "suggestions": out[:limit],
        "scanned": len(contacts),
        "linked_identities": linked_identities,
        "total": len(out),
    }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    return principal, None


def _human_or_error():
    principal, error = _principal_or_error()
    if error:
        return None, error
    forbidden = ensure_human_principal(principal)
    if forbidden is not None:
        return None, forbidden
    return principal, None


def _bad(message: str, code: str = "bad_request", status: int = 400):
    return jsonify({"error": {"code": code, "message": message}}), status


def _clean_contact(value: Any) -> str:
    return str(value or "").strip()[:100]


def _import_legacy_guarded(cur, client_id: int) -> None:
    """Run the one-off legacy import inside a savepoint so a bad legacy
    row can never poison the request's transaction (fail-soft)."""
    if client_id in _MIGRATED:
        return
    cur.execute("SAVEPOINT idn_legacy")
    try:
        migrate_legacy(cur, client_id)
    except Exception as error:  # pragma: no cover - fail-soft
        logger.warning("identity legacy import skipped: %s", error)
        cur.execute("ROLLBACK TO SAVEPOINT idn_legacy")
        _MIGRATED.add(client_id)
    else:
        cur.execute("RELEASE SAVEPOINT idn_legacy")


def _contact_names(cur, client_id: int, contacts: List[str]) -> Dict[str, str]:
    if not contacts:
        return {}
    cur.execute(
        "SELECT contact_id, MAX(contact_name) AS contact_name FROM "
        + portal_db._q(portal_db.CONV_TABLE) +
        " WHERE client_id = %s AND contact_id = ANY(%s) GROUP BY contact_id",
        (client_id, list(contacts)),
    )
    return {str(r.get("contact_id") or ""): str(r.get("contact_name") or "")
            for r in portal_db.rows(cur)}


@bp.get("/identity")
def get_identity():
    """Identity card for one contact: handles, linked contacts and the
    duplicate hints that involve this contact."""
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    contact = _clean_contact(request.args.get("contact"))
    if not contact:
        return _bad("contact is required.")
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            _import_legacy_guarded(cur, client_id)
            identity = identity_for_contact(cur, client_id, contact)
            if identity is None:
                conn.rollback()
                return _bad("That contact id is not usable.")
            handles = handles_of(cur, client_id, int(identity["id"]))
            linked = [str(h.get("raw_handle") or h.get("handle") or "")
                      for h in handles if h.get("channel") == "whatsapp"
                      and str(h.get("raw_handle") or h.get("handle") or "")
                      != contact]
            names = _contact_names(cur, client_id, linked)
            try:
                hints = duplicates(cur, client_id, 10, contact=contact)
            except Exception as error:  # pragma: no cover - fail-soft
                logger.warning("identity hints skipped: %s", error)
                hints = {"suggestions": []}
        conn.commit()
    finally:
        conn.close()
    public = _identity_public(identity, handles)
    public["linked"] = [{"contact_id": c, "name": names.get(c, "")}
                        for c in linked]
    return jsonify({
        "identity": public,
        "suggestions": hints.get("suggestions", []),
        "channels": list(OWNER_CHANNELS),
        "limits": {"max_handles": MAX_HANDLES},
    }), 200


@bp.post("/identity/handles")
def post_handle():
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    contact = _clean_contact(payload.get("contact"))
    channel = str(payload.get("channel") or "").strip().lower()
    raw = str(payload.get("handle") or "").strip()
    if not contact or not channel or not raw:
        return _bad("contact, channel and handle are required.")
    if channel not in OWNER_CHANNELS:
        return _bad("channel must be one of: " + ", ".join(OWNER_CHANNELS) + ".")
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            status, result = add_handle(cur, client_id, contact, channel, raw,
                                        principal.get("user_id"))
            if status != "ok":
                conn.rollback()
                if status == "conflict":
                    return jsonify({"error": {
                        "code": "identity_conflict",
                        "message": "That handle already belongs to another"
                                   " customer. Link the two profiles if they"
                                   " are the same person."},
                        "other_contact": result}), 409
                return _bad(str(result))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "handle": result}), 200


@bp.delete("/identity/handles/<int:handle_id>")
def delete_handle(handle_id: int):
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            status = remove_handle(cur, client_id, handle_id,
                                   principal.get("user_id"))
            if status == "not_found":
                conn.rollback()
                return _bad("No such handle.", "not_found", 404)
            if status == "protected":
                conn.rollback()
                return _bad("WhatsApp contacts cannot be removed - unlink"
                            " the contact instead.")
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True}), 200


@bp.post("/identity/merge")
def post_merge():
    """Link two contacts as one person (safe, reversible)."""
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    keep = _clean_contact(payload.get("keep"))
    other = _clean_contact(payload.get("merge"))
    if not keep or not other:
        return _bad("Both contacts are required.")
    if keep == other:
        return _bad("Pick two different contacts.")
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            identity = merge(cur, client_id, keep, other,
                             principal.get("user_id"))
            if identity is None:
                conn.rollback()
                return _bad("One of the contact ids is not usable.")
            handles = identity.pop("handles", [])
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True,
                    "identity": _identity_public(identity, handles)}), 200


@bp.post("/identity/split")
def post_split():
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    contact = _clean_contact(payload.get("contact"))
    if not contact:
        return _bad("contact is required.")
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            fresh = split(cur, client_id, contact, principal.get("user_id"))
            if fresh is None:
                conn.rollback()
                return _bad("This contact is not linked to another contact.",
                            "not_found", 404)
            handles = fresh.pop("handles", [])
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True,
                    "identity": _identity_public(fresh, handles)}), 200


@bp.get("/identity/duplicates")
def get_duplicates():
    principal, error = _principal_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    try:
        limit = int(request.args.get("limit") or 50)
    except (TypeError, ValueError):
        limit = 50
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            try:
                migrate_legacy(cur, client_id)
            except Exception as error:  # pragma: no cover - fail-soft
                logger.warning("identity legacy import skipped: %s", error)
            result = duplicates(cur, client_id, limit)
        conn.commit()
    finally:
        conn.close()
    return jsonify(result), 200


@bp.post("/identity/dismiss")
def post_dismiss():
    principal, error = _human_or_error()
    if error:
        return error
    client_id = int(principal.get("client_id") or 0)
    payload = request.get_json(silent=True) or {}
    contact_a = _clean_contact(payload.get("contact_a"))
    contact_b = _clean_contact(payload.get("contact_b"))
    if not contact_a or not contact_b or contact_a == contact_b:
        return _bad("Two different contacts are required.")
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            dismiss(cur, client_id, contact_a, contact_b,
                    principal.get("user_id"))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True}), 200
