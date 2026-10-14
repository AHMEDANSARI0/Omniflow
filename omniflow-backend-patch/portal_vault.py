"""Secrets vault - stored provider credentials encrypted at rest (§223).

Every credential the platform keeps in the database (admin-panel provider
keys in ``platform_settings`` plus each workspace's Instagram, WATI,
catalog-sync, courier, payment-gateway and webhook-signing secrets) goes
through two calls:

* ``seal(text)``   - before writing. AES-256-GCM, random 96-bit nonce,
  stored as ``ofv1:<key id>:<base64url(nonce + ciphertext + tag)>``.
* ``unseal(text)`` - after reading. Plain (legacy) values pass through
  unchanged, so existing rows keep working until they are re-sealed.

Key: ``OF_SECRETS_KEY`` (Control Plane environment only - never the
database or the admin panel, same law as the service key: a key stored
next to the data it protects protects nothing). At least 32 characters;
the AES key is derived with HKDF-SHA256. Rotation: move the previous key to
``OF_SECRETS_KEY_OLD`` (comma separated for several), set the new key,
then run "Encrypt stored secrets" in the admin panel - old ciphertext is
re-sealed under the new key.

Fail-soft, never lock out:
* no key / key too short / ``cryptography`` missing -> ``seal`` stores the
  value as-is (exactly the pre-§223 behaviour) and the admin card says why;
* a sealed value that cannot be opened (key lost or changed without
  ``OF_SECRETS_KEY_OLD``) -> ``unseal`` returns "" so the integration reads
  as "not configured" instead of sending ciphertext to a provider, and the
  admin card counts it as unreadable.

Standard library + the lazily imported ``cryptography`` package only.
"""

import base64
import hashlib
import logging
import os
import threading
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("omniflow.vault")

PREFIX = "ofv1:"
MIN_KEY_CHARS = 32
NONCE_BYTES = 12
AAD = b"omniflow-vault:v1"
_HKDF_SALT = b"omniflow-secrets-vault"
_HKDF_INFO = b"aes-256-gcm:v1"

# Platform-settings names that are credentials (mirrors the admin mask).
SECRET_HINTS = ("password", "api_key", "token", "secret")
EXPLICIT_SECRETS = ("payments.secret_key", "payments.webhook_secret",
                    "payments.publishable_key")

# Workspace tables that hold credentials: (label, table, pk columns,
# secret columns). Instagram verify_token is deliberately NOT here: Meta
# sends it in the webhook URL and the webhook looks the tenant up by it.
TABLE_FIELDS: Tuple[Tuple[str, str, Tuple[str, ...], Tuple[str, ...]], ...] = (
    ("Instagram", os.environ.get("OF_INSTAGRAM_TABLE",
                                 "portal_instagram_accounts"), ("client_id",),
     ("app_secret", "access_token")),
    ("WATI", "portal_wati_settings", ("client_id",), ("api_token",)),
    ("Catalog sync", "portal_catalog_sync", ("client_id",),
     ("api_key", "api_secret")),
    ("Courier (Leopards)", "portal_courier_settings", ("client_id",),
     ("api_key", "api_password")),
    ("Courier companies", "portal_courier_providers", ("id",),
     ("api_key", "api_secret")),
    ("Payment gateway", "portal_payment_settings", ("client_id",),
     ("password", "salt")),
    ("Webhook signing", "portal_webhooks", ("id",), ("secret",)),
)
PLATFORM_TABLE = "platform_settings"

_lock = threading.Lock()
_key_cache: Dict[str, Tuple[bytes, str]] = {}
_warned = set()


def _env(name: str) -> str:
    return str(os.environ.get(name, "") or "").strip()


def _aesgcm():
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        return AESGCM
    except Exception:
        return None


def _derive(material: str) -> Tuple[bytes, str]:
    """(32-byte AES key, 8-hex key id) for one configured key string."""
    with _lock:
        hit = _key_cache.get(material)
        if hit is not None:
            return hit
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF
        key = HKDF(algorithm=hashes.SHA256(), length=32, salt=_HKDF_SALT,
                   info=_HKDF_INFO).derive(material.encode("utf-8"))
    except Exception:
        raise RuntimeError("cryptography unavailable")
    kid = hashlib.sha256(b"kid:" + key).hexdigest()[:8]
    with _lock:
        _key_cache[material] = (key, kid)
    return key, kid


def _problem() -> str:
    if _aesgcm() is None:
        return "library_missing"
    current = _env("OF_SECRETS_KEY")
    if not current:
        return "key_missing"
    if len(current) < MIN_KEY_CHARS:
        return "key_too_short"
    return ""


def _current() -> Optional[Tuple[bytes, str]]:
    if _problem():
        return None
    try:
        return _derive(_env("OF_SECRETS_KEY"))
    except Exception:
        return None


def _all_keys() -> Dict[str, bytes]:
    """key id -> AES key for the current key and every OF_SECRETS_KEY_OLD."""
    out: Dict[str, bytes] = {}
    if _aesgcm() is None:
        return out
    materials = [_env("OF_SECRETS_KEY")]
    materials += [p.strip() for p in _env("OF_SECRETS_KEY_OLD").split(",")]
    for material in materials:
        if len(material) >= MIN_KEY_CHARS:
            try:
                key, kid = _derive(material)
            except Exception:
                continue
            out.setdefault(kid, key)
    return out


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def is_sealed(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def key_id_of(value: Any) -> str:
    if not is_sealed(value):
        return ""
    parts = str(value).split(":", 2)
    return parts[1] if len(parts) == 3 else ""


def seal(value: Any) -> str:
    """Encrypt one credential for storage. "" stays ""; already-sealed
    values are returned unchanged; without a usable key the value is
    stored as-is (pre-§223 behaviour, reported by status())."""
    text = "" if value is None else str(value)
    if not text or is_sealed(text):
        return text
    current = _current()
    if current is None:
        return text
    key, kid = current
    nonce = os.urandom(NONCE_BYTES)
    sealed = _aesgcm()(key).encrypt(nonce, text.encode("utf-8"), AAD)
    return PREFIX + kid + ":" + _b64e(nonce + sealed)


def unseal(value: Any) -> str:
    """Plain text for one stored credential ("" when it cannot be opened)."""
    text = "" if value is None else str(value)
    if not is_sealed(text):
        return text
    parts = text.split(":", 2)
    if len(parts) != 3:
        return ""
    key = _all_keys().get(parts[1])
    if key is None:
        if parts[1] not in _warned:
            _warned.add(parts[1])
            logger.warning("vault: no key for sealed value (key id %s) -"
                           " set OF_SECRETS_KEY / OF_SECRETS_KEY_OLD",
                           parts[1])
        return ""
    try:
        raw = _b64d(parts[2])
        plain = _aesgcm()(key).decrypt(raw[:NONCE_BYTES], raw[NONCE_BYTES:],
                                       AAD)
        return plain.decode("utf-8")
    except Exception:
        logger.warning("vault: sealed value failed authentication (key id"
                       " %s)", parts[1])
        return ""


def unseal_fields(row: Optional[Dict[str, Any]], fields) -> Optional[Dict[str, Any]]:
    """Copy of a DB row with the named credential columns opened."""
    if row is None:
        return None
    out = dict(row)
    for name in fields:
        if name in out:
            out[name] = unseal(out.get(name))
    return out


def is_secret_setting(key: str) -> bool:
    """True for platform_settings keys ("group.name") that are credentials."""
    key = str(key or "")
    if key in EXPLICIT_SECRETS:
        return True
    name = key.split(".", 1)[1] if "." in key else key
    return any(hint in name for hint in SECRET_HINTS)


def status() -> Dict[str, Any]:
    current = _current()
    old_ids = []
    if _aesgcm() is not None:
        for material in _env("OF_SECRETS_KEY_OLD").split(","):
            material = material.strip()
            if len(material) >= MIN_KEY_CHARS:
                try:
                    old_ids.append(_derive(material)[1])
                except Exception:
                    pass
    return {
        "library": _aesgcm() is not None,
        "configured": current is not None,
        "key_id": current[1] if current else "",
        "old_key_ids": old_ids,
        "problem": _problem(),
        "min_key_chars": MIN_KEY_CHARS,
        "algorithm": "AES-256-GCM",
    }


# ---------------------------------------------------------------------------
# Inventory + migration (admin "Encrypt stored secrets")
# ---------------------------------------------------------------------------

def _classify(value: str, current_kid: str, known: Dict[str, bytes]) -> str:
    if not value:
        return "empty"
    if not is_sealed(value):
        return "plain"
    kid = key_id_of(value)
    if kid and kid == current_kid:
        return "sealed"
    if kid in known:
        return "old_key"
    return "unreadable"


def _table_exists(cur, table: str) -> bool:
    cur.execute("SELECT to_regclass(%s) AS reg", (table,))
    rows = cur.fetchall()
    return bool(rows and rows[0][0])


def _rows(cur) -> List[Dict[str, Any]]:
    if cur.description is None:
        return []
    keys = [d[0] for d in cur.description]
    return [dict(zip(keys, r)) for r in cur.fetchall()]


def scan(cur, migrate: bool = False, limit: int = 0) -> Dict[str, Any]:
    """Count (and optionally re-seal) every stored credential.

    Plain values and values sealed under an OF_SECRETS_KEY_OLD key are
    re-sealed under the current key when ``migrate`` is set. Each table runs
    behind a SAVEPOINT so one broken table never aborts the rest. Updates
    are optimistic (``WHERE col = <value read>``) so a concurrent save is
    never overwritten. Values are never returned - only counts.
    """
    limit = limit or int(_env("OF_VAULT_MIGRATE_MAX") or 5000)
    current = _current()
    current_kid = current[1] if current else ""
    known = _all_keys()
    can_write = migrate and current is not None
    areas: List[Dict[str, Any]] = []
    totals = {"plain": 0, "sealed": 0, "old_key": 0, "unreadable": 0,
              "resealed": 0}
    budget = [max(1, limit)]

    def run_area(label, table, pks, columns, select_sql, where_extra=None):
        area = {"label": label, "table": table, "present": False,
                "plain": 0, "sealed": 0, "old_key": 0, "unreadable": 0,
                "resealed": 0, "error": ""}
        cur.execute("SAVEPOINT of_vault_scan")
        try:
            if not _table_exists(cur, table):
                cur.execute("RELEASE SAVEPOINT of_vault_scan")
                areas.append(area)
                return
            area["present"] = True
            cur.execute(select_sql)
            for row in _rows(cur):
                if where_extra is not None and not where_extra(row):
                    continue
                for col in columns:
                    value = str(row.get(col) or "")
                    kind = _classify(value, current_kid, known)
                    if kind == "empty":
                        continue
                    area[kind] += 1
                    if not can_write or kind not in ("plain", "old_key"):
                        continue
                    if budget[0] <= 0:
                        continue
                    plain = value if kind == "plain" else unseal(value)
                    if not plain:
                        continue
                    sealed_value = seal(plain)
                    if not is_sealed(sealed_value):
                        continue
                    where = " AND ".join(pk + " = %s" for pk in pks)
                    cur.execute(
                        "UPDATE " + table + " SET " + col + " = %s WHERE "
                        + where + " AND " + col + " = %s",
                        (sealed_value,) + tuple(row[pk] for pk in pks)
                        + (value,),
                    )
                    if int(getattr(cur, "rowcount", 0) or 0) > 0:
                        area["resealed"] += 1
                        area[kind] -= 1
                        area["sealed"] += 1
                        budget[0] -= 1
            cur.execute("RELEASE SAVEPOINT of_vault_scan")
        except Exception as error:
            cur.execute("ROLLBACK TO SAVEPOINT of_vault_scan")
            # updates were rolled back: report no counts rather than stale ones
            area["error"] = type(error).__name__
            for name in ("plain", "sealed", "old_key", "unreadable", "resealed"):
                area[name] = 0
        areas.append(area)

    run_area("Platform provider keys", PLATFORM_TABLE, ("key",), ("value",),
             "SELECT key, value FROM " + PLATFORM_TABLE
             + " WHERE value <> '' ORDER BY key",
             where_extra=lambda row: is_secret_setting(str(row.get("key"))))
    for label, table, pks, columns in TABLE_FIELDS:
        run_area(label, table, pks, columns,
                 "SELECT " + ", ".join(pks + columns) + " FROM " + table
                 + " ORDER BY " + ", ".join(pks))
    for area in areas:
        for name in totals:
            totals[name] += int(area.get(name) or 0)
    return {"status": status(), "areas": areas, "totals": totals,
            "migrated": bool(can_write),
            "remaining": totals["plain"] + totals["old_key"]}
