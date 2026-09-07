import argparse
import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv


PROJECT_ROOT = (
    Path(__file__).resolve().parent
)

SRC_DIR = PROJECT_ROOT / "src"

DEFAULT_CONFIG_PATH = (
    PROJECT_ROOT
    / ".connector_node.env"
)

if str(SRC_DIR) not in sys.path:
    sys.path.insert(
        0,
        str(SRC_DIR),
    )

from connector_node import (
    create_or_load_node_config,
    load_node_config,
    register_node,
    verify_registered_node,
)
from control_plane import (
    ControlPlaneRepository,
)


load_dotenv(
    PROJECT_ROOT / ".env"
)


def database_connection():
    return psycopg2.connect(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        connect_timeout=10,
        application_name=(
            "omniflow-connector-"
            "node-bootstrap"
        ),
    )


def build_parser():
    parser = argparse.ArgumentParser(
        description=(
            "Create or verify one local "
            "managed connector-node identity"
        )
    )

    action = (
        parser
        .add_mutually_exclusive_group(
            required=True
        )
    )

    action.add_argument(
        "--create",
        action="store_true",
        help=(
            "Create/register an idempotent "
            "local trial node"
        ),
    )

    action.add_argument(
        "--check",
        action="store_true",
        help=(
            "Read-only verification of "
            "an existing node config"
        ),
    )

    parser.add_argument(
        "--config",
        default=str(
            DEFAULT_CONFIG_PATH
        ),
        help=(
            "Local secret config path"
        ),
    )

    parser.add_argument(
        "--name",
        default=(
            "omniflow-local-trial-1"
        ),
        help=(
            "Stable connector node name"
        ),
    )

    parser.add_argument(
        "--region",
        default="pk-khi",
        help="Scheduler region",
    )

    parser.add_argument(
        "--max-sessions",
        type=int,
        default=5,
        help=(
            "Maximum concurrent "
            "managed sessions"
        ),
    )

    return parser


def main(argv=None):
    arguments = (
        build_parser()
        .parse_args(argv)
    )

    config_path = Path(
        arguments.config
    ).expanduser()

    if not config_path.is_absolute():
        config_path = (
            PROJECT_ROOT
            / config_path
        )

    if arguments.create:
        (
            config,
            config_created,
        ) = create_or_load_node_config(
            path=config_path,
            node_name=arguments.name,
            region=arguments.region,
            max_sessions=(
                arguments.max_sessions
            ),
        )

        repository = (
            ControlPlaneRepository(
                database_connection,
                heartbeat_timeout_seconds=90,
            )
        )

        register_node(
            repository,
            config,
        )

    else:
        config = load_node_config(
            config_path
        )

        config_created = False

    result = verify_registered_node(
        database_connection,
        config,
    )

    print(
        "Connector node bootstrap "
        "verification: passed"
    )

    print(
        f"Node ID: "
        f"{result['node_id']}"
    )

    print(
        f"Node name: "
        f"{result['node_name']}"
    )

    print(
        f"Region: "
        f"{result['region']}"
    )

    print(
        f"Capacity: "
        f"{result['max_sessions']}"
    )

    print(
        f"Status: "
        f"{result['status']}"
    )

    print(
        f"Active sessions: "
        f"{result['active_sessions']}"
    )

    print(
        f"Reserved sessions: "
        f"{result['reserved_sessions']}"
    )

    print(
        f"Local config created: "
        f"{config_created}"
    )

    print(
        f"Local config path: "
        f"{config_path}"
    )

    print(
        "Credential plaintext "
        "output: suppressed"
    )

    if arguments.check:
        print(
            "Database mode: "
            "read-only check"
        )

    print(
        "\nCONNECTOR NODE "
        "BOOTSTRAP PASSED"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())