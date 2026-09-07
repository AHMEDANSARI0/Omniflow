import json
import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv


PROJECT_ROOT = (
    Path(__file__).resolve().parent
)

SRC_DIR = PROJECT_ROOT / "src"

NODE_CONFIG_PATH = (
    PROJECT_ROOT
    / ".connector_node.env"
)

SNAPSHOT_PATH = (
    PROJECT_ROOT
    / "managed_control_plane_readiness.json"
)

if str(SRC_DIR) not in sys.path:
    sys.path.insert(
        0,
        str(SRC_DIR),
    )

from connector_node import (
    PostgresConnectorGateway,
    load_node_config,
)


load_dotenv(
    PROJECT_ROOT / ".env"
)


def readonly_connection():
    connection = psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        connect_timeout=10,
        application_name=(
            "omniflow-managed-control-"
            "plane-readiness"
        ),
    )

    connection.set_session(
        readonly=True,
        autocommit=False,
    )

    return connection


def collect_schema(cursor):
    tables = (
        "clients",
        "channel_accounts",
        "platform_users",
        "client_memberships",
        "channel_connections",
        "connector_nodes",
    )

    cursor.execute(
        """
        SELECT
            table_name,
            ordinal_position,
            column_name,
            data_type,
            udt_name,
            is_nullable,
            column_default

        FROM information_schema.columns

        WHERE table_schema = 'public'
          AND table_name = ANY(%s)

        ORDER BY
            table_name,
            ordinal_position
        """,
        (
            list(tables),
        ),
    )

    rows = cursor.fetchall()

    schema = {
        table: []
        for table in tables
    }

    for row in rows:
        schema[row[0]].append(
            {
                "position": int(row[1]),
                "name": row[2],
                "data_type": row[3],
                "udt_name": row[4],
                "nullable": (
                    row[5] == "YES"
                ),
                "default": row[6],
            }
        )

    missing = [
        table
        for table, columns
        in schema.items()
        if not columns
    ]

    if missing:
        raise RuntimeError(
            "Readiness audit is "
            "missing tables: "
            + ", ".join(missing)
        )

    return schema


def collect_account_safety(cursor):
    cursor.execute(
        """
        SELECT
            account.id,
            account.client_id,
            account.platform,
            account.status,
            account.connection_mode,
            connection.connection_mode,
            connection.status,
            connection.connector_node_id

        FROM channel_accounts account

        JOIN channel_connections connection
          ON connection.channel_account_id
             = account.id
         AND connection.client_id
             = account.client_id

        ORDER BY account.id
        """
    )

    rows = cursor.fetchall()

    return [
        {
            "channel_account_id": int(
                row[0]
            ),
            "client_id": int(
                row[1]
            ),
            "platform": row[2],
            "account_status": row[3],
            "account_mode": row[4],
            "connection_mode": row[5],
            "connection_status": row[6],
            "connector_node_id": (
                str(row[7])
                if row[7] is not None
                else None
            ),
        }
        for row in rows
    ]


def collect_node_state(
    cursor,
    node_id,
):
    cursor.execute(
        """
        SELECT
            id,
            node_name,
            region,
            status,
            max_sessions,
            active_sessions,
            reserved_sessions,
            last_heartbeat_at

        FROM connector_nodes

        WHERE id = %s
        """,
        (
            str(node_id),
        ),
    )

    row = cursor.fetchone()

    if row is None:
        raise RuntimeError(
            "Bootstrapped connector "
            "node is missing"
        )

    return {
        "node_id": str(row[0]),
        "node_name": row[1],
        "region": row[2],
        "status": row[3],
        "max_sessions": int(row[4]),
        "active_sessions": int(row[5]),
        "reserved_sessions": int(row[6]),
        "last_heartbeat_at": (
            row[7].isoformat()
            if row[7] is not None
            else None
        ),
    }


def run_readiness_check():
    config = load_node_config(
        NODE_CONFIG_PATH
    )

    gateway = (
        PostgresConnectorGateway(
            readonly_connection,
            heartbeat_timeout_seconds=90,
        )
    )

    assignments = (
        gateway.list_assignments(
            node_id=config.node_id,
            credential_digest=(
                config.credential_digest
            ),
        )
    )

    connection = (
        readonly_connection()
    )

    try:
        with connection.cursor() as cursor:
            schema = collect_schema(
                cursor
            )

            accounts = (
                collect_account_safety(
                    cursor
                )
            )

            node = collect_node_state(
                cursor,
                config.node_id,
            )

        connection.rollback()

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()

    managed_accounts = [
        account
        for account in accounts
        if (
            account["account_mode"]
            == "managed_web"
            or account[
                "connection_mode"
            ] == "managed_web"
            or account[
                "connector_node_id"
            ] is not None
        )
    ]

    if assignments:
        raise RuntimeError(
            "Unexpected assignments exist "
            "before onboarding trial"
        )

    if managed_accounts:
        raise RuntimeError(
            "Existing accounts were "
            "unexpectedly switched "
            "to managed mode"
        )

    if node["active_sessions"] != 0:
        raise RuntimeError(
            "Trial node unexpectedly "
            "has active sessions"
        )

    if node["reserved_sessions"] != 0:
        raise RuntimeError(
            "Trial node unexpectedly "
            "has reserved sessions"
        )

    snapshot = {
        "read_only": True,
        "node": node,
        "assignment_count": (
            len(assignments)
        ),
        "existing_accounts": accounts,
        "managed_existing_account_count": (
            len(managed_accounts)
        ),
        "schema": schema,
    }

    temporary = (
        SNAPSHOT_PATH.with_suffix(
            ".json.creating"
        )
    )

    temporary.write_text(
        json.dumps(
            snapshot,
            indent=2,
            sort_keys=True,
            ensure_ascii=False,
        ) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    temporary.replace(
        SNAPSHOT_PATH
    )

    return snapshot


def main():
    snapshot = (
        run_readiness_check()
    )

    node = snapshot["node"]

    print(
        "Registered node "
        "authentication: passed"
    )

    print(
        f"Node ID: "
        f"{node['node_id']}"
    )

    print(
        f"Node status: "
        f"{node['status']}"
    )

    print(
        "Node capacity: "
        f"active="
        f"{node['active_sessions']}, "
        f"reserved="
        f"{node['reserved_sessions']}, "
        f"maximum="
        f"{node['max_sessions']}"
    )

    print(
        "Managed assignment count: "
        f"{snapshot['assignment_count']}"
    )

    print(
        "Existing account count: "
        f"{len(snapshot['existing_accounts'])}"
    )

    print(
        "Existing accounts switched "
        "to managed mode: "
        f"{snapshot[
            'managed_existing_account_count'
        ]}"
    )

    print(
        "\nOnboarding schema columns"
    )

    for table in (
        "clients",
        "channel_accounts",
    ):
        print(f"  {table}:")

        for column in (
            snapshot["schema"][table]
        ):
            print(
                "    - "
                f"{column['name']} | "
                f"{column['data_type']} | "
                f"nullable="
                f"{column['nullable']} | "
                f"default="
                f"{column['default']}"
            )

    print(
        f"\nSnapshot: "
        f"{SNAPSHOT_PATH}"
    )

    print(
        "Credential plaintext "
        "output: suppressed"
    )

    print(
        "Browser/WhatsApp "
        "side effects: absent"
    )

    print(
        "\nMANAGED CONTROL-PLANE "
        "READINESS PASSED"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())