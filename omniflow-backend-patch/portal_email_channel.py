"""Email channel (§243, gap analysis row 24 / Phase 6): a workspace mailbox
becomes a channel of the same inbox, AI and workflows.

This module is an ADAPTER, like the Instagram one - no second inbox:

* Inbound: the workspace mailbox is read over IMAP (TLS only). New emails
  are normalized (sender ``em:<address>``, channel ``email``) and handed to
  ``connector_api.ingest_messages_for_tenant``, so idempotency, the
  one-reply law, approvals, compliance, the AI brain, workflows and audit
  run unchanged. The mailbox is opened READ-ONLY and messages are fetched
  with BODY.PEEK, so nothing is marked read, moved or deleted. Only mail
  that arrives after the channel is connected is imported (the UID cursor
  starts at the end of the mailbox; a changed UIDVALIDITY restarts there).
* Outbound: replies queued on the shared command queue with channel
  ``email`` (inbox replies, approved drafts, the AI brain) are sent by the
  Control Plane itself over SMTP (implicit TLS on 465, STARTTLS otherwise;
  never plain text) as a proper reply in the customer's thread
  (``Re:`` subject, In-Reply-To, References). Automated answers carry
  ``Auto-Submitted: auto-replied`` (RFC 3834) so other robots do not loop.
  Delivery bookkeeping (retries with backoff, dead after max attempts) is
  the shared ``portal_events.on_command_ack``. Text only: media, templates
  and other actions are refused and never retried.
* Loop and noise guards: auto-replies, bounces, mailing lists and no-reply
  senders are skipped, and so are emails from the workspace's own address.

Runs from the connector tick and the inbox list (``kick``: a background
thread with its own connection, at most every OF_EMAIL_POLL_SECONDS, one run
per workspace through a database advisory lock) and on demand ("Check now").

Credentials are tenant-scoped: the password is sealed with ``portal_vault``
and never returned. Mail servers must be public host names (the same SSRF
guard as the website crawler). Settings: owners / admins (OF_NOTIFY_ROLES);
every team member can read and run a check; API keys get 403.
OF_EMAIL_CHANNEL=0 turns the channel off. Standard library only.
"""

import html
import imaplib
import logging
import os
import re
import smtplib
import ssl
import threading
import time
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formataddr, make_msgid, parseaddr
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

import portal_cp_outbox
import portal_db
import portal_txn
import portal_vault
from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
    ensure_human_principal,
)

logger = logging.getLogger("omniflow.email_channel")

bp = Blueprint("portal_email_channel", __name__, url_prefix="/api/v1/portal")


def _env_int(name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(str(os.environ.get(name, "")).strip() or default)
    except ValueError:
        value = default
    return max(low, min(high, value))


ENABLED = os.environ.get("OF_EMAIL_CHANNEL", "1").strip() != "0"
SETTINGS_TABLE = os.environ.get("OF_EMAIL_TABLE", "portal_email_accounts")
THREADS_TABLE = os.environ.get("OF_EMAIL_THREADS_TABLE", "portal_email_threads")
POLL_SECONDS = _env_int("OF_EMAIL_POLL_SECONDS", 60, 30, 3600)
TIMEOUT_SECONDS = _env_int("OF_EMAIL_TIMEOUT_SECONDS", 8, 3, 60)
MAX_PER_POLL = _env_int("OF_EMAIL_MAX_PER_POLL", 20, 1, 50)
MAX_SEND_PER_RUN = _env_int("OF_EMAIL_MAX_SEND", 10, 1, 50)
MAX_BYTES = _env_int("OF_EMAIL_MAX_BYTES", 1_000_000, 50_000, 10_000_000)
DEFAULT_SUBJECT = os.environ.get("OF_EMAIL_DEFAULT_SUBJECT", "").strip()

CHANNEL = "email"
PREFIX = "em:"
MAX_TEXT = 4000
MAX_SUBJECT = 200
MAX_ATTACHMENT_NAMES = 5
LOCK_CLASS = 24301  # pg advisory lock namespace: one run per workspace
TEXT_ACTIONS = ("send_message", "send_interactive")
HUMAN_SOURCES = ("manual", "approval")
VAULT_FIELDS = ("password",)
CREDENTIAL_FIELDS = ("address", "username", "password", "imap_host", "imap_port",
                     "smtp_host", "smtp_port")
NO_REPLY_LOCALS = ("mailer-daemon", "postmaster", "noreply", "no-reply",
                   "donotreply", "do-not-reply", "bounce", "bounces")

# Network factories (tests replace these with fakes).
_IMAP_SSL = imaplib.IMAP4_SSL
_IMAP = imaplib.IMAP4
_SMTP_SSL = smtplib.SMTP_SSL
_SMTP = smtplib.SMTP
_RESOLVER = None

_HOST_RE = re.compile(r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
                      r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")
_RE_PREFIX = re.compile(r"^\s*((re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*)+", re.I)
_QUOTE_HEAD = re.compile(
    r"^(on\s.{0,250}\swrote:|-{2,}\s*original message\s*-{2,}|_{10,}|"
    r"-{2,}\s*forwarded message\s*-{2,})$", re.I)
_TAG_RE = re.compile(r"<[^>]+>")
_DROP_RE = re.compile(r"<(script|style|head)\b.*?</\1\s*>", re.I | re.S)
_BREAK_RE = re.compile(r"<\s*(br|/p|/div|/li|/tr|/h[1-6])\b[^>]*>", re.I)
_SIZE_RE = re.compile(rb"RFC822\.SIZE (\d+)")
_STATUS_RE = re.compile(rb"(UIDNEXT|UIDVALIDITY) (\d+)")

_DDL_READY = False
_LOCK = threading.Lock()
_LAST: Dict[int, float] = {}
_RUNNING: set = set()


class EmailError(Exception):
    """An owner-readable mail problem (message is safe to show)."""


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(SETTINGS_TABLE) +
        " (client_id BIGINT PRIMARY KEY,"
        " enabled BOOLEAN NOT NULL DEFAULT FALSE,"
        " address TEXT NOT NULL DEFAULT '',"
        " display_name TEXT NOT NULL DEFAULT '',"
        " username TEXT NOT NULL DEFAULT '',"
        " password TEXT NOT NULL DEFAULT '',"
        " imap_host TEXT NOT NULL DEFAULT '',"
        " imap_port INTEGER NOT NULL DEFAULT 993,"
        " smtp_host TEXT NOT NULL DEFAULT '',"
        " smtp_port INTEGER NOT NULL DEFAULT 465,"
        " verified_at TIMESTAMPTZ,"
        " uid_validity BIGINT,"
        " last_uid BIGINT,"
        " last_poll_at TIMESTAMPTZ,"
        " last_ok_at TIMESTAMPTZ,"
        " last_error TEXT NOT NULL DEFAULT '',"
        " imported_count BIGINT NOT NULL DEFAULT 0,"
        " sent_count BIGINT NOT NULL DEFAULT 0,"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
    cur.execute(
        "CREATE TABLE IF NOT EXISTS " + portal_db._q(THREADS_TABLE) +
        " (client_id BIGINT NOT NULL,"
        " contact_id TEXT NOT NULL,"
        " message_id TEXT NOT NULL DEFAULT '',"
        " subject TEXT NOT NULL DEFAULT '',"
        " refs TEXT NOT NULL DEFAULT '',"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
        " PRIMARY KEY (client_id, contact_id))")
    _DDL_READY = True


_COLUMNS = ("client_id, enabled, address, display_name, username, password,"
            " imap_host, imap_port, smtp_host, smtp_port, verified_at,"
            " uid_validity, last_uid, last_poll_at, last_ok_at, last_error,"
            " imported_count, sent_count, updated_at")


def load_account(cur, client_id: int) -> Optional[Dict[str, Any]]:
    """The workspace mailbox with the password opened (None = not set up)."""
    cur.execute("SELECT " + _COLUMNS + " FROM " + portal_db._q(SETTINGS_TABLE) +
                " WHERE client_id = %s LIMIT 1", (client_id,))
    rows = portal_db.rows(cur)
    return portal_vault.unseal_fields(rows[0], VAULT_FIELDS) if rows else None


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if hasattr(value, "isoformat") else None


def public_settings(account: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    row = account or {}
    return {
        "address": str(row.get("address") or ""),
        "display_name": str(row.get("display_name") or ""),
        "username": str(row.get("username") or ""),
        "password_set": bool(row.get("password")),
        "imap_host": str(row.get("imap_host") or ""),
        "imap_port": int(row.get("imap_port") or 993),
        "smtp_host": str(row.get("smtp_host") or ""),
        "smtp_port": int(row.get("smtp_port") or 465),
        "enabled": row.get("enabled") is True,
        "verified": row.get("verified_at") is not None,
        "verified_at": _iso(row.get("verified_at")),
        "last_poll_at": _iso(row.get("last_poll_at")),
        "last_ok_at": _iso(row.get("last_ok_at")),
        "last_error": str(row.get("last_error") or ""),
        "imported_count": int(row.get("imported_count") or 0),
        "sent_count": int(row.get("sent_count") or 0),
    }


def _one_line(value: Any, limit: int) -> str:
    return _CTRL_RE.sub(" ", str(value or "")).strip()[:limit]


def clean_settings(payload: Any, existing: Optional[Dict[str, Any]]
                   ) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Validate an owner's mailbox form. Returns (clean, None) or
    (None, owner-readable error). A blank password keeps the saved one."""
    import portal_identity

    if not isinstance(payload, dict):
        return None, "Send the mailbox settings as an object."
    old = existing or {}
    address = portal_identity.normalize_email(payload.get("address"))
    if not address:
        return None, "Enter the mailbox email address."
    raw_password = payload.get("password")
    if raw_password is not None and not isinstance(raw_password, str):
        return None, "The password must be text."
    password = raw_password or ""
    if len(password) > 500 or _CTRL_RE.search(password):
        return None, "The password is not valid."
    if not password:
        password = str(old.get("password") or "")
    if not password:
        return None, "Enter the mailbox password (an app password for Gmail / Outlook)."
    username = _one_line(payload.get("username"), 200) or address
    clean: Dict[str, Any] = {
        "address": address,
        "display_name": _one_line(payload.get("display_name"), 80),
        "username": username,
        "password": password,
    }
    for kind, default in (("imap", 993), ("smtp", 465)):
        host = str(payload.get(kind + "_host") or "").strip().lower().rstrip(".")
        if not _HOST_RE.match(host):
            return None, "Enter the " + kind.upper() + " server host name (for example " \
                + kind + ".example.com)."
        port = payload.get(kind + "_port", default)
        if isinstance(port, str) and port.strip().isascii() and port.strip().isdigit():
            port = int(port.strip())
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            return None, "The " + kind.upper() + " port must be a number from 1 to 65535."
        clean[kind + "_host"] = host
        clean[kind + "_port"] = port
    enabled = payload.get("enabled", False)
    if not isinstance(enabled, bool):
        return None, "enabled must be true or false."
    changed = any(clean[name] != old.get(name) for name in CREDENTIAL_FIELDS)
    clean["credentials_changed"] = changed or not old
    verified = old.get("verified_at") is not None and not clean["credentials_changed"]
    if enabled and not verified:
        return None, "Run Test connection first - the channel turns on when it passes."
    clean["enabled"] = enabled
    return clean, None


# ---------------------------------------------------------------------------
# Parsing inbound mail
# ---------------------------------------------------------------------------

def html_to_text(markup: str) -> str:
    text = _DROP_RE.sub(" ", markup or "")
    text = _BREAK_RE.sub("\n", text)
    text = html.unescape(_TAG_RE.sub(" ", text))
    lines = [" ".join(line.split()) for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def strip_quoted(text: str) -> str:
    """The new part of a reply: cut at the quoted history ("On ... wrote:",
    also wrapped over two lines; "Original message"; Outlook's From / Sent
    block or separator) and at the "-- " signature; drop ">" quote lines."""
    kept: List[str] = []
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for index, line in enumerate(lines):
        flat = line.strip()
        low = flat.lower()
        nxt = lines[index + 1].strip().lower() if index + 1 < len(lines) else ""
        if line.rstrip() == "--" or _QUOTE_HEAD.match(flat):
            break
        if low.startswith("on ") and len(flat) < 300 and (
                nxt == "wrote:" or (nxt.endswith(" wrote:") and len(nxt) < 200)):
            break
        if low.startswith("from:") and nxt.startswith(("sent:", "date:")):
            break
        if flat.startswith(">"):
            continue
        kept.append(line.rstrip())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept).strip())


def _decode_part(part) -> str:
    try:
        content = part.get_content()
        return content if isinstance(content, str) else ""
    except Exception:
        raw = part.get_payload(decode=True) or b""
        return raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else ""


def body_and_attachments(message) -> Tuple[str, List[str]]:
    plain, markup, names = "", "", []
    for part in message.walk():
        if part.is_multipart():
            continue
        filename = part.get_filename()
        if part.get_content_disposition() == "attachment" or (
                filename and part.get_content_maintype() not in ("text",)):
            if filename and len(names) < MAX_ATTACHMENT_NAMES:
                names.append(_one_line(filename, 120))
            continue
        kind = part.get_content_type()
        if kind == "text/plain" and not plain:
            plain = _decode_part(part)
        elif kind == "text/html" and not markup:
            markup = _decode_part(part)
    return (plain if plain.strip() else html_to_text(markup)), names


def is_automated(message, sender: str, own_address: str) -> bool:
    """Robots, bounces, lists and our own mail never become conversations."""
    auto = str(message.get("Auto-Submitted", "") or "").strip().lower()
    if auto and auto != "no":
        return True
    if str(message.get("Precedence", "") or "").strip().lower() in (
            "bulk", "junk", "list", "auto_reply"):
        return True
    for header in ("List-Id", "List-Unsubscribe", "X-Autoreply", "X-Autorespond"):
        if message.get(header) is not None:
            return True
    if str(message.get("Return-Path", "") or "").strip() == "<>":
        return True
    local = sender.split("@", 1)[0]
    return local in NO_REPLY_LOCALS or (bool(own_address) and sender == own_address)


def _header_ids(value: Any) -> List[str]:
    return re.findall(r"<[^<>\s]{1,250}>", str(value or ""))


def parse_email(raw: bytes, own_address: str) -> Dict[str, Any]:
    """One raw email -> the fields the channel needs (``skip`` set when it
    must not become a conversation message)."""
    import portal_identity

    message = BytesParser(policy=policy.default).parsebytes(raw or b"")
    name, address = parseaddr(str(message.get("From", "") or ""))
    sender = portal_identity.normalize_email(address)
    subject = _one_line(message.get("Subject", ""), MAX_SUBJECT)
    message_id = (_header_ids(message.get("Message-ID")) or [""])[0]
    reply_to = (_header_ids(message.get("In-Reply-To")) or [""])[0]
    refs = _header_ids(message.get("References"))
    out: Dict[str, Any] = {"sender": sender, "name": _one_line(name, 120),
                           "subject": subject, "message_id": message_id,
                           "in_reply_to": reply_to, "refs": refs, "skip": ""}
    if not sender:
        out["skip"] = "no_sender"
        return out
    if is_automated(message, sender, own_address):
        out["skip"] = "automated"
        return out
    text, names = body_and_attachments(message)
    text = strip_quoted(text)
    if subject and not reply_to and not _RE_PREFIX.match(subject):
        text = "Subject: " + subject + ("\n\n" + text if text else "")
    for filename in names:
        text += ("\n" if text else "") + "[Attachment: " + filename + "]"
    out["body"] = (text or subject or "(empty email)")[:MAX_TEXT]
    return out


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

def _public_host(host: str, port: int) -> None:
    import portal_knowledge

    try:
        portal_knowledge.assert_public_url("https://" + host + ":" + str(port),
                                           resolver=_RESOLVER)
    except ValueError:
        raise EmailError("The mail server " + host + " must be a public host name.")


def open_imap(account: Dict[str, Any]):
    host, port = str(account.get("imap_host") or ""), int(account.get("imap_port") or 993)
    _public_host(host, port)
    context = ssl.create_default_context()
    try:
        if port == 993:
            box = _IMAP_SSL(host, port, ssl_context=context, timeout=TIMEOUT_SECONDS)
        else:
            box = _IMAP(host, port, timeout=TIMEOUT_SECONDS)
            box.starttls(ssl_context=context)
    except Exception as error:
        raise EmailError("Could not reach the IMAP server " + host + ":" + str(port)
                         + " over TLS (" + type(error).__name__ + ").")
    try:
        box.login(str(account.get("username") or ""), str(account.get("password") or ""))
    except Exception:
        _close_imap(box)
        raise EmailError("IMAP sign-in failed - check the username and password"
                         " (Gmail / Outlook need an app password).")
    return box


def _close_imap(box) -> None:
    try:
        box.logout()
    except Exception:
        pass


def open_smtp(account: Dict[str, Any]):
    host, port = str(account.get("smtp_host") or ""), int(account.get("smtp_port") or 465)
    _public_host(host, port)
    context = ssl.create_default_context()
    try:
        if port == 465:
            server = _SMTP_SSL(host, port, timeout=TIMEOUT_SECONDS, context=context)
        else:
            server = _SMTP(host, port, timeout=TIMEOUT_SECONDS)
            server.ehlo()
            if not server.has_extn("starttls"):
                _close_smtp(server)
                raise EmailError("The SMTP server " + host + " does not offer encryption"
                                 " (STARTTLS) on port " + str(port) + ".")
            server.starttls(context=context)
            server.ehlo()
    except EmailError:
        raise
    except Exception as error:
        raise EmailError("Could not reach the SMTP server " + host + ":" + str(port)
                         + " over TLS (" + type(error).__name__ + ").")
    try:
        server.login(str(account.get("username") or ""), str(account.get("password") or ""))
    except Exception:
        _close_smtp(server)
        raise EmailError("SMTP sign-in failed - check the username and password"
                         " (Gmail / Outlook need an app password).")
    return server


def _close_smtp(server) -> None:
    try:
        server.quit()
    except Exception:
        pass


def mailbox_state(box) -> Tuple[int, int]:
    """(UIDVALIDITY, UIDNEXT) of the inbox."""
    typ, data = box.status("INBOX", "(UIDNEXT UIDVALIDITY)")
    found = dict((k.decode(), int(v)) for k, v in _STATUS_RE.findall(
        b" ".join(d for d in (data or []) if isinstance(d, bytes))))
    if typ != "OK" or "UIDNEXT" not in found or "UIDVALIDITY" not in found:
        raise EmailError("The mailbox did not report its state (INBOX missing?).")
    return found["UIDVALIDITY"], found["UIDNEXT"]


def fetch_new(box, last_uid: int) -> List[Tuple[int, int, bytes]]:
    """(uid, size, raw bytes) of up to MAX_PER_POLL emails after last_uid,
    oldest first. Read-only: BODY.PEEK keeps them unread."""
    typ, _ = box.select("INBOX", readonly=True)
    if typ != "OK":
        raise EmailError("The INBOX folder could not be opened.")
    typ, data = box.uid("SEARCH", None, "UID " + str(last_uid + 1) + ":*")
    if typ != "OK":
        raise EmailError("The mailbox search failed.")
    uids = sorted({int(x) for x in (data[0] or b"").split() if x.isdigit()
                   and int(x) > last_uid})[:MAX_PER_POLL]
    out = []
    for uid in uids:
        typ, data = box.uid("FETCH", str(uid),
                            "(RFC822.SIZE BODY.PEEK[]<0." + str(MAX_BYTES) + ">)")
        raw, size = b"", 0
        for part in data or []:
            if isinstance(part, tuple) and len(part) >= 2:
                match = _SIZE_RE.search(part[0] or b"")
                size = int(match.group(1)) if match else 0
                raw = part[1] or b""
                break
        out.append((uid, size, raw))
    return out


def build_reply(account: Dict[str, Any], to_address: str, body: str,
                thread: Optional[Dict[str, Any]], automated: bool) -> EmailMessage:
    message = EmailMessage()
    address = str(account.get("address") or "")
    message["From"] = formataddr((_one_line(account.get("display_name"), 80), address))
    message["To"] = to_address
    subject = _RE_PREFIX.sub("", str((thread or {}).get("subject") or "")).strip()
    if subject:
        message["Subject"] = "Re: " + subject
    else:
        message["Subject"] = DEFAULT_SUBJECT or ("Message from " + (
            _one_line(account.get("display_name"), 80) or address.split("@")[-1]))
    parent = str((thread or {}).get("message_id") or "")
    if parent:
        message["In-Reply-To"] = parent
        refs = str((thread or {}).get("refs") or "").split()
        message["References"] = " ".join((refs + ([parent] if parent not in refs else []))[-10:])
    message["Message-ID"] = make_msgid(domain=address.split("@")[-1] or None)
    if automated:
        message["Auto-Submitted"] = "auto-replied"
    message.set_content(body)
    return message


# ---------------------------------------------------------------------------
# One run: send queued replies, then import new mail
# ---------------------------------------------------------------------------

def _thread(cur, client_id: int, contact: str) -> Optional[Dict[str, Any]]:
    cur.execute("SELECT message_id, subject, refs FROM " + portal_db._q(THREADS_TABLE) +
                " WHERE client_id = %s AND contact_id = %s", (client_id, contact))
    rows = portal_db.rows(cur)
    return rows[0] if rows else None


def _save_thread(cur, client_id: int, contact: str, message_id: str, subject: str,
                 refs: List[str]) -> None:
    joined = " ".join(dict.fromkeys(r for r in refs if r))[-2000:]
    cur.execute(
        "INSERT INTO " + portal_db._q(THREADS_TABLE) +
        " (client_id, contact_id, message_id, subject, refs) VALUES (%s, %s, %s, %s, %s)"
        " ON CONFLICT (client_id, contact_id) DO UPDATE SET"
        " message_id = CASE WHEN EXCLUDED.message_id = '' THEN "
        + portal_db._q(THREADS_TABLE) + ".message_id ELSE EXCLUDED.message_id END,"
        " subject = CASE WHEN EXCLUDED.subject = '' THEN "
        + portal_db._q(THREADS_TABLE) + ".subject ELSE EXCLUDED.subject END,"
        " refs = EXCLUDED.refs, updated_at = NOW()",
        (client_id, contact, message_id, subject, joined))


def _ingest(client_id: int, items: List[Dict[str, Any]]) -> int:
    return portal_cp_outbox.ingest(client_id, CHANNEL, "email_channel", items)


def refusal(item: Dict[str, Any]) -> str:
    """Why this reply can never be sent by email ("" = send). Final."""
    payload = item["payload"]
    if item["action"] not in TEXT_ACTIONS:
        return "Email replies support text messages only."
    contact = str(payload.get("external_user_id") or "")
    import portal_identity

    if not contact.startswith(PREFIX) or not portal_identity.normalize_email(contact[3:]):
        return "This contact has no valid email address."
    if not str(payload.get("body") or "").strip():
        return "The reply is empty."
    return ""


def _send_all(conn, cur, client_id: int, account: Dict[str, Any],
              result: Dict[str, Any]) -> None:
    pending = portal_cp_outbox.pending(cur, client_id, CHANNEL, PREFIX, MAX_SEND_PER_RUN)
    conn.commit()
    server = None
    sent_records: List[Dict[str, Any]] = []
    try:
        for item in pending:
            reason = refusal(item)
            if reason:
                portal_cp_outbox.refuse(cur, client_id, CHANNEL, item, reason)
                conn.commit()
                result["refused"] += 1
                continue
            payload = item["payload"]
            contact = str(payload["external_user_id"])
            if server is None:
                server = open_smtp(account)
            thread = _thread(cur, client_id, contact)
            message = build_reply(account, contact[3:], str(payload["body"]).strip(),
                                  thread, str(payload.get("source") or "") not in HUMAN_SOURCES)
            try:
                server.send_message(message)
            except smtplib.SMTPRecipientsRefused:
                portal_cp_outbox.refuse(cur, client_id, CHANNEL, item,
                                        "The recipient address was rejected by the mail server.")
                conn.commit()
                result["refused"] += 1
                continue
            except Exception as error:
                portal_cp_outbox.retry(cur, client_id, CHANNEL, item,
                                       "Email send failed (" + type(error).__name__ + ").")
                conn.commit()
                result["failed"] += 1
                _close_smtp(server)
                server = None
                continue
            msgid = str(message["Message-ID"])
            portal_cp_outbox.sent(cur, client_id, CHANNEL, item, "Email sent.", msgid)
            refs = str((thread or {}).get("refs") or "").split() + [msgid]
            _save_thread(cur, client_id, contact, "", "", refs)
            cur.execute("UPDATE " + portal_db._q(SETTINGS_TABLE) +
                        " SET sent_count = sent_count + 1 WHERE client_id = %s", (client_id,))
            conn.commit()
            result["sent"] += 1
            sent_records.append({"from": contact, "body": str(payload["body"]).strip(),
                                 "direction": "out", "channel": CHANNEL,
                                 "id": "email-out:" + msgid, "provider": "email_smtp"})
    finally:
        if server is not None:
            _close_smtp(server)
        # the conversation shows the sent reply, like the WhatsApp bridge
        portal_cp_outbox.record_sent(client_id, CHANNEL, "email_channel", sent_records)


def _import_new(conn, cur, client_id: int, account: Dict[str, Any],
                result: Dict[str, Any]) -> None:
    box = open_imap(account)
    try:
        validity, uidnext = mailbox_state(box)
        last_uid = account.get("last_uid")
        if last_uid is None or account.get("uid_validity") != validity:
            # start at the end of the mailbox: old mail is never imported
            cur.execute("UPDATE " + portal_db._q(SETTINGS_TABLE) +
                        " SET uid_validity = %s, last_uid = %s WHERE client_id = %s",
                        (validity, max(0, uidnext - 1), client_id))
            conn.commit()
            return
        if uidnext - 1 <= int(last_uid):
            return
        fetched = fetch_new(box, int(last_uid))
    finally:
        _close_imap(box)
    own = str(account.get("address") or "")
    items, threads, top = [], [], int(last_uid)
    for uid, size, raw in fetched:
        top = max(top, uid)
        parsed = parse_email(raw, own)
        if parsed["skip"]:
            result["skipped"] += 1
            continue
        body = parsed["body"]
        if size > MAX_BYTES:
            body = (body + "\n[This email was shortened - open it in the mailbox"
                    " for the full message.]")[:MAX_TEXT + 200]
        contact = PREFIX + parsed["sender"]
        items.append({"from": contact, "name": parsed["name"] or None, "body": body,
                      "direction": "in", "channel": CHANNEL, "provider": "email_imap",
                      "id": "email:" + (parsed["message_id"]
                                        or "uid:%d:%d" % (validity, uid))})
        threads.append((contact, parsed["message_id"], parsed["subject"],
                        parsed["refs"] + [parsed["message_id"]]))
    if items:
        # rate limited / storage down -> the cursor stays; the same emails
        # are read again next time and Message-ID dedupe keeps them single
        import connector_api

        try:
            _ingest(client_id, items)
        except connector_api.IngestRateLimited:
            raise EmailError("Too many new messages at once - the rest are"
                             " imported on the next check.")
    for contact, message_id, subject, refs in threads:
        _save_thread(cur, client_id, contact, message_id, subject, refs)
    cur.execute("UPDATE " + portal_db._q(SETTINGS_TABLE) +
                " SET last_uid = %s, imported_count = imported_count + %s"
                " WHERE client_id = %s AND uid_validity = %s",
                (top, len(items), client_id, validity))
    conn.commit()
    result["imported"] += len(items)


def run(client_id: int, manual: bool = False) -> Dict[str, Any]:
    """Send queued email replies, then import new mail. Never raises."""
    result: Dict[str, Any] = {"ran": False, "reason": "", "sent": 0, "failed": 0,
                              "refused": 0, "imported": 0, "skipped": 0, "error": ""}
    if not ENABLED:
        result["reason"] = "off"
        return result
    conn = None
    locked = False
    try:
        conn = portal_db._conn()
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            conn.commit()  # tables stay even when this run rolls back
            account = load_account(cur, client_id)
            if not account or account.get("enabled") is not True \
                    or account.get("verified_at") is None:
                conn.rollback()
                result["reason"] = "not_connected"
                return result
            cur.execute("SELECT pg_try_advisory_lock(%s, %s) AS ok",
                        (LOCK_CLASS, client_id % 2147483647))
            row = cur.fetchone()
            locked = bool(row.get("ok") if isinstance(row, dict) else (row and row[0]))
            conn.commit()
            if not locked:
                result["reason"] = "busy"
                return result
            if not manual:
                cur.execute("SELECT 1 AS hit FROM " + portal_db._q(SETTINGS_TABLE) +
                            " WHERE client_id = %s AND last_poll_at > NOW()"
                            " - (%s * INTERVAL '1 second')", (client_id, POLL_SECONDS))
                if portal_db.rows(cur):
                    conn.rollback()
                    result["reason"] = "recent"
                    return result
            cur.execute("UPDATE " + portal_db._q(SETTINGS_TABLE) +
                        " SET last_poll_at = NOW() WHERE client_id = %s", (client_id,))
            conn.commit()
            result["ran"] = True
            problem = ""
            for step in (_send_all, _import_new):
                try:
                    step(conn, cur, client_id, account, result)
                except EmailError as error:
                    conn.rollback()
                    problem = problem or str(error)
                except Exception as error:
                    conn.rollback()
                    logger.warning("email channel %s failed: %s", step.__name__, error)
                    problem = problem or "Email check failed - try again shortly."
            result["error"] = problem
            cur.execute("UPDATE " + portal_db._q(SETTINGS_TABLE) +
                        " SET last_error = %s, last_ok_at = CASE WHEN %s = '' THEN NOW()"
                        " ELSE last_ok_at END WHERE client_id = %s",
                        (problem[:500], problem, client_id))
            conn.commit()
    except Exception as error:
        logger.warning("email channel run failed: %s", error)
        result["reason"] = result["reason"] or "unavailable"
        result["error"] = result["error"] or "Email check failed - try again shortly."
    finally:
        if conn is not None:
            try:
                if locked:
                    conn.rollback()
                    with conn.cursor() as cur:
                        cur.execute("SELECT pg_advisory_unlock(%s, %s)",
                                    (LOCK_CLASS, client_id % 2147483647))
                    conn.commit()
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass
    return result


def _job(client_id: int) -> None:
    try:
        run(client_id)
    finally:
        with _LOCK:
            _RUNNING.discard(client_id)


def kick(client_id: Any) -> bool:
    """Tick hook (connector poll, inbox list): start a background run for
    the workspace at most once per OF_EMAIL_POLL_SECONDS per process, one
    at a time (run() re-checks last_poll_at in the database). True = started."""
    if not ENABLED:
        return False
    try:
        client_id = int(client_id or 0)
    except Exception:
        return False
    if client_id <= 0:
        return False
    now = time.monotonic()
    with _LOCK:
        if client_id in _RUNNING or now - _LAST.get(client_id, -1e18) < POLL_SECONDS:
            return False
        _RUNNING.add(client_id)
        _LAST[client_id] = now
    try:
        threading.Thread(target=_job, args=(client_id,),
                         name="email-" + str(client_id), daemon=True).start()
    except Exception:
        with _LOCK:
            _RUNNING.discard(client_id)
        return False
    return True


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

URL = "/channels/email"
DOWN = {"error": {"code": "portal_unavailable",
                  "message": "The email channel is unavailable right now."}}


def _human_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": str(error)}}), 503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}), 401)
    forbidden = ensure_human_principal(principal)
    if forbidden:
        return None, forbidden
    return principal, None


def _can_edit(principal: Dict[str, Any]) -> bool:
    import portal_notify

    return portal_notify.can_edit(principal)


def _forbidden():
    return jsonify({"error": {"code": "forbidden",
                              "message": "Only owners and admins can change the email channel."}}), 403


def _log(cur, conn, client_id: int, principal: Dict[str, Any], note: str) -> None:
    try:
        with portal_txn.savepoint(cur, conn, "of_email_log"):
            portal_db.log_action(cur, client_id, "settings.email_channel", "user",
                                 principal.get("user_id"), None, note)
    except Exception as error:
        logger.info("email channel audit skipped: %s", error)


def _state(account: Optional[Dict[str, Any]], principal: Dict[str, Any]) -> Dict[str, Any]:
    out = public_settings(account)
    out.update({"available": ENABLED, "can_edit": _can_edit(principal),
                "poll_seconds": POLL_SECONDS})
    return out


@bp.get(URL)
def get_email_channel():
    principal, error = _human_or_error()
    if error:
        return error
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regclass(%s) AS t", (SETTINGS_TABLE,))
                found = portal_db.rows(cur)
                account = load_account(cur, int(principal["client_id"])) \
                    if found and found[0].get("t") else None
        finally:
            conn.close()
    except Exception as error:
        logger.warning("email channel read failed: %s", error)
        return jsonify(DOWN), 503
    return jsonify(_state(account, principal)), 200


@bp.put(URL)
def save_email_channel():
    principal, error = _human_or_error()
    if error:
        return error
    if not _can_edit(principal):
        return _forbidden()
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": {"code": "bad_request",
                                  "message": "Send the mailbox settings as a JSON object."}}), 400
    client_id = int(principal["client_id"])
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                conn.commit()
                existing = load_account(cur, client_id)
                clean, problem = clean_settings(payload, existing)
                if problem:
                    conn.rollback()
                    return jsonify({"error": {"code": "bad_request", "message": problem}}), 400
                reset = clean["credentials_changed"]
                cur.execute(
                    "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                    " (client_id, enabled, address, display_name, username, password,"
                    " imap_host, imap_port, smtp_host, smtp_port)"
                    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
                    " ON CONFLICT (client_id) DO UPDATE SET enabled = EXCLUDED.enabled,"
                    " address = EXCLUDED.address, display_name = EXCLUDED.display_name,"
                    " username = EXCLUDED.username, password = EXCLUDED.password,"
                    " imap_host = EXCLUDED.imap_host, imap_port = EXCLUDED.imap_port,"
                    " smtp_host = EXCLUDED.smtp_host, smtp_port = EXCLUDED.smtp_port,"
                    " updated_at = NOW()",
                    (client_id, clean["enabled"], clean["address"], clean["display_name"],
                     clean["username"], portal_vault.seal(clean["password"]),
                     clean["imap_host"], clean["imap_port"], clean["smtp_host"],
                     clean["smtp_port"]))
                if reset:
                    # new credentials: test again; a new mailbox starts at its end
                    cur.execute("UPDATE " + portal_db._q(SETTINGS_TABLE) +
                                " SET verified_at = NULL, enabled = FALSE, last_error = '',"
                                " uid_validity = NULL, last_uid = NULL WHERE client_id = %s",
                                (client_id,))
                _log(cur, conn, client_id, principal,
                     "Email channel " + ("on" if clean["enabled"] else "off")
                     + " (" + clean["address"] + ").")
                conn.commit()
                account = load_account(cur, client_id)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("email channel save failed: %s", error)
        return jsonify(DOWN), 503
    return jsonify(_state(account, principal)), 200


@bp.post(URL + "/test")
def test_email_channel():
    """Sign in to IMAP and SMTP with the saved settings (nothing is sent).
    Passing turns the channel on and starts the cursor at the mailbox end."""
    principal, error = _human_or_error()
    if error:
        return error
    if not _can_edit(principal):
        return _forbidden()
    client_id = int(principal["client_id"])
    try:
        conn = portal_db._conn()
        try:
            with conn.cursor() as cur:
                _ensure_ddl(cur)
                conn.commit()
                account = load_account(cur, client_id)
                conn.rollback()
                if not account or not account.get("password"):
                    return jsonify({"error": {"code": "not_configured",
                                              "message": "Save the mailbox settings first."}}), 409
                problem, validity, uidnext = "", None, None
                try:
                    box = open_imap(account)
                    try:
                        validity, uidnext = mailbox_state(box)
                    finally:
                        _close_imap(box)
                    _close_smtp(open_smtp(account))
                except EmailError as failure:
                    problem = str(failure)
                if problem:
                    cur.execute("UPDATE " + portal_db._q(SETTINGS_TABLE) +
                                " SET last_error = %s WHERE client_id = %s",
                                (problem[:500], client_id))
                    conn.commit()
                    return jsonify({"error": {"code": "provider_error", "message": problem}}), 400
                same_box = account.get("uid_validity") == validity \
                    and account.get("last_uid") is not None
                cur.execute("UPDATE " + portal_db._q(SETTINGS_TABLE) +
                            " SET verified_at = NOW(), enabled = TRUE, last_error = '',"
                            " uid_validity = %s, last_uid = %s WHERE client_id = %s",
                            (validity, account.get("last_uid") if same_box
                             else max(0, int(uidnext) - 1), client_id))
                _log(cur, conn, client_id, principal,
                     "Email channel connected (" + str(account["address"]) + ").")
                conn.commit()
                account = load_account(cur, client_id)
        finally:
            conn.close()
    except Exception as error:
        logger.warning("email channel test failed: %s", error)
        return jsonify(DOWN), 503
    return jsonify(dict(_state(account, principal), ok=True)), 200


@bp.post(URL + "/sync")
def sync_email_channel():
    """"Check now": send queued replies and import new mail immediately."""
    principal, error = _human_or_error()
    if error:
        return error
    result = run(int(principal["client_id"]), manual=True)
    if result["reason"] == "unavailable":
        return jsonify(DOWN), 503
    if result["reason"] == "busy":
        return jsonify({"error": {"code": "busy",
                                  "message": "A check is already running - try again in a moment."}}), 409
    if result["reason"] in ("off", "not_connected"):
        return jsonify({"error": {"code": "not_configured",
                                  "message": "Connect the mailbox first (Test connection)."}}), 409
    return jsonify(result), 200
