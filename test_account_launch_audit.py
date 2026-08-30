import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
from dotenv import load_dotenv
from psycopg2.extras import RealDictCursor


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"
REPORT_DIR = PROJECT_ROOT / "launch_audit_reports"

load_dotenv(PROJECT_ROOT / ".env")

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from run_all_channels import SUPPORTED_PLATFORMS  # noqa: E402


class Audit:
    def __init__(self, channel_account_id):
        self.channel_account_id = channel_account_id
        self.results = []

    def add(self, level, name, passed, details):
        result = {
            "level": level,
            "name": name,
            "passed": bool(passed),
            "details": details,
        }
        self.results.append(result)
        marker = (
            "PASS"
            if passed
            else (
                "WARN"
                if level == "warning"
                else "BLOCK"
            )
        )
        print(f"[{marker}] {name}: {details}")

    def blocker(self, name, passed, details):
        self.add("blocker", name, passed, details)

    def warning(self, name, passed, details):
        self.add("warning", name, passed, details)

    def info(self, name, details):
        self.add("info", name, True, details)

    @property
    def blockers(self):
        return [
            item
            for item in self.results
            if item["level"] == "blocker"
            and not item["passed"]
        ]

    @property
    def warnings(self):
        return [
            item
            for item in self.results
            if item["level"] == "warning"
            and not item["passed"]
        ]

    def write_report(self):
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        report_path = REPORT_DIR / (
            f"account_{self.channel_account_id}_launch_audit.json"
        )
        payload = {
            "schema_version": 1,
            "generated_at": datetime.now(
                timezone.utc
            ).isoformat(),
            "channel_account_id": self.channel_account_id,
            "ready": not self.blockers,
            "blocker_count": len(self.blockers),
            "warning_count": len(self.warnings),
            "results": self.results,
        }
        report_path.write_text(
            json.dumps(
                payload,
                indent=2,
                default=str
            ),
            encoding="utf-8"
        )
        return report_path


def parse_arguments():
    parser = argparse.ArgumentParser(
        description=(
            "Read-only launch-readiness audit for one database-derived "
            "channel account"
        )
    )
    parser.add_argument(
        "channel_account_id",
        type=int,
        help="Database channel_accounts.id to audit"
    )
    arguments = parser.parse_args()

    if arguments.channel_account_id <= 0:
        parser.error(
            "channel_account_id must be positive"
        )

    return arguments


def get_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
    )


def scalar(cursor, query, parameters=()):
    cursor.execute(query, parameters)
    row = cursor.fetchone()

    if isinstance(row, dict):
        return next(iter(row.values()))

    return row[0]


def resolve_session_path(account):
    metadata = account.get("metadata") or {}
    configured = str(
        metadata.get("session_path")
        or ""
    ).strip()

    if configured:
        path = Path(configured).expanduser()

        if not path.is_absolute():
            path = PROJECT_ROOT / path

        return path

    return (
        PROJECT_ROOT
        / "whatsapp_sessions"
        / f"account_{account['id']}"
    )


def audit_source_and_environment(audit):
    env_path = PROJECT_ROOT / ".env"
    audit.blocker(
        "Project environment file",
        env_path.is_file(),
        str(env_path)
    )

    required_database_variables = (
        "DB_HOST",
        "DB_PORT",
        "DB_NAME",
        "DB_USER",
        "DB_PASSWORD",
    )
    missing_database_variables = [
        name
        for name in required_database_variables
        if not str(os.getenv(name) or "").strip()
    ]
    audit.blocker(
        "Database environment",
        not missing_database_variables,
        (
            "configured"
            if not missing_database_variables
            else "missing: "
            + ", ".join(missing_database_variables)
        )
    )

    provider_variables = (
        "GROQ_API_KEY",
        "GEMINI_API_KEY",
        "CEREBRAS_API_KEY",
        "OPENROUTER_API_KEY",
    )
    configured_providers = [
        name
        for name in provider_variables
        if str(os.getenv(name) or "").strip()
    ]
    audit.blocker(
        "At least one AI provider credential",
        bool(configured_providers),
        (
            ", ".join(configured_providers)
            if configured_providers
            else "no supported provider key configured"
        )
    )

    voice_reply_mode = str(
        os.getenv("VOICE_REPLY_MODE", "text")
    ).strip().lower()
    audit.blocker(
        "Voice reply mode",
        voice_reply_mode in {"text", "audio"},
        voice_reply_mode
    )

    required_files = (
        PROJECT_ROOT / "run_channel.py",
        PROJECT_ROOT / "run_all_channels.py",
        SRC_DIR / "memory.py",
        SRC_DIR / "conversation.py",
        SRC_DIR / "account_lease.py",
        SRC_DIR / "channels" / "contracts.py",
        SRC_DIR / "channels" / "whatsapp_web.py",
    )
    missing_files = [
        str(path.relative_to(PROJECT_ROOT))
        for path in required_files
        if not path.is_file()
    ]
    audit.blocker(
        "Required runtime files",
        not missing_files,
        (
            "all present"
            if not missing_files
            else "missing: " + ", ".join(missing_files)
        )
    )

    legacy_main = SRC_DIR / "main.py"
    legacy_app = SRC_DIR / "app.py"
    legacy_safe = all(
        path.is_file()
        and "LEGACY_LAUNCHER_DISABLED" in path.read_text(
            encoding="utf-8"
        )
        for path in (legacy_main, legacy_app)
    )
    audit.blocker(
        "Obsolete launchers disabled",
        legacy_safe,
        (
            "src/main.py and src/app.py are safe shims"
            if legacy_safe
            else "obsolete direct launcher is still executable"
        )
    )


def audit_database(audit):
    conn = get_connection()
    account = None

    try:
        with conn:
            with conn.cursor(
                cursor_factory=RealDictCursor
            ) as cursor:
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
                    WHERE id = %s
                    """,
                    (audit.channel_account_id,)
                )
                account = cursor.fetchone()

                audit.blocker(
                    "Channel account exists",
                    account is not None,
                    (
                        f"account={audit.channel_account_id}"
                        if account is not None
                        else "not found"
                    )
                )

                if account is None:
                    return None

                account = dict(account)
                audit.blocker(
                    "Channel account active",
                    str(account["status"]).lower() == "active",
                    f"status={account['status']}"
                )
                platform = str(
                    account["platform"]
                ).strip().lower()
                audit.blocker(
                    "Installed platform adapter",
                    platform in SUPPORTED_PLATFORMS,
                    f"platform={platform}"
                )
                audit.blocker(
                    "External account identity",
                    bool(
                        str(
                            account["external_account_id"]
                            or ""
                        ).strip()
                    ),
                    "configured"
                )
                audit.info(
                    "Tenant context",
                    (
                        f"client={account['client_id']}, "
                        f"account={account['id']}, "
                        f"name={account['account_name']}"
                    )
                )

                required_tables = {
                    "clients",
                    "channel_accounts",
                    "customers",
                    "channel_contacts",
                    "conversations",
                    "messages",
                    "message_reply_jobs",
                    "channel_account_leases",
                }
                cursor.execute(
                    """
                    SELECT table_name
                    FROM information_schema.tables
                    WHERE table_schema = 'public'
                      AND table_name = ANY(%s)
                    """,
                    (list(required_tables),)
                )
                present_tables = {
                    row["table_name"]
                    for row in cursor.fetchall()
                }
                missing_tables = sorted(
                    required_tables - present_tables
                )
                audit.blocker(
                    "Required database tables",
                    not missing_tables,
                    (
                        "all present"
                        if not missing_tables
                        else "missing: "
                        + ", ".join(missing_tables)
                    )
                )

                live_lease_count = scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM channel_account_leases
                    WHERE channel_account_id = %s
                      AND owner_token IS NOT NULL
                      AND lease_expires_at > CURRENT_TIMESTAMP
                    """,
                    (account["id"],)
                )
                audit.blocker(
                    "No live worker lease during audit",
                    live_lease_count == 0,
                    f"live_leases={live_lease_count}"
                )

                cross_tenant_contacts = scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM channel_contacts cc
                    JOIN channel_accounts ca
                      ON ca.id = cc.channel_account_id
                    JOIN customers customer
                      ON customer.id = cc.customer_id
                    WHERE cc.channel_account_id = %s
                      AND customer.client_id <> ca.client_id
                    """,
                    (account["id"],)
                )
                audit.blocker(
                    "Customer tenant isolation",
                    cross_tenant_contacts == 0,
                    f"cross_tenant_contacts={cross_tenant_contacts}"
                )

                blank_identities = scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM channel_contacts
                    WHERE channel_account_id = %s
                      AND (
                          external_user_id IS NULL
                          OR BTRIM(external_user_id) = ''
                      )
                    """,
                    (account["id"],)
                )
                audit.blocker(
                    "Stable external contact identities",
                    blank_identities == 0,
                    f"blank_identities={blank_identities}"
                )

                missing_display_names = scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM channel_contacts
                    WHERE channel_account_id = %s
                      AND status = 'active'
                      AND (
                          display_name IS NULL
                          OR BTRIM(display_name) = ''
                      )
                    """,
                    (account["id"],)
                )
                audit.warning(
                    "Recovery routing display-name coverage",
                    missing_display_names == 0,
                    f"active_contacts_missing_name={missing_display_names}"
                )

                inbound_without_job = scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM messages inbound
                    JOIN conversations cv
                      ON cv.id = inbound.conversation_id
                    JOIN channel_contacts cc
                      ON cc.id = cv.channel_contact_id
                    LEFT JOIN message_reply_jobs job
                      ON job.inbound_message_id = inbound.id
                    WHERE cc.channel_account_id = %s
                      AND inbound.role = 'user'
                      AND inbound.external_message_id IS NOT NULL
                      AND job.id IS NULL
                    """,
                    (account["id"],)
                )
                missing_job_details = []

                if inbound_without_job:
                    cursor.execute(
                        """
                        SELECT
                            inbound.id,
                            inbound.external_message_id,
                            LEFT(inbound.content, 120) AS content_preview,
                            inbound.created_at,
                            cc.external_user_id,
                            EXISTS (
                                SELECT 1
                                FROM messages response
                                WHERE response.conversation_id
                                    = inbound.conversation_id
                                  AND response.role = 'assistant'
                                  AND response.id > inbound.id
                                  AND response.id < COALESCE(
                                      (
                                          SELECT MIN(next_user.id)
                                          FROM messages next_user
                                          WHERE next_user.conversation_id
                                              = inbound.conversation_id
                                            AND next_user.role = 'user'
                                            AND next_user.id > inbound.id
                                      ),
                                      9223372036854775807
                                  )
                            ) AS has_later_assistant
                        FROM messages inbound
                        JOIN conversations cv
                          ON cv.id = inbound.conversation_id
                        JOIN channel_contacts cc
                          ON cc.id = cv.channel_contact_id
                        LEFT JOIN message_reply_jobs job
                          ON job.inbound_message_id = inbound.id
                        WHERE cc.channel_account_id = %s
                          AND inbound.role = 'user'
                          AND inbound.external_message_id IS NOT NULL
                          AND job.id IS NULL
                        ORDER BY inbound.id
                        LIMIT 20
                        """,
                        (account["id"],)
                    )
                    missing_job_details = [
                        {
                            "message_id": row["id"],
                            "external_message_id": row[
                                "external_message_id"
                            ],
                            "external_user_id": row[
                                "external_user_id"
                            ],
                            "created_at": row["created_at"],
                            "has_later_assistant": row[
                                "has_later_assistant"
                            ],
                            "content_preview": row[
                                "content_preview"
                            ],
                        }
                        for row in cursor.fetchall()
                    ]

                audit.blocker(
                    "Inbound messages have durable reply jobs",
                    inbound_without_job == 0,
                    (
                        "missing_jobs=0"
                        if inbound_without_job == 0
                        else {
                            "missing_jobs": inbound_without_job,
                            "sample": missing_job_details,
                        }
                    )
                )

                duplicate_external_ids = scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM (
                        SELECT
                            m.conversation_id,
                            m.external_message_id
                        FROM messages m
                        JOIN conversations cv
                          ON cv.id = m.conversation_id
                        JOIN channel_contacts cc
                          ON cc.id = cv.channel_contact_id
                        WHERE cc.channel_account_id = %s
                          AND m.external_message_id IS NOT NULL
                        GROUP BY
                            m.conversation_id,
                            m.external_message_id
                        HAVING COUNT(*) > 1
                    ) duplicates
                    """,
                    (account["id"],)
                )
                audit.blocker(
                    "External message idempotency",
                    duplicate_external_ids == 0,
                    f"duplicate_keys={duplicate_external_ids}"
                )

                direction_mismatches = scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM messages m
                    JOIN conversations cv
                      ON cv.id = m.conversation_id
                    JOIN channel_contacts cc
                      ON cc.id = cv.channel_contact_id
                    WHERE cc.channel_account_id = %s
                      AND (
                          (m.role = 'user' AND m.direction <> 'inbound')
                          OR
                          (m.role = 'assistant' AND m.direction <> 'outbound')
                          OR
                          (m.role = 'system' AND m.direction <> 'internal')
                      )
                    """,
                    (account["id"],)
                )
                audit.blocker(
                    "Message role/direction consistency",
                    direction_mismatches == 0,
                    f"mismatches={direction_mismatches}"
                )

                sent_without_delivery_id = scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM message_reply_jobs job
                    JOIN messages inbound
                      ON inbound.id = job.inbound_message_id
                    JOIN conversations cv
                      ON cv.id = inbound.conversation_id
                    JOIN channel_contacts cc
                      ON cc.id = cv.channel_contact_id
                    WHERE cc.channel_account_id = %s
                      AND job.status = 'sent'
                      AND job.outbound_external_message_id IS NULL
                    """,
                    (account["id"],)
                )
                audit.blocker(
                    "Sent jobs have provider delivery IDs",
                    sent_without_delivery_id == 0,
                    f"sent_without_id={sent_without_delivery_id}"
                )

                fresh_processing_jobs = scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM message_reply_jobs job
                    JOIN messages inbound
                      ON inbound.id = job.inbound_message_id
                    JOIN conversations cv
                      ON cv.id = inbound.conversation_id
                    JOIN channel_contacts cc
                      ON cc.id = cv.channel_contact_id
                    WHERE cc.channel_account_id = %s
                      AND job.status = 'processing'
                      AND job.locked_at >= (
                          CURRENT_TIMESTAMP - INTERVAL '5 minutes'
                      )
                    """,
                    (account["id"],)
                )
                audit.blocker(
                    "No fresh processing locks while stopped",
                    fresh_processing_jobs == 0,
                    f"fresh_processing_jobs={fresh_processing_jobs}"
                )

                due_recovery_jobs = scalar(
                    cursor,
                    """
                    SELECT COUNT(*)
                    FROM message_reply_jobs job
                    JOIN messages inbound
                      ON inbound.id = job.inbound_message_id
                    JOIN conversations cv
                      ON cv.id = inbound.conversation_id
                    JOIN channel_contacts cc
                      ON cc.id = cv.channel_contact_id
                    WHERE cc.channel_account_id = %s
                      AND job.status IN (
                          'pending',
                          'failed',
                          'reply_ready',
                          'processing'
                      )
                      AND COALESCE(
                          job.next_attempt_at,
                          CURRENT_TIMESTAMP
                      ) <= CURRENT_TIMESTAMP
                      AND (
                          job.status <> 'processing'
                          OR job.locked_at IS NULL
                          OR job.locked_at < (
                              CURRENT_TIMESTAMP
                              - INTERVAL '5 minutes'
                          )
                      )
                    """,
                    (account["id"],)
                )
                audit.warning(
                    "No due recovery backlog",
                    due_recovery_jobs == 0,
                    f"due_jobs={due_recovery_jobs}"
                )

                cursor.execute(
                    """
                    SELECT job.status, COUNT(*) AS count
                    FROM message_reply_jobs job
                    JOIN messages inbound
                      ON inbound.id = job.inbound_message_id
                    JOIN conversations cv
                      ON cv.id = inbound.conversation_id
                    JOIN channel_contacts cc
                      ON cc.id = cv.channel_contact_id
                    WHERE cc.channel_account_id = %s
                    GROUP BY job.status
                    ORDER BY job.status
                    """,
                    (account["id"],)
                )
                status_counts = {
                    row["status"]: row["count"]
                    for row in cursor.fetchall()
                }
                audit.info(
                    "Reply job status distribution",
                    status_counts
                )

    finally:
        conn.close()

    return account


def audit_session(audit, account):
    if account is None:
        return

    if str(account["platform"]).lower() != "whatsapp":
        audit.info(
            "Browser session",
            "not required for this platform"
        )
        return

    session_path = resolve_session_path(account)
    session_exists = session_path.is_dir()
    audit.blocker(
        "WhatsApp persistent session directory",
        session_exists,
        str(session_path)
    )

    if session_exists:
        try:
            entry_count = sum(
                1
                for _ in session_path.iterdir()
            )
        except OSError:
            entry_count = 0

        audit.blocker(
            "WhatsApp session is non-empty",
            entry_count > 0,
            f"top_level_entries={entry_count}"
        )


def main():
    arguments = parse_arguments()
    audit = Audit(
        arguments.channel_account_id
    )

    print("\nACCOUNT LAUNCH READINESS AUDIT")
    print(
        f"Channel account ID: {arguments.channel_account_id}"
    )
    print("Mode: read-only, no browser, no AI calls\n")

    audit_source_and_environment(audit)

    try:
        account = audit_database(audit)
    except Exception as error:
        audit.blocker(
            "Database audit execution",
            False,
            str(error)
        )
        account = None

    audit_session(audit, account)
    report_path = audit.write_report()

    print("\nAUDIT SUMMARY")
    print(f"Blockers: {len(audit.blockers)}")
    print(f"Warnings: {len(audit.warnings)}")
    print(f"Report: {report_path}")

    if audit.blockers:
        print(
            "\n❌ ACCOUNT LAUNCH AUDIT BLOCKED"
        )
        raise SystemExit(1)

    print(
        "\n✅ ACCOUNT LAUNCH AUDIT PASSED"
    )


if __name__ == "__main__":
    main()
