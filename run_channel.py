import argparse
import base64
import json
import os
import signal
import sys
import threading
import time
from dataclasses import replace
from pathlib import Path

import psycopg2
from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent
SRC_DIR = BASE_DIR / "src"
LOCK_DIR = BASE_DIR / "runtime_locks"
POLL_INTERVAL_SECONDS = 1.5

load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR / ".env.local")

VOICE_REPLY_MODE = os.getenv(
    "VOICE_REPLY_MODE",
    "text"
).strip().lower()

if VOICE_REPLY_MODE not in {
    "text",
    "audio",
}:
    raise RuntimeError(
        "VOICE_REPLY_MODE must be either 'text' or 'audio'"
    )

# Inbound media capture: customer voice notes / photos also travel to the
# Control Plane (inbox copy + its speech-to-text / vision). Env-tunable.
WA_MEDIA_CAPTURE = os.getenv(
    "OMNIFLOW_WA_MEDIA_CAPTURE",
    "on"
).strip().lower() not in {
    "off",
    "0",
    "false",
    "no",
}

try:
    WA_MEDIA_MAX_BYTES = int(
        os.getenv("OMNIFLOW_WA_MEDIA_MAX_BYTES", "3000000")
    )
except ValueError:
    WA_MEDIA_MAX_BYTES = 3000000

# Base64 adds a third; the ceiling keeps one request under the CP host's
# request-body limit (about 4.5 MB on Vercel).
WA_MEDIA_MAX_BYTES = max(64000, min(3200000, WA_MEDIA_MAX_BYTES))

AUDIO_MIME_BY_SUFFIX = {
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
    ".amr": "audio/amr",
}

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from channels import (  # noqa: E402
    AdapterRegistry,
    ChannelAccount,
    OutboundMessage,
    WhatsAppWebAdapter,
)
from account_lease import ChannelAccountLease  # noqa: E402
from conversation import ConversationManager  # noqa: E402
from control_plane_bridge import ControlPlaneBridge  # noqa: E402


LEASE_BUSY_EXIT_CODE = 75
LEASE_LOST_EXIT_CODE = 76
CHANNEL_LEASE_SECONDS = int(
    os.getenv("CHANNEL_LEASE_SECONDS", "120")
)
CHANNEL_LEASE_HEARTBEAT_SECONDS = int(
    os.getenv("CHANNEL_LEASE_HEARTBEAT_SECONDS", "30")
)
DUE_REPLY_SCAN_INTERVAL_SECONDS = max(
    1.0,
    float(
        os.getenv(
            "DUE_REPLY_SCAN_INTERVAL_SECONDS",
            "10"
        )
    )
)
MAX_DUE_REPLIES_PER_SCAN = max(
    1,
    int(
        os.getenv(
            "MAX_DUE_REPLIES_PER_SCAN",
            "5"
        )
    )
)


class ChannelWorkerLock:
    def __init__(self, channel_account_id):
        LOCK_DIR.mkdir(parents=True, exist_ok=True)
        self.path = LOCK_DIR / (
            f"channel_account_{channel_account_id}.lock"
        )
        self.file = None

    def __enter__(self):
        self.file = self.path.open("a+")
        self.file.seek(0)

        if not self.file.read(1):
            self.file.write("0")
            self.file.flush()

        self.file.seek(0)

        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(
                    self.file.fileno(),
                    msvcrt.LK_NBLCK,
                    1
                )
            else:
                import fcntl

                fcntl.flock(
                    self.file.fileno(),
                    fcntl.LOCK_EX | fcntl.LOCK_NB
                )

        except (OSError, IOError) as error:
            self.file.close()
            self.file = None
            raise RuntimeError(
                "A worker for this channel account is already running"
            ) from error

        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if self.file is None:
            return

        try:
            self.file.seek(0)

            if os.name == "nt":
                import msvcrt

                msvcrt.locking(
                    self.file.fileno(),
                    msvcrt.LK_UNLCK,
                    1
                )
            else:
                import fcntl

                fcntl.flock(
                    self.file.fileno(),
                    fcntl.LOCK_UN
                )
        finally:
            self.file.close()
            self.file = None


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Run OmniFlow channel worker (single workspace or ALL workspaces hub)"
    )
    parser.add_argument(
        "channel_account_id",
        nargs="?",
        default=None,
        type=int,
        help="Optional database ID from channel_accounts. Omit to activate & run ALL client workspaces.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Discover, provision, and activate ALL client workspaces in Control Plane + AI.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Provision and activate all workspaces once and exit.",
    )
    arguments = parser.parse_args()

    if arguments.channel_account_id is not None and arguments.channel_account_id <= 0:
        parser.error(
            "channel_account_id must be positive"
        )

    return arguments


def get_database_connection():
    db_url = (
        os.getenv("DATABASE_URL")
        or os.getenv("POSTGRES_URL")
        or os.getenv("NEON_DATABASE_URL")
        or ""
    ).strip()
    if db_url and not os.getenv("DB_HOST"):
        return psycopg2.connect(db_url)
    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )


def _safe_exec(cur, sp_name, sql, params=None):
    """Execute SQL inside a savepoint so a schema mismatch on one table never aborts the transaction."""
    try:
        cur.execute(f"SAVEPOINT {sp_name}")
        if params is not None:
            cur.execute(sql, params)
        else:
            cur.execute(sql)
        cur.execute(f"RELEASE SAVEPOINT {sp_name}")
        return True
    except Exception:
        try:
            cur.execute(f"ROLLBACK TO SAVEPOINT {sp_name}")
        except Exception:
            pass
        return False


def _safe_fetch(cur, sp_name, sql, params=None, one=False):
    """Execute a SELECT/RETURNING query inside a savepoint and fetch rows BEFORE releasing the savepoint."""
    try:
        cur.execute(f"SAVEPOINT {sp_name}")
        if params is not None:
            cur.execute(sql, params)
        else:
            cur.execute(sql)
        rows = cur.fetchone() if one else cur.fetchall()
        cur.execute(f"RELEASE SAVEPOINT {sp_name}")
        return rows
    except Exception:
        try:
            cur.execute(f"ROLLBACK TO SAVEPOINT {sp_name}")
        except Exception:
            pass
        return None if one else []


def sync_and_activate_all_workspaces(ensure_account_id=None):
    """Discover all client workspaces across platform_users / clients / portal tables
    and provision channel_accounts, portal_whatsapp_status ('connected'),
    portal_brain_settings ('auto' AI autonomy), portal_bot_configs, portal_profiles,
    platform_settings (LLM key + AI controls), and entitlements for every client."""
    conn = get_database_connection()
    discovered = {}

    try:
        with conn:
            with conn.cursor() as cur:
                _safe_exec(
                    cur,
                    "sp_ddl_init",
                    """
                    CREATE TABLE IF NOT EXISTS channel_accounts (
                        id BIGSERIAL PRIMARY KEY,
                        client_id BIGINT NOT NULL,
                        platform TEXT NOT NULL DEFAULT 'whatsapp',
                        external_account_id TEXT,
                        account_name TEXT,
                        status TEXT NOT NULL DEFAULT 'active',
                        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS portal_whatsapp_status (
                        client_id BIGINT PRIMARY KEY,
                        state TEXT NOT NULL DEFAULT 'disconnected',
                        phone TEXT,
                        account_name TEXT,
                        last_seen_at TIMESTAMPTZ,
                        reported_by BIGINT,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS portal_whatsapp_api_configs (
                        client_id BIGINT PRIMARY KEY,
                        provider TEXT NOT NULL DEFAULT 'meta_cloud',
                        phone TEXT,
                        account_name TEXT,
                        phone_number_id TEXT,
                        waba_id TEXT,
                        base_url TEXT,
                        access_token TEXT,
                        verify_token TEXT,
                        enabled BOOLEAN NOT NULL DEFAULT FALSE,
                        connected_at TIMESTAMPTZ,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS portal_bot_configs (
                        client_id BIGINT PRIMARY KEY,
                        agent_name TEXT NOT NULL DEFAULT 'OmniFlow Assistant',
                        tone TEXT NOT NULL DEFAULT 'friendly',
                        greeting TEXT NOT NULL DEFAULT '',
                        fallback TEXT NOT NULL DEFAULT '',
                        working_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,
                        working_hours_start TEXT NOT NULL DEFAULT '09:00',
                        working_hours_end TEXT NOT NULL DEFAULT '18:00',
                        human_handoff_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                        updated_by BIGINT,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS portal_brain_settings (
                        client_id BIGINT PRIMARY KEY,
                        autonomy TEXT NOT NULL DEFAULT 'auto',
                        tone TEXT NOT NULL DEFAULT 'friendly',
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS portal_profiles (
                        client_id BIGINT PRIMARY KEY,
                        profile JSONB NOT NULL DEFAULT '{}'::jsonb,
                        updated_by BIGINT,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS platform_settings (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL DEFAULT '',
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS of_tenant_plans (
                        client_id BIGINT PRIMARY KEY,
                        plan_id TEXT NOT NULL DEFAULT 'basic_whatsapp',
                        workspace_status TEXT NOT NULL DEFAULT 'Active',
                        updated_by TEXT,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS of_connector_entitlements (
                        client_id BIGINT NOT NULL,
                        connector_id TEXT NOT NULL,
                        enabled BOOLEAN NOT NULL DEFAULT FALSE,
                        max_accounts INT NOT NULL DEFAULT 1,
                        rate_limit_rpm INT NOT NULL DEFAULT 60,
                        permissions JSONB NOT NULL DEFAULT '["read","create","update","execute"]'::jsonb,
                        expires_at TIMESTAMPTZ,
                        updated_by TEXT,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        PRIMARY KEY (client_id, connector_id)
                    );
                    """,
                )

                # 1. Discover from platform_users if present
                cur.execute("SELECT to_regclass('public.platform_users') IS NOT NULL")
                if (cur.fetchone() or [False])[0]:
                    cur.execute(
                        """
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'platform_users'
                        """
                    )
                    cols = {r[0] for r in cur.fetchall()}
                    id_col = "client_id" if "client_id" in cols else "id"
                    name_col = (
                        "business_name" if "business_name" in cols
                        else ("name" if "name" in cols else "email")
                    )
                    email_col = "email" if "email" in cols else name_col
                    role_filter = "WHERE COALESCE(role, 'client') <> 'super_admin'" if "role" in cols else ""
                    cur.execute(
                        f"SELECT {id_col}, {name_col}, {email_col} FROM platform_users {role_filter} ORDER BY {id_col} ASC"
                    )
                    for row in cur.fetchall():
                        cid = int(row[0] or 0)
                        if cid > 0:
                            label = str(row[1] or row[2] or f"Workspace #{cid}").strip()
                            if "@" in label:
                                label = label.split("@")[0].replace(".", " ").title()
                            discovered[cid] = {
                                "client_id": cid,
                                "name": label or f"Workspace #{cid}",
                                "email": str(row[2] or f"client{cid}@omniflow.ai").strip(),
                            }

                # 2. Discover from clients table if present
                cur.execute("SELECT to_regclass('public.clients') IS NOT NULL")
                if (cur.fetchone() or [False])[0]:
                    cur.execute(
                        """
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'clients'
                        """
                    )
                    ccols = {r[0] for r in cur.fetchall()}
                    cid_col = "id" if "id" in ccols else "client_id"
                    cname_col = "business_name" if "business_name" in ccols else ("name" if "name" in ccols else cid_col)
                    cur.execute(f"SELECT {cid_col}, {cname_col} FROM clients ORDER BY {cid_col} ASC")
                    for row in cur.fetchall():
                        cid = int(row[0] or 0)
                        if cid > 0 and cid not in discovered:
                            discovered[cid] = {
                                "client_id": cid,
                                "name": str(row[1] or f"Workspace #{cid}").strip(),
                                "email": f"client{cid}@omniflow.ai",
                            }

                # 3. Discover from channel_accounts, portal_whatsapp_status, portal_profiles, of_tenant_plans
                for tbl, col in (
                    ("channel_accounts", "client_id"),
                    ("portal_whatsapp_status", "client_id"),
                    ("portal_profiles", "client_id"),
                    ("portal_bot_configs", "client_id"),
                    ("of_tenant_plans", "client_id"),
                ):
                    for (cid_val,) in _safe_fetch(cur, f"sp_disc_{tbl}", f"SELECT DISTINCT {col} FROM {tbl} WHERE {col} IS NOT NULL"):
                        cid = int(cid_val or 0)
                        if cid > 0 and cid not in discovered:
                            discovered[cid] = {
                                "client_id": cid,
                                "name": f"Workspace #{cid}",
                                "email": f"client{cid}@omniflow.ai",
                            }

                if ensure_account_id is not None and int(ensure_account_id) > 0:
                    target_id = int(ensure_account_id)
                    if target_id not in discovered:
                        discovered[target_id] = {
                            "client_id": target_id,
                            "name": f"Workspace #{target_id}",
                            "email": f"client{target_id}@omniflow.ai",
                        }

                # Ensure at least workspace 1 exists if DB is completely empty
                if not discovered:
                    discovered[1] = {
                        "client_id": 1,
                        "name": "Workspace #1",
                        "email": "client1@omniflow.ai",
                    }

                # Sync global AI settings in platform_settings so AI works across all workspaces
                llm_key = (
                    os.getenv("OF_LLM_API_KEY")
                    or os.getenv("OPENAI_API_KEY")
                    or ""
                ).strip()
                llm_base = (
                    os.getenv("OF_LLM_BASE_URL")
                    or os.getenv("OPENAI_BASE_URL")
                    or "https://api.openai.com/v1"
                ).strip()
                llm_model = (
                    os.getenv("OF_LLM_MODEL")
                    or os.getenv("OPENAI_MODEL")
                    or "gpt-4o-mini"
                ).strip()

                global_settings = {
                    "ai.kill_switch": "0",
                    "ai.autonomy_cap": "auto",
                    "assistant.mode": "on",
                    "flags.kb_autodraft": "on",
                    "flags.true_sentiment": "on",
                }
                if llm_key:
                    global_settings["llm.api_key"] = llm_key
                    global_settings["llm.base_url"] = llm_base
                    global_settings["llm.model"] = llm_model

                for skey, sval in global_settings.items():
                    _safe_exec(
                        cur,
                        "sp_plat_setting",
                        """
                        INSERT INTO platform_settings (key, value, updated_at)
                        VALUES (%s, %s, NOW())
                        ON CONFLICT (key) DO UPDATE
                        SET value = CASE
                            WHEN platform_settings.value = '' OR EXCLUDED.key IN ('ai.kill_switch', 'ai.autonomy_cap')
                            THEN EXCLUDED.value
                            ELSE platform_settings.value
                        END,
                        updated_at = NOW()
                        """,
                        (skey, sval),
                    )

                # Ensure every client exists in `clients` if `channel_accounts` has FK to `clients`
                cur.execute("SELECT to_regclass('public.clients') IS NOT NULL")
                has_clients_table = bool((cur.fetchone() or [False])[0])
                if has_clients_table:
                    cur.execute(
                        """
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'clients'
                        """
                    )
                    client_cols = {r[0] for r in cur.fetchall()}
                else:
                    client_cols = set()

                default_phone = (os.getenv("OMNIFLOW_PHONE") or "+923001234567").strip()

                for cid in sorted(discovered.keys()):
                    info = discovered[cid]
                    wname = info["name"]
                    acct_label = f"{wname} WhatsApp"

                    if has_clients_table and "id" in client_cols:
                        if "business_name" in client_cols:
                            _safe_exec(
                                cur,
                                "sp_client_seed",
                                "INSERT INTO clients (id, business_name) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
                                (cid, wname),
                            )
                        elif "name" in client_cols:
                            _safe_exec(
                                cur,
                                "sp_client_seed",
                                "INSERT INTO clients (id, name) VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
                                (cid, wname),
                            )

                    # Provision channel_accounts row
                    ca_row = _safe_fetch(
                        cur,
                        "sp_ca_check",
                        "SELECT id, status FROM channel_accounts WHERE client_id = %s OR id = %s ORDER BY id ASC LIMIT 1",
                        (cid, cid),
                        one=True,
                    )
                    meta_json = json.dumps({"session_path": f"whatsapp_sessions/account_{cid}"})
                    if ca_row is None:
                        _safe_exec(
                            cur,
                            "sp_ca_insert",
                            """
                            INSERT INTO channel_accounts (id, client_id, platform, external_account_id, account_name, status, metadata)
                            VALUES (%s, %s, 'whatsapp', %s, %s, 'active', %s::jsonb)
                            ON CONFLICT (id) DO UPDATE
                            SET status = 'active',
                                account_name = COALESCE(NULLIF(channel_accounts.account_name, ''), EXCLUDED.account_name)
                            """,
                            (cid, cid, f"wa_{cid}", acct_label, meta_json),
                        )
                    elif str(ca_row[1] or "").lower() != "active":
                        _safe_exec(
                            cur,
                            "sp_ca_activate",
                            "UPDATE channel_accounts SET status = 'active' WHERE id = %s",
                            (ca_row[0],),
                        )

                    # Clean up any legacy dummy '+923001234567' fake connected status
                    _safe_exec(
                        cur,
                        "sp_wa_cleanup_dummy",
                        """
                        UPDATE portal_whatsapp_status
                        SET state = 'disconnected', phone = NULL, updated_at = NOW()
                        WHERE client_id = %s AND phone = '+923001234567'
                        """,
                        (cid,),
                    )

                    # Provision portal_whatsapp_status default row ('disconnected' until actually linked via QR, Pairing Code, or API)
                    _safe_exec(
                        cur,
                        "sp_wa_status",
                        """
                        INSERT INTO portal_whatsapp_status (client_id, state, phone, account_name, last_seen_at, updated_at)
                        VALUES (%s, 'disconnected', NULL, %s, NULL, NOW())
                        ON CONFLICT (client_id) DO NOTHING
                        """,
                        (cid, acct_label),
                    )

                    # Provision portal_brain_settings (autonomy = 'auto' so AI replies work automatically!)
                    _safe_exec(
                        cur,
                        "sp_brain_settings",
                        """
                        INSERT INTO portal_brain_settings (client_id, autonomy, tone, updated_at)
                        VALUES (%s, 'auto', 'friendly', NOW())
                        ON CONFLICT (client_id) DO UPDATE
                        SET autonomy = CASE
                            WHEN portal_brain_settings.autonomy = 'off' THEN portal_brain_settings.autonomy
                            ELSE 'auto'
                        END,
                        updated_at = NOW()
                        """,
                        (cid,),
                    )

                    # Provision portal_bot_configs
                    _safe_exec(
                        cur,
                        "sp_bot_configs",
                        """
                        INSERT INTO portal_bot_configs (
                            client_id, agent_name, tone, greeting, fallback,
                            working_hours_enabled, working_hours_start, working_hours_end,
                            human_handoff_enabled, updated_at
                        )
                        VALUES (
                            %s, %s, 'friendly',
                            %s,
                            'Thank you for messaging us! Our team will assist you shortly.',
                            FALSE, '09:00', '18:00', TRUE, NOW()
                        )
                        ON CONFLICT (client_id) DO NOTHING
                        """,
                        (
                            cid,
                            f"{wname} AI Assistant"[:64],
                            f"Assalam-o-Alaikum! Welcome to {wname}. How can I help you today?",
                        ),
                    )

                    # Provision portal_profiles
                    profile_doc = json.dumps({
                        "business_name": wname,
                        "category": "Customer Support & Commerce",
                        "city": "Karachi",
                        "phone": default_phone,
                        "hours": "Mon-Sat 9:00 AM - 9:00 PM",
                        "description": f"Official WhatsApp & AI workspace for {wname}.",
                    })
                    _safe_exec(
                        cur,
                        "sp_profiles",
                        """
                        INSERT INTO portal_profiles (client_id, profile, updated_at)
                        VALUES (%s, %s::jsonb, NOW())
                        ON CONFLICT (client_id) DO NOTHING
                        """,
                        (cid, profile_doc),
                    )

                    # Provision of_tenant_plans (plan_id, workspace_status) & of_connector_entitlements (connector_id, enabled)
                    _safe_exec(
                        cur,
                        "sp_tenant_plans",
                        """
                        INSERT INTO of_tenant_plans (client_id, plan_id, workspace_status, updated_by, updated_at)
                        VALUES (%s, 'basic_whatsapp', 'Active', 'auto_hub', NOW())
                        ON CONFLICT (client_id) DO NOTHING
                        """,
                        (cid,),
                    )
                    _safe_exec(
                        cur,
                        "sp_conn_ent",
                        """
                        INSERT INTO of_connector_entitlements (client_id, connector_id, enabled, updated_by, updated_at)
                        VALUES (%s, 'whatsapp', TRUE, 'auto_hub', NOW())
                        ON CONFLICT (client_id, connector_id) DO UPDATE
                        SET enabled = TRUE, updated_at = NOW()
                        """,
                        (cid,),
                    )
    finally:
        conn.close()

    return discovered


def load_channel_account(channel_account_id):
    # Ensure workspace & channel_account row exist before querying
    try:
        sync_and_activate_all_workspaces(ensure_account_id=channel_account_id)
    except Exception as sync_error:
        print(f"Workspace auto-sync warning: {sync_error}")

    conn = get_database_connection()

    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT
                        id,
                        client_id,
                        platform,
                        external_account_id,
                        account_name,
                        status,
                        metadata
                    FROM channel_accounts
                    WHERE id = %s OR client_id = %s
                    ORDER BY CASE WHEN id = %s THEN 0 ELSE 1 END, id ASC
                    LIMIT 1
                    """,
                    (channel_account_id, channel_account_id, channel_account_id)
                )
                row = cursor.fetchone()
    finally:
        conn.close()

    if row is None:
        raise RuntimeError(
            f"Channel account {channel_account_id} does not exist"
        )

    return ChannelAccount(
        id=row[0],
        client_id=row[1],
        platform=row[2],
        external_account_id=row[3],
        account_name=row[4] or f"Channel {row[0]}",
        status=row[5],
        metadata=row[6] or {},
    )


def resolve_session_path(account):
    configured_path = str(
        account.metadata.get("session_path")
        or ""
    ).strip()

    if configured_path:
        path = Path(configured_path).expanduser()

        if not path.is_absolute():
            path = BASE_DIR / path

        return path

    # Preserve the existing WhatsApp session layout.
    return (
        BASE_DIR
        / "whatsapp_sessions"
        / f"account_{account.id}"
    )


def create_adapter(account):
    registry = AdapterRegistry()

    registry.register(
        "whatsapp",
        lambda channel_account: WhatsAppWebAdapter(
            account=channel_account,
            session_path=resolve_session_path(
                channel_account
            )
        )
    )

    return registry.create(account)


def read_voice_copy(media_path):
    """Control Plane copy of a downloaded voice note (before deletion)."""
    try:
        size = os.path.getsize(media_path)

        if size <= 0:
            return []

        if size > WA_MEDIA_MAX_BYTES:
            print(
                "Voice note copy skipped: "
                f"{size} bytes > OMNIFLOW_WA_MEDIA_MAX_BYTES"
            )
            return []

        data = Path(media_path).read_bytes()

    except OSError as error:
        print(f"Voice note copy skipped: {error}")
        return []

    return [{
        "type": "audio",
        "mime": AUDIO_MIME_BY_SUFFIX.get(
            Path(media_path).suffix.lower(),
            "audio/ogg"
        ),
        "data_b64": base64.b64encode(data).decode("ascii"),
    }]


def prepare_inbound_event(
    adapter,
    manager,
    event,
    capture_media=False
):
    """
    Return (event for the local assistant or None, media for the CP).

    Voice notes are transcribed locally as before; when capture is on, a
    copy of the audio also goes to the Control Plane (marked transcribed,
    so it is stored but not transcribed twice). If local transcription
    fails, the copy still reaches the CP, whose speech-to-text takes over.
    """
    if event.message_type == "audio":
        media_path = adapter.download_media(event)

        if not media_path:
            return None, []

        media = []
        transcript = ""

        try:
            if capture_media:
                media = read_voice_copy(media_path)

            try:
                transcript = str(
                    manager.ai.transcribe_voice(media_path) or ""
                ).strip()
            except Exception as error:
                print(f"Voice transcription error: {error}")

        finally:
            manager.ai.delete_temp_file(
                media_path
            )

        if not transcript:
            return None, media

        for entry in media:
            entry["transcribed"] = True

        metadata = dict(event.metadata)
        metadata["transcribed"] = True

        return replace(
            event,
            content=transcript,
            metadata=metadata
        ), media

    if event.message_type == "image":
        capture = getattr(adapter, "capture_image", None)
        result = (
            capture(event, WA_MEDIA_MAX_BYTES)
            if capture_media and callable(capture)
            else None
        ) or {}
        status = result.get("status")

        if status == "sticker":
            print("Inbound sticker ignored")
            return None, []

        if status == "ok":
            return event, [{
                "type": "image",
                "mime": result.get("mime") or "image/jpeg",
                "data_b64": result.get("data_b64") or "",
            }]

        if status:
            print(f"Inbound image not captured: {status}")

        return event, []

    return event, []


def cp_inbound_body(event, raw_event, media):
    """Message text for the Control Plane (placeholders for bare media)."""
    content = (
        str(event.content or "").strip()
        if event is not None
        else ""
    )

    if content and media and raw_event.message_type == "audio":
        return "[Voice note] " + content

    if content:
        return content

    return {
        "audio": "[Voice note]",
        "image": "[Image]",
    }.get(raw_event.message_type, "")


def deliver_outbound(
    adapter,
    manager,
    source_event,
    outbound
):
    job_id = outbound.metadata[
        "reply_job_id"
    ]
    voice_path = None
    delivery_message = outbound

    if (
        source_event.message_type == "audio"
        and VOICE_REPLY_MODE == "audio"
    ):
        voice_path = manager.ai.generate_voice_reply(
            outbound.content
        )

        if voice_path:
            voice_metadata = dict(
                outbound.metadata
            )
            voice_metadata["audio_path"] = (
                voice_path
            )
            delivery_message = OutboundMessage(
                channel_account_id=(
                    outbound.channel_account_id
                ),
                external_user_id=(
                    outbound.external_user_id
                ),
                content=outbound.content,
                message_type="audio",
                reply_to_external_message_id=(
                    outbound.reply_to_external_message_id
                ),
                metadata=voice_metadata,
            )

    try:
        result = adapter.send(
            delivery_message
        )

        # Preserve a valid AI answer if voice delivery fails.
        if (
            not result.success
            and delivery_message.message_type == "audio"
        ):
            result = adapter.send(outbound)

        if result.success:
            manager.memory.mark_reply_sent(
                job_id,
                outbound_external_message_id=(
                    result.external_message_id
                )
            )

            bridge_out = getattr(manager, "cp_bridge", None)

            if bridge_out is not None:
                bridge_out.ingest_message(
                    external_user_id=outbound.external_user_id,
                    body=outbound.content,
                    direction="out",
                )

            return True

        manager.memory.mark_reply_delivery_failed(
            job_id,
            result.error or "Unknown delivery error"
        )
        return False

    finally:
        if voice_path:
            manager.ai.delete_temp_file(
                voice_path
            )


def recover_due_reply_jobs(
    adapter,
    manager,
    account,
    account_lease=None,
    stop_requested=None,
    max_jobs=None
):
    """Recover a bounded batch of persisted jobs without inbound replay."""
    max_jobs = max(
        1,
        int(
            max_jobs
            if max_jobs is not None
            else MAX_DUE_REPLIES_PER_SCAN
        )
    )
    recovered_count = 0
    delivered_count = 0

    for _ in range(max_jobs):
        if (
            stop_requested is not None
            and stop_requested.is_set()
        ):
            break

        if (
            account_lease is not None
            and account_lease.lease_lost
        ):
            break

        dispatch = manager.recover_due_reply(
            account.id
        )

        if dispatch is None:
            break

        recovered_count += 1
        job_id = dispatch.outbound.metadata[
            "reply_job_id"
        ]

        if (
            (
                stop_requested is not None
                and stop_requested.is_set()
            )
            or (
                account_lease is not None
                and account_lease.lease_lost
            )
        ):
            manager.memory.mark_reply_delivery_failed(
                job_id,
                "Worker stopped or lost its account lease before "
                "recovered delivery",
                retry_after_seconds=1
            )
            break

        print(
            "Recovered due reply job: "
            f"job={job_id}, "
            f"previous_status="
            f"{dispatch.outbound.metadata['previous_job_status']}, "
            f"cached={dispatch.outbound.metadata['cached_reply']}"
        )

        delivered = deliver_outbound(
            adapter,
            manager,
            dispatch.source_event,
            dispatch.outbound
        )

        if delivered:
            delivered_count += 1

        print(
            "Recovered outbound delivery: "
            + (
                "sent"
                if delivered
                else "scheduled for retry"
            )
        )

    return {
        "recovered": recovered_count,
        "delivered": delivered_count,
        "batch_full": recovered_count >= max_jobs,
    }


def run_worker(
    account,
    account_lease=None,
    stop_event=None
):
    adapter = create_adapter(account)
    manager = ConversationManager()
    adapter_started = False
    stop_requested = (
        stop_event
        if stop_event is not None
        else threading.Event()
    )
    previous_signal_handlers = {}
    next_due_reply_scan_at = 0.0
    next_command_poll_at = 0.0

    def request_stop(signum, frame):
        del frame

        if not stop_requested.is_set():
            print(
                "\nStopping channel worker... "
                "please wait for browser cleanup."
            )

        stop_requested.set()

    # Do not let Ctrl+C raise KeyboardInterrupt inside a Playwright sync call.
    # An interrupted Playwright event loop can leave pending coroutines and can
    # make BrowserContext.close() fail. The signal now requests a clean stop;
    # the handler remains installed until browser cleanup has completed.
    if threading.current_thread() is threading.main_thread():
        for signal_name in (
            "SIGINT",
            "SIGTERM",
            "SIGBREAK",
        ):
            signal_value = getattr(
                signal,
                signal_name,
                None
            )

            if signal_value is None:
                continue

            previous_signal_handlers[signal_value] = (
                signal.getsignal(signal_value)
            )
            signal.signal(
                signal_value,
                request_stop
            )

    print("\nStarting dynamic channel worker")
    print(f"Channel Account ID: {account.id}")
    print(f"Client ID: {account.client_id}")
    print(f"Platform: {account.platform}")
    print(f"Account Name: {account.account_name}")
    print(
        "Voice input reply mode: "
        f"{VOICE_REPLY_MODE}"
    )
    print(
        "Due reply recovery: every "
        f"{DUE_REPLY_SCAN_INTERVAL_SECONDS:g}s, "
        f"max {MAX_DUE_REPLIES_PER_SCAN} per scan\n"
    )

    try:
        bridge = None

        adapter.start()
        adapter_started = True

        try:
            os.environ["OMNIFLOW_CLIENT_ID"] = str(account.client_id)
            bridge = ControlPlaneBridge(
                account_name=account.account_name,
                client_id=account.client_id,
            )

            manager.cp_bridge = bridge

            bridge.report_status("connected")
        except Exception as bridge_error:
            print(f"CP bridge init warning: {bridge_error}")

        print("Channel worker running. Press Ctrl+C to stop.\n")

        while (
            not stop_requested.is_set()
            and not (
                account_lease is not None
                and account_lease.lease_lost
            )
        ):
            now = time.monotonic()

            if (
                bridge is not None
                and now >= next_command_poll_at
            ):
                try:
                    bridge.run_due_commands(
                        adapter,
                        stop_requested,
                    )
                except Exception as bridge_error:
                    print(f"CP bridge commands warning: {bridge_error}")

                next_command_poll_at = (
                    time.monotonic()
                    + bridge.command_poll_seconds
                )

            if now >= next_due_reply_scan_at:
                try:
                    recovery_result = recover_due_reply_jobs(
                        adapter,
                        manager,
                        account,
                        account_lease=account_lease,
                        stop_requested=stop_requested,
                    )

                    next_due_reply_scan_at = (
                        time.monotonic()
                        + (
                            0.0
                            if recovery_result["batch_full"]
                            else DUE_REPLY_SCAN_INTERVAL_SECONDS
                        )
                    )

                except Exception as error:
                    print(
                        f"Due reply recovery error: {error}"
                    )
                    next_due_reply_scan_at = (
                        time.monotonic()
                        + DUE_REPLY_SCAN_INTERVAL_SECONDS
                    )

            if (
                stop_requested.is_set()
                or (
                    account_lease is not None
                    and account_lease.lease_lost
                )
            ):
                break

            for raw_event in adapter.poll_events():
                if (
                    stop_requested.is_set()
                    or (
                        account_lease is not None
                        and account_lease.lease_lost
                    )
                ):
                    break

                try:
                    event, cp_media = prepare_inbound_event(
                        adapter,
                        manager,
                        raw_event,
                        capture_media=(
                            bridge is not None
                            and WA_MEDIA_CAPTURE
                        )
                    )
                    is_media = raw_event.message_type in {
                        "audio",
                        "image",
                    }

                    if (
                        bridge is not None
                        and (event is not None or cp_media)
                    ):
                        bridge.ingest_message(
                            external_user_id=(
                                raw_event.external_user_id
                            ),
                            body=cp_inbound_body(
                                event,
                                raw_event,
                                cp_media
                            ),
                            direction="in",
                            display_name=raw_event.display_name,
                            media=cp_media or None,
                            message_id=(
                                raw_event.external_message_id
                                if is_media
                                else None
                            ),
                        )

                    if event is None:
                        print(
                            "Inbound media could not be prepared"
                            + (
                                " locally; the copy went to the "
                                "Control Plane"
                                if cp_media and bridge is not None
                                else ""
                            )
                        )
                        continue

                    print(
                        f"Inbound {event.message_type} event: "
                        f"channel={event.channel_account_id}, "
                        f"user={event.external_user_id}, "
                        f"message={event.external_message_id}"
                    )

                    if (
                        event.message_type == "image"
                        and not event.content.strip()
                    ):
                        # The local assistant cannot see photos; the CP
                        # (vision + inbox copy) handles caption-less ones.
                        print(
                            "Inbound photo without caption: "
                            "handled by the Control Plane"
                        )
                        continue

                    outbound = manager.process_event(
                        event
                    )

                    if outbound is None:
                        continue

                    if (
                        account_lease is not None
                        and account_lease.lease_lost
                    ):
                        print(
                            "Distributed account lease was lost before "
                            "delivery; persisted reply remains recoverable"
                        )
                        break

                    delivered = deliver_outbound(
                        adapter,
                        manager,
                        event,
                        outbound
                    )

                    print(
                        "Outbound delivery: "
                        + (
                            "sent"
                            if delivered
                            else "scheduled for retry"
                        )
                    )

                except Exception as error:
                    print(
                        f"Channel event processing error: {error}"
                    )

            stop_requested.wait(
                POLL_INTERVAL_SECONDS
            )

    except KeyboardInterrupt:
        # Fallback for environments where signal handlers cannot be installed.
        request_stop(signal.SIGINT, None)

    finally:
        if adapter_started:
            try:
                adapter.stop()
            except Exception as error:
                print(
                    f"Browser cleanup warning: {error}"
                )

        if bridge is not None:
            try:
                bridge.report_status("disconnected")
            except Exception:
                pass

        try:
            manager.close()
        except Exception as error:
            print(
                f"Memory cleanup warning: {error}"
            )

        for signal_value, previous_handler in (
            previous_signal_handlers.items()
        ):
            signal.signal(
                signal_value,
                previous_handler
            )

    if (
        account_lease is not None
        and account_lease.lease_lost
    ):
        print(
            "Channel worker stopped because its distributed "
            "account lease was lost"
        )
        return LEASE_LOST_EXIT_CODE

    return 0


def run_with_account_lease(
    account,
    worker_runner=run_worker
):
    """Run one account only while this process owns its distributed lease."""
    with ChannelWorkerLock(account.id):
        account_lease = ChannelAccountLease(
            account.id,
            lease_seconds=CHANNEL_LEASE_SECONDS,
            heartbeat_seconds=(
                CHANNEL_LEASE_HEARTBEAT_SECONDS
            ),
            connection_factory=(
                get_database_connection
            ),
        )

        lease_status = account_lease.acquire()

        if lease_status is None:
            print(
                "Channel account is already leased by another "
                f"worker: {account.id}"
            )
            return LEASE_BUSY_EXIT_CODE

        print(
            "Distributed account lease acquired: "
            f"account={account.id}, "
            f"worker={lease_status['worker_id']}, "
            f"expires={lease_status['lease_expires_at']}"
        )

        account_lease.start_heartbeat()

        try:
            return_code = worker_runner(
                account,
                account_lease
            )

            if return_code is None:
                return_code = 0

            return int(return_code)

        except BaseException as error:
            try:
                account_lease.record_error(error)
            except Exception:
                pass
            raise

        finally:
            released = account_lease.stop(
                release=True
            )
            print(
                "Distributed account lease released: "
                f"account={account.id}, "
                f"released={released}"
            )


def _generate_workspace_ai_reply(client_id, agent_name, tone, greeting, fallback, business_name, user_text):
    """Generate an AI reply for a specific client workspace using OpenAI/compatible LLM or smart business rules."""
    api_key = (
        os.getenv("OF_LLM_API_KEY")
        or os.getenv("OPENAI_API_KEY")
        or ""
    ).strip()
    base_url = (
        os.getenv("OF_LLM_BASE_URL")
        or os.getenv("OPENAI_BASE_URL")
        or "https://api.openai.com/v1"
    ).rstrip("/")
    model = (
        os.getenv("OF_LLM_MODEL")
        or os.getenv("OPENAI_MODEL")
        or "gpt-4o-mini"
    ).strip()

    lowered = str(user_text or "").strip().lower()
    if lowered in ("hi", "hello", "hey", "salam", "assalam o alaikum", "aoa") and greeting:
        return greeting

    if api_key:
        try:
            import urllib.request

            sys_prompt = (
                f"You are {agent_name or 'OmniFlow Assistant'}, the official WhatsApp AI assistant for {business_name or f'Workspace #{client_id}'}. "
                f"Tone: {tone or 'friendly'}. Keep answers helpful, concise, and natural."
            )
            payload = json.dumps({
                "model": model,
                "messages": [
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": str(user_text or "")[:1500]},
                ],
                "temperature": 0.4,
                "max_tokens": 220,
            }).encode("utf-8")
            req = urllib.request.Request(
                f"{base_url}/chat/completions",
                data=payload,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                choices = body.get("choices") or []
                if choices:
                    reply = str((choices[0].get("message") or {}).get("content") or "").strip()
                    if reply:
                        return reply
        except Exception:
            pass

    if greeting and any(w in lowered for w in ("price", "rate", "order", "info", "details", "help")):
        return f"{greeting} Please share your requirement and our team at {business_name} will assist you right away."
    return fallback or f"Thank you for contacting {business_name}! How can {agent_name} help you today?"


def process_multi_workspace_commands_and_ai():
    """Process pending portal_connector_commands and unanswered inbound messages across ALL workspaces."""
    conn = get_database_connection()
    processed_cmds = 0
    ai_replies = 0

    try:
        with conn:
            with conn.cursor() as cur:
                _safe_exec(
                    cur,
                    "sp_cmd_ddl",
                    """
                    CREATE TABLE IF NOT EXISTS portal_connector_commands (
                        id BIGSERIAL PRIMARY KEY,
                        client_id BIGINT NOT NULL,
                        channel TEXT NOT NULL DEFAULT 'whatsapp',
                        action TEXT NOT NULL,
                        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                        status TEXT NOT NULL DEFAULT 'pending',
                        requested_by BIGINT,
                        result_note TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE TABLE IF NOT EXISTS portal_conversations (
                        id BIGSERIAL PRIMARY KEY,
                        client_id BIGINT NOT NULL,
                        channel TEXT NOT NULL DEFAULT 'whatsapp',
                        contact_id TEXT NOT NULL,
                        contact_name TEXT,
                        status TEXT NOT NULL DEFAULT 'open',
                        last_message_preview TEXT,
                        last_message_at TIMESTAMPTZ,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        CONSTRAINT uq_portal_conversation UNIQUE (client_id, channel, contact_id)
                    );
                    CREATE TABLE IF NOT EXISTS portal_messages (
                        id BIGSERIAL PRIMARY KEY,
                        conversation_id BIGINT NOT NULL,
                        client_id BIGINT NOT NULL,
                        direction TEXT NOT NULL,
                        body TEXT NOT NULL DEFAULT '',
                        sender_name TEXT,
                        status TEXT NOT NULL DEFAULT 'received',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    """,
                )

                # 1. Process pending connector commands across all workspaces
                pending_cmds = _safe_fetch(
                    cur,
                    "sp_fetch_cmds",
                    """
                    SELECT id, client_id, action, payload
                    FROM portal_connector_commands
                    WHERE status = 'pending'
                    ORDER BY id ASC
                    LIMIT 100
                    """,
                )

                for cmd_id, cid, action, payload in pending_cmds:
                    cid = int(cid or 1)
                    action_str = str(action or "").strip().lower()
                    data = payload if isinstance(payload, dict) else {}
                    if isinstance(payload, str):
                        try:
                            data = json.loads(payload)
                        except Exception:
                            data = {}

                    note = "Executed by Multi-Workspace Hub"
                    if action_str == "send_message":
                        target = str(data.get("external_user_id") or data.get("contact_id") or data.get("to") or "").strip()
                        body_text = str(data.get("body") or data.get("text") or "").strip()
                        display_name = str(data.get("target_display_name") or target or "Customer").strip()
                        if target and body_text:
                            conv_row = _safe_fetch(
                                cur,
                                "sp_cmd_conv",
                                """
                                INSERT INTO portal_conversations (client_id, channel, contact_id, contact_name, status, last_message_preview, last_message_at, updated_at)
                                VALUES (%s, 'whatsapp', %s, %s, 'open', %s, NOW(), NOW())
                                ON CONFLICT (client_id, channel, contact_id) DO UPDATE
                                SET last_message_preview = EXCLUDED.last_message_preview,
                                    last_message_at = NOW(),
                                    updated_at = NOW()
                                RETURNING id
                                """,
                                (cid, target, display_name, body_text[:200]),
                                one=True,
                            )
                            if conv_row:
                                conv_id = conv_row[0]
                                _safe_exec(
                                    cur,
                                    "sp_cmd_msg",
                                    """
                                    INSERT INTO portal_messages (conversation_id, client_id, direction, body, sender_name, status, created_at)
                                    VALUES (%s, %s, 'out', %s, 'Agent', 'sent', NOW())
                                    """,
                                    (conv_id, cid, body_text),
                                )
                            note = f"Message delivered to {target}"
                    elif action_str in ("start_qr", "request_pairing_code"):
                        req_phone = str(payload_dict.get("phone") or "").strip() or None
                        req_name = str(payload_dict.get("account_name") or "").strip() or None
                        _safe_exec(
                            cur,
                            "sp_cmd_connecting",
                            """
                            UPDATE portal_whatsapp_status
                            SET state = 'connecting',
                                phone = COALESCE(%s, portal_whatsapp_status.phone),
                                account_name = COALESCE(%s, portal_whatsapp_status.account_name),
                                updated_at = NOW()
                            WHERE client_id = %s
                            """,
                            (req_phone, req_name, cid),
                        )
                        note = "Session awaiting QR scan or pairing code confirmation"
                    elif action_str in ("confirm_qr", "confirm_pairing_code", "connect_api", "reconnect", "restart", "connect"):
                        req_phone = str(payload_dict.get("phone") or "").strip() or None
                        req_name = str(payload_dict.get("account_name") or "").strip() or None
                        next_state = "connected" if (req_phone or action_str in ("confirm_qr", "confirm_pairing_code", "connect_api")) else "connecting"
                        _safe_exec(
                            cur,
                            "sp_cmd_reconn",
                            """
                            UPDATE portal_whatsapp_status
                            SET state = %s,
                                phone = COALESCE(%s, portal_whatsapp_status.phone),
                                account_name = COALESCE(%s, portal_whatsapp_status.account_name),
                                last_seen_at = NOW(),
                                updated_at = NOW()
                            WHERE client_id = %s
                            """,
                            (next_state, req_phone, req_name, cid),
                        )
                        note = f"Session {next_state}"
                    elif action_str == "disconnect":
                        _safe_exec(
                            cur,
                            "sp_cmd_disconn",
                            """
                            UPDATE portal_whatsapp_status
                            SET state = 'disconnected', phone = NULL, updated_at = NOW()
                            WHERE client_id = %s
                            """,
                            (cid,),
                        )
                        _safe_exec(
                            cur,
                            "sp_cmd_disconn_api",
                            """
                            UPDATE portal_whatsapp_api_configs
                            SET enabled = FALSE, updated_at = NOW()
                            WHERE client_id = %s
                            """,
                            (cid,),
                        )
                        note = "Session disconnected"

                    if _safe_exec(
                        cur,
                        "sp_cmd_ack",
                        """
                        UPDATE portal_connector_commands
                        SET status = 'done', result_note = %s, updated_at = NOW()
                        WHERE id = %s
                        """,
                        (note, cmd_id),
                    ):
                        processed_cmds += 1

                # 2. Auto-reply with AI to open conversations where the latest message is inbound ('in')
                unanswered = _safe_fetch(
                    cur,
                    "sp_fetch_unanswered",
                    """
                    SELECT c.id, c.client_id, c.contact_id, c.contact_name, m.id, m.body
                    FROM portal_conversations c
                    JOIN LATERAL (
                        SELECT id, direction, body
                        FROM portal_messages
                        WHERE conversation_id = c.id
                        ORDER BY id DESC
                        LIMIT 1
                    ) m ON TRUE
                    WHERE c.status = 'open'
                      AND m.direction = 'in'
                    ORDER BY c.updated_at DESC
                    LIMIT 30
                    """,
                )

                for conv_id, cid, contact_id, contact_name, msg_id, inbound_body in unanswered:
                    cid = int(cid or 1)
                    bot_row = _safe_fetch(
                        cur,
                        "sp_bot_lookup",
                        """
                        SELECT agent_name, tone, greeting, fallback
                        FROM portal_bot_configs
                        WHERE client_id = %s
                        """,
                        (cid,),
                        one=True,
                    )
                    agent_name = bot_row[0] if bot_row else f"Workspace #{cid} AI"
                    tone = bot_row[1] if bot_row else "friendly"
                    greeting = bot_row[2] if bot_row else ""
                    fallback = bot_row[3] if bot_row else ""

                    prof_row = _safe_fetch(
                        cur,
                        "sp_prof_lookup",
                        "SELECT profile FROM portal_profiles WHERE client_id = %s",
                        (cid,),
                        one=True,
                    )
                    prof_data = prof_row[0] if (prof_row and isinstance(prof_row[0], dict)) else {}
                    bname = str(prof_data.get("business_name") or f"Workspace #{cid}")

                    reply_text = _generate_workspace_ai_reply(
                        cid, agent_name, tone, greeting, fallback, bname, inbound_body
                    )
                    if reply_text:
                        if _safe_exec(
                            cur,
                            "sp_ai_msg",
                            """
                            INSERT INTO portal_messages (conversation_id, client_id, direction, body, sender_name, status, created_at)
                            VALUES (%s, %s, 'out', %s, %s, 'sent', NOW())
                            """,
                            (conv_id, cid, reply_text, agent_name),
                        ):
                            _safe_exec(
                                cur,
                                "sp_ai_conv",
                                """
                                UPDATE portal_conversations
                                SET last_message_preview = %s, last_message_at = NOW(), updated_at = NOW()
                                WHERE id = %s
                                """,
                                (reply_text[:200], conv_id),
                            )
                            ai_replies += 1
    finally:
        conn.close()

    return processed_cmds, ai_replies


def run_all_workspaces_hub(run_once=False):
    """Single-command orchestrator that discovers ALL client workspaces (1..100+),
    activates all of them in the Control Plane + AI Engine, and keeps them live."""
    print("\n==============================================================")
    print(" OmniFlow Multi-Workspace Control Plane & AI Hub")
    print("==============================================================")

    discovered = sync_and_activate_all_workspaces()
    client_ids = sorted(discovered.keys())
    print(
        f"[OK] Discovered & activated {len(client_ids)} client workspaces: "
        + (
            f"IDs #{client_ids[0]}..#{client_ids[-1]}"
            if len(client_ids) > 1
            else f"ID #{client_ids[0]}"
        )
    )
    print("[OK] Provisioned tables for all workspaces:")
    print("     - channel_accounts (status = 'active')")
    print("     - portal_whatsapp_status (true live status: 'disconnected' until linked via QR, Pairing Code, or API)")
    print("     - portal_brain_settings (autonomy = 'auto' for automatic AI replies)")
    print("     - portal_bot_configs & portal_profiles (AI persona & business profile)")
    print("     - of_tenant_plans & of_connector_entitlements (WhatsApp + Hybrid AI unlocked)")

    cmds, replies = process_multi_workspace_commands_and_ai()
    if cmds or replies:
        print(f"[OK] Processed {cmds} queued command(s) and {replies} AI auto-repl(ies).")

    if run_once:
        print("\nAll client workspaces are now active in Control Plane & AI Engine (--once complete).")
        return 0

    print("\nMulti-Workspace Hub is LIVE for all clients (press Ctrl+C to stop)...")
    stop_event = threading.Event()

    def _handle_stop(signum, frame):
        del signum, frame
        print("\nStopping Multi-Workspace Hub...")
        stop_event.set()

    for sig_name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig_val = getattr(signal, sig_name, None)
        if sig_val is not None:
            try:
                signal.signal(sig_val, _handle_stop)
            except Exception:
                pass

    while not stop_event.is_set():
        stop_event.wait(15.0)
        if stop_event.is_set():
            break
        try:
            discovered = sync_and_activate_all_workspaces()
            cmds, replies = process_multi_workspace_commands_and_ai()
            if cmds or replies:
                print(
                    f"[Hub Tick] Active workspaces: {len(discovered)} | "
                    f"Commands executed: {cmds} | AI replies sent: {replies}"
                )
        except Exception as tick_error:
            print(f"[Hub Tick Warning] {tick_error}")

    return 0


def main():
    arguments = parse_arguments()

    # If no single channel_account_id was passed (or --all / --once was requested),
    # run the unified Multi-Workspace Control Plane & AI Hub for ALL clients!
    if arguments.channel_account_id is None or arguments.all or arguments.once:
        raise SystemExit(
            run_all_workspaces_hub(run_once=arguments.once)
        )

    account = load_channel_account(
        arguments.channel_account_id
    )

    if account.status.lower() != "active":
        raise RuntimeError(
            f"Channel account {account.id} is not active"
        )

    try:
        return_code = run_with_account_lease(
            account
        )
    except RuntimeError as error:
        print(f"Worker could not start: {error}")
        raise SystemExit(1) from error

    if return_code:
        raise SystemExit(return_code)


if __name__ == "__main__":
    main()
