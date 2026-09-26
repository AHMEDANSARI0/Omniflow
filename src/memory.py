import hashlib
import os

from dotenv import load_dotenv
from psycopg2 import pool
from psycopg2.extras import Json


load_dotenv()


class Memory:
    VALID_ROLES = {
        "user",
        "assistant",
        "system",
    }

    VALID_MESSAGE_TYPES = {
        "text",
        "audio",
        "image",
        "video",
        "document",
        "location",
        "contact",
        "interactive",
        "event",
    }

    ROLE_DIRECTIONS = {
        "user": "inbound",
        "assistant": "outbound",
        "system": "internal",
    }

    def __init__(self):
        min_connections = int(
            os.getenv("DB_POOL_MIN", "1")
        )
        max_connections = int(
            os.getenv("DB_POOL_MAX", "10")
        )

        if min_connections < 1:
            raise ValueError(
                "DB_POOL_MIN must be at least 1"
            )

        if max_connections < min_connections:
            raise ValueError(
                "DB_POOL_MAX must be greater than or equal to DB_POOL_MIN"
            )

        self.db_pool = pool.ThreadedConnectionPool(
            min_connections,
            max_connections,
            host=os.getenv("DB_HOST"),
            port=os.getenv("DB_PORT"),
            database=os.getenv("DB_NAME"),
            user=os.getenv("DB_USER"),
            password=os.getenv("DB_PASSWORD"),
        )

        if self.db_pool is None:
            raise RuntimeError(
                "Database connection pool could not be created"
            )

        print("Omnichannel memory connected to PostgreSQL")

    # ---------------------------------
    # Input Validation
    # ---------------------------------

    @staticmethod
    def _normalize_external_user_id(external_user_id):
        normalized_id = str(
            external_user_id or ""
        ).strip()

        if not normalized_id:
            raise ValueError(
                "A stable external user identifier is required"
            )

        if len(normalized_id) > 255:
            raise ValueError(
                "external_user_id cannot exceed 255 characters"
            )

        return normalized_id

    @staticmethod
    def _normalize_external_message_id(
        external_message_id
    ):
        if external_message_id is None:
            return None

        normalized_id = str(
            external_message_id
        ).strip()

        if not normalized_id:
            return None

        if len(normalized_id) <= 255:
            return normalized_id

        digest = hashlib.sha256(
            normalized_id.encode("utf-8")
        ).hexdigest()

        return f"sha256:{digest}"

    @classmethod
    def _validate_role(cls, role):
        if role not in cls.VALID_ROLES:
            raise ValueError(
                f"Unsupported message role: {role}"
            )

    @classmethod
    def _validate_message_type(cls, message_type):
        if message_type not in cls.VALID_MESSAGE_TYPES:
            raise ValueError(
                f"Unsupported message type: {message_type}"
            )

    # ---------------------------------
    # Database Connection Helpers
    # ---------------------------------

    def _get_connection(self):
        if self.db_pool is None:
            raise RuntimeError(
                "Database connection pool is closed"
            )

        return self.db_pool.getconn()

    def _release_connection(self, conn):
        if conn is None or self.db_pool is None:
            return

        self.db_pool.putconn(
            conn,
            close=bool(conn.closed)
        )

    # ---------------------------------
    # Channel Account Resolution
    # ---------------------------------

    @staticmethod
    def _ensure_channel_account_exists(
        cursor,
        channel_account_id
    ):
        cursor.execute(
            """
            SELECT
                client_id,
                platform,
                status
            FROM channel_accounts
            WHERE id = %s
            """,
            (channel_account_id,)
        )

        row = cursor.fetchone()

        if row is None:
            raise ValueError(
                f"Channel account {channel_account_id} does not exist"
            )

        client_id, platform, status = row

        if str(status).lower() != "active":
            raise ValueError(
                f"Channel account {channel_account_id} is not active"
            )

        return {
            "client_id": client_id,
            "platform": platform,
            "status": status,
        }

    # ---------------------------------
    # Customer + Channel Identity
    # ---------------------------------

    @staticmethod
    def _get_or_create_channel_contact_with_cursor(
        cursor,
        channel_account_id,
        client_id,
        external_user_id
    ):
        cursor.execute(
            """
            SELECT
                id,
                customer_id
            FROM channel_contacts
            WHERE channel_account_id = %s
              AND external_user_id = %s
            """,
            (
                channel_account_id,
                external_user_id,
            )
        )

        existing_contact = cursor.fetchone()

        if existing_contact:
            return {
                "channel_contact_id": existing_contact[0],
                "customer_id": existing_contact[1],
            }

        # Serialize first-contact creation for this account + external identity.
        # This prevents concurrent messages from creating orphan customers.
        advisory_key = (
            f"channel-contact:{channel_account_id}:"
            f"{external_user_id}"
        )
        cursor.execute(
            """
            SELECT pg_advisory_xact_lock(
                hashtextextended(%s, 0)
            )
            """,
            (advisory_key,)
        )

        # Recheck after acquiring the transaction-scoped advisory lock.
        cursor.execute(
            """
            SELECT
                id,
                customer_id
            FROM channel_contacts
            WHERE channel_account_id = %s
              AND external_user_id = %s
            """,
            (
                channel_account_id,
                external_user_id,
            )
        )

        existing_contact = cursor.fetchone()

        if existing_contact:
            return {
                "channel_contact_id": existing_contact[0],
                "customer_id": existing_contact[1],
            }

        # Explicit-link model: every new channel identity starts with its own
        # canonical customer. An authorized link operation can later point
        # several channel_contacts to the same customer_id.
        cursor.execute(
            """
            INSERT INTO customers (
                client_id
            )
            VALUES (%s)
            RETURNING id
            """,
            (client_id,)
        )

        customer_id = cursor.fetchone()[0]

        cursor.execute(
            """
            INSERT INTO channel_contacts (
                customer_id,
                channel_account_id,
                external_user_id,
                identity_type
            )
            VALUES (%s, %s, %s, 'platform_user_id')
            ON CONFLICT ON CONSTRAINT
                channel_contacts_account_user_unique
            DO NOTHING
            RETURNING id
            """,
            (
                customer_id,
                channel_account_id,
                external_user_id,
            )
        )

        inserted_contact = cursor.fetchone()

        if inserted_contact:
            return {
                "channel_contact_id": inserted_contact[0],
                "customer_id": customer_id,
            }

        # Defensive cleanup for a conflict created by code that does not use
        # this advisory lock.
        cursor.execute(
            """
            DELETE FROM customers
            WHERE id = %s
            """,
            (customer_id,)
        )

        cursor.execute(
            """
            SELECT
                id,
                customer_id
            FROM channel_contacts
            WHERE channel_account_id = %s
              AND external_user_id = %s
            """,
            (
                channel_account_id,
                external_user_id,
            )
        )

        resolved_contact = cursor.fetchone()

        if resolved_contact is None:
            raise RuntimeError(
                "Channel contact could not be created or resolved"
            )

        return {
            "channel_contact_id": resolved_contact[0],
            "customer_id": resolved_contact[1],
        }

    # ---------------------------------
    # Conversation Resolution
    # ---------------------------------

    @staticmethod
    def _get_or_create_conversation_with_cursor(
        cursor,
        channel_contact_id
    ):
        cursor.execute(
            """
            SELECT id
            FROM conversations
            WHERE channel_contact_id = %s
            """,
            (channel_contact_id,)
        )

        result = cursor.fetchone()

        if result:
            return result[0]

        cursor.execute(
            """
            INSERT INTO conversations (
                channel_contact_id
            )
            VALUES (%s)
            ON CONFLICT ON CONSTRAINT
                conversations_channel_contact_unique
            DO UPDATE SET
                channel_contact_id = EXCLUDED.channel_contact_id
            RETURNING id
            """,
            (channel_contact_id,)
        )

        return cursor.fetchone()[0]

    # ---------------------------------
    # Durable Reply Job
    # ---------------------------------

    @staticmethod
    def _get_or_create_reply_job_with_cursor(
        cursor,
        inbound_message_id
    ):
        cursor.execute(
            """
            INSERT INTO message_reply_jobs (
                inbound_message_id
            )
            VALUES (%s)
            ON CONFLICT ON CONSTRAINT
                message_reply_jobs_inbound_unique
            DO NOTHING
            RETURNING id
            """,
            (inbound_message_id,)
        )

        inserted_job = cursor.fetchone()

        if inserted_job:
            return inserted_job[0]

        cursor.execute(
            """
            SELECT id
            FROM message_reply_jobs
            WHERE inbound_message_id = %s
            """,
            (inbound_message_id,)
        )

        existing_job = cursor.fetchone()

        if existing_job is None:
            raise RuntimeError(
                "Reply job could not be created or resolved"
            )

        return existing_job[0]

    # ---------------------------------
    # Save Message Atomically
    # ---------------------------------

    def save_message(
        self,
        channel_account_id,
        external_user_id,
        role,
        content,
        external_message_id=None,
        message_type="text",
        metadata=None,
        display_name=None
    ):
        external_user_id = (
            self._normalize_external_user_id(
                external_user_id
            )
        )
        external_message_id = (
            self._normalize_external_message_id(
                external_message_id
            )
        )
        self._validate_role(role)
        self._validate_message_type(message_type)

        if content is None:
            raise ValueError(
                "Message content cannot be None"
            )

        if (
            external_message_id is not None
            and role != "user"
        ):
            raise ValueError(
                "external_message_id is currently supported only "
                "for inbound user messages"
            )

        metadata = metadata or {}
        display_name = str(
            display_name or ""
        ).strip()

        if display_name:
            display_name = display_name[:255]
        else:
            display_name = None

        direction = self.ROLE_DIRECTIONS[role]
        conn = self._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    account = self._ensure_channel_account_exists(
                        cursor,
                        channel_account_id
                    )

                    identity = (
                        self._get_or_create_channel_contact_with_cursor(
                            cursor,
                            channel_account_id,
                            account["client_id"],
                            external_user_id
                        )
                    )

                    # Display names are UI/routing hints only and never identity
                    # keys. Persist the latest inbound name so a browser adapter
                    # can locate a restart candidate and then verify its stable
                    # JID/LID before delivery.
                    if role == "user" and display_name:
                        cursor.execute(
                            """
                            UPDATE channel_contacts
                            SET
                                display_name = %s,
                                updated_at = CURRENT_TIMESTAMP
                            WHERE id = %s
                              AND display_name IS DISTINCT FROM %s
                            """,
                            (
                                display_name,
                                identity["channel_contact_id"],
                                display_name,
                            )
                        )

                    conversation_id = (
                        self._get_or_create_conversation_with_cursor(
                            cursor,
                            identity["channel_contact_id"]
                        )
                    )

                    cursor.execute(
                        """
                        INSERT INTO messages (
                            conversation_id,
                            role,
                            content,
                            external_message_id,
                            direction,
                            message_type,
                            metadata
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (
                            conversation_id,
                            external_message_id
                        )
                        WHERE external_message_id IS NOT NULL
                        DO NOTHING
                        RETURNING id
                        """,
                        (
                            conversation_id,
                            role,
                            content,
                            external_message_id,
                            direction,
                            message_type,
                            Json(metadata),
                        )
                    )

                    inserted_message = cursor.fetchone()

                    if inserted_message is None:
                        if (
                            role == "user"
                            and external_message_id is not None
                        ):
                            cursor.execute(
                                """
                                SELECT id
                                FROM messages
                                WHERE conversation_id = %s
                                  AND external_message_id = %s
                                """,
                                (
                                    conversation_id,
                                    external_message_id,
                                )
                            )
                            existing_message = cursor.fetchone()

                            if existing_message:
                                self._get_or_create_reply_job_with_cursor(
                                    cursor,
                                    existing_message[0]
                                )

                        return False

                    inserted_message_id = inserted_message[0]

                    if (
                        role == "user"
                        and external_message_id is not None
                    ):
                        self._get_or_create_reply_job_with_cursor(
                            cursor,
                            inserted_message_id
                        )

                    cursor.execute(
                        """
                        UPDATE conversations
                        SET updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                        """,
                        (conversation_id,)
                    )

                    return True

        finally:
            self._release_connection(conn)

    def save_user_message(
        self,
        channel_account_id,
        external_user_id,
        content,
        external_message_id=None,
        message_type="text",
        metadata=None,
        display_name=None
    ):
        return self.save_message(
            channel_account_id,
            external_user_id,
            "user",
            content,
            external_message_id=external_message_id,
            message_type=message_type,
            metadata=metadata,
            display_name=display_name
        )

    def save_ai_message(
        self,
        channel_account_id,
        external_user_id,
        content,
        message_type="text",
        metadata=None
    ):
        return self.save_message(
            channel_account_id,
            external_user_id,
            "assistant",
            content,
            message_type=message_type,
            metadata=metadata
        )

    # ---------------------------------
    # Read Channel-Scoped History
    # ---------------------------------

    def get_last_messages(
        self,
        channel_account_id,
        external_user_id,
        limit=10
    ):
        external_user_id = (
            self._normalize_external_user_id(
                external_user_id
            )
        )

        try:
            limit = int(limit)
        except (TypeError, ValueError) as error:
            raise ValueError(
                "Message limit must be an integer"
            ) from error

        if limit <= 0:
            return []

        conn = self._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            m.role,
                            m.content,
                            m.message_type,
                            m.direction
                        FROM messages m
                        JOIN conversations cv
                          ON cv.id = m.conversation_id
                        JOIN channel_contacts cc
                          ON cc.id = cv.channel_contact_id
                        WHERE cc.channel_account_id = %s
                          AND cc.external_user_id = %s
                        ORDER BY m.id DESC
                        LIMIT %s
                        """,
                        (
                            channel_account_id,
                            external_user_id,
                            limit,
                        )
                    )

                    rows = cursor.fetchall()

            rows.reverse()

            return [
                {
                    "role": role,
                    "content": content,
                    "message_type": message_type,
                    "direction": direction,
                }
                for (
                    role,
                    content,
                    message_type,
                    direction,
                ) in rows
            ]

        finally:
            self._release_connection(conn)

    # ---------------------------------
    # Resolve Tenant Context
    # ---------------------------------

    def get_channel_context(
        self,
        channel_account_id,
        external_user_id
    ):
        external_user_id = (
            self._normalize_external_user_id(
                external_user_id
            )
        )
        conn = self._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            ca.client_id,
                            ca.platform,
                            cc.id,
                            cc.customer_id
                        FROM channel_contacts cc
                        JOIN channel_accounts ca
                          ON ca.id = cc.channel_account_id
                        WHERE cc.channel_account_id = %s
                          AND cc.external_user_id = %s
                        """,
                        (
                            channel_account_id,
                            external_user_id,
                        )
                    )

                    row = cursor.fetchone()

            if row is None:
                return None

            return {
                "client_id": row[0],
                "platform": row[1],
                "channel_contact_id": row[2],
                "customer_id": row[3],
            }

        finally:
            self._release_connection(conn)

    # ---------------------------------
    # Durable Reply-Job State Machine
    # ---------------------------------

    def claim_next_due_reply_job(
        self,
        channel_account_id,
        worker_id,
        stale_after_seconds=300,
        external_user_id=None
    ):
        """
        Atomically claim one due account-scoped reply job without requiring the
        channel adapter to replay its inbound event.

        FOR UPDATE SKIP LOCKED allows several workers to scan safely. The
        distributed account lease normally permits only one worker per account,
        while this row-level claim remains the final job-level protection.
        """
        worker_id = str(worker_id or "").strip()

        if not worker_id:
            raise ValueError(
                "worker_id is required"
            )

        stale_after_seconds = max(
            1,
            int(stale_after_seconds)
        )

        if external_user_id is not None:
            external_user_id = (
                self._normalize_external_user_id(
                    external_user_id
                )
            )

        conn = self._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            job.id,
                            job.status,
                            job.reply_text,
                            job.attempt_count,
                            inbound.external_message_id,
                            inbound.content,
                            inbound.message_type,
                            inbound.metadata,
                            cc.external_user_id,
                            cc.display_name,
                            ca.client_id,
                            ca.platform,
                            cc.customer_id
                        FROM message_reply_jobs job
                        JOIN messages inbound
                          ON inbound.id = job.inbound_message_id
                        JOIN conversations cv
                          ON cv.id = inbound.conversation_id
                        JOIN channel_contacts cc
                          ON cc.id = cv.channel_contact_id
                        JOIN channel_accounts ca
                          ON ca.id = cc.channel_account_id
                        WHERE cc.channel_account_id = %s
                          AND ca.status = 'active'
                          AND inbound.role = 'user'
                          AND inbound.external_message_id IS NOT NULL
                          AND job.status IN (
                              'pending',
                              'processing',
                              'reply_ready',
                              'failed'
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
                                  - (%s * INTERVAL '1 second')
                              )
                          )
                          AND (
                              %s IS NULL
                              OR cc.external_user_id = %s
                          )
                        ORDER BY
                            CASE
                                WHEN job.reply_text IS NOT NULL THEN 0
                                ELSE 1
                            END,
                            COALESCE(
                                job.next_attempt_at,
                                CURRENT_TIMESTAMP
                            ),
                            job.id
                        FOR UPDATE OF job SKIP LOCKED
                        LIMIT 1
                        """,
                        (
                            channel_account_id,
                            stale_after_seconds,
                            external_user_id,
                            external_user_id,
                        )
                    )

                    row = cursor.fetchone()

                    if row is None:
                        return None

                    (
                        job_id,
                        previous_status,
                        reply_text,
                        attempt_count,
                        external_message_id,
                        content,
                        message_type,
                        inbound_metadata,
                        claimed_external_user_id,
                        display_name,
                        client_id,
                        platform,
                        customer_id,
                    ) = row

                    action = (
                        "send_cached"
                        if reply_text is not None
                        else "generate"
                    )

                    cursor.execute(
                        """
                        UPDATE message_reply_jobs
                        SET
                            status = 'processing',
                            attempt_count = attempt_count + 1,
                            worker_id = %s,
                            locked_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP,
                            last_error = NULL
                        WHERE id = %s
                        RETURNING attempt_count
                        """,
                        (
                            worker_id,
                            job_id,
                        )
                    )
                    claimed_attempt_count = (
                        cursor.fetchone()[0]
                    )

                    return {
                        "job_id": job_id,
                        "action": action,
                        "status": "processing",
                        "previous_status": previous_status,
                        "reply_text": reply_text,
                        "attempt_count": (
                            claimed_attempt_count
                        ),
                        "external_message_id": (
                            external_message_id
                        ),
                        "content": content,
                        "message_type": message_type,
                        "inbound_metadata": (
                            inbound_metadata or {}
                        ),
                        "external_user_id": (
                            claimed_external_user_id
                        ),
                        "display_name": display_name,
                        "client_id": client_id,
                        "platform": platform,
                        "customer_id": customer_id,
                    }

        finally:
            self._release_connection(conn)

    def claim_reply_job(
        self,
        channel_account_id,
        external_user_id,
        external_message_id,
        worker_id,
        stale_after_seconds=300
    ):
        external_user_id = (
            self._normalize_external_user_id(
                external_user_id
            )
        )
        external_message_id = (
            self._normalize_external_message_id(
                external_message_id
            )
        )
        worker_id = str(worker_id or "").strip()

        if external_message_id is None:
            raise ValueError(
                "external_message_id is required to claim a reply job"
            )

        if not worker_id:
            raise ValueError(
                "worker_id is required"
            )

        stale_after_seconds = max(
            1,
            int(stale_after_seconds)
        )
        conn = self._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT
                            job.id,
                            job.status,
                            job.reply_text,
                            job.attempt_count,
                            (
                                job.locked_at IS NULL
                                OR job.locked_at < (
                                    CURRENT_TIMESTAMP
                                    - (%s * INTERVAL '1 second')
                                )
                            ) AS lock_is_stale,
                            (
                                job.next_attempt_at
                                <= CURRENT_TIMESTAMP
                            ) AS retry_is_due
                        FROM message_reply_jobs job
                        JOIN messages inbound
                          ON inbound.id = job.inbound_message_id
                        JOIN conversations cv
                          ON cv.id = inbound.conversation_id
                        JOIN channel_contacts cc
                          ON cc.id = cv.channel_contact_id
                        WHERE cc.channel_account_id = %s
                          AND cc.external_user_id = %s
                          AND inbound.external_message_id = %s
                        FOR UPDATE OF job
                        """,
                        (
                            stale_after_seconds,
                            channel_account_id,
                            external_user_id,
                            external_message_id,
                        )
                    )

                    row = cursor.fetchone()

                    if row is None:
                        return None

                    (
                        job_id,
                        status,
                        reply_text,
                        attempt_count,
                        lock_is_stale,
                        retry_is_due,
                    ) = row

                    if status in {
                        "sent",
                        "cancelled",
                    }:
                        return {
                            "job_id": job_id,
                            "action": "skip",
                            "status": status,
                            "reply_text": reply_text,
                            "attempt_count": attempt_count,
                        }

                    if not retry_is_due:
                        return {
                            "job_id": job_id,
                            "action": "retry_later",
                            "status": status,
                            "reply_text": reply_text,
                            "attempt_count": attempt_count,
                        }

                    if (
                        status == "processing"
                        and not lock_is_stale
                    ):
                        return {
                            "job_id": job_id,
                            "action": "skip",
                            "status": status,
                            "reply_text": reply_text,
                            "attempt_count": attempt_count,
                        }

                    action = (
                        "send_cached"
                        if reply_text is not None
                        else "generate"
                    )

                    cursor.execute(
                        """
                        UPDATE message_reply_jobs
                        SET
                            status = 'processing',
                            attempt_count = attempt_count + 1,
                            worker_id = %s,
                            locked_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP,
                            last_error = NULL
                        WHERE id = %s
                        RETURNING attempt_count
                        """,
                        (
                            worker_id,
                            job_id,
                        )
                    )

                    claimed_attempt = cursor.fetchone()[0]

                    return {
                        "job_id": job_id,
                        "action": action,
                        "status": "processing",
                        "reply_text": reply_text,
                        "attempt_count": claimed_attempt,
                    }

        finally:
            self._release_connection(conn)

    def save_ai_reply_and_mark_ready(
        self,
        channel_account_id,
        external_user_id,
        job_id,
        worker_id,
        reply_text,
        message_type="text",
        metadata=None
    ):
        external_user_id = (
            self._normalize_external_user_id(
                external_user_id
            )
        )
        worker_id = str(worker_id or "").strip()
        self._validate_message_type(message_type)

        if not worker_id:
            raise ValueError(
                "worker_id is required"
            )

        if reply_text is None:
            raise ValueError(
                "reply_text cannot be None"
            )

        metadata = metadata or {}
        conn = self._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT cv.id
                        FROM message_reply_jobs job
                        JOIN messages inbound
                          ON inbound.id = job.inbound_message_id
                        JOIN conversations cv
                          ON cv.id = inbound.conversation_id
                        JOIN channel_contacts cc
                          ON cc.id = cv.channel_contact_id
                        WHERE job.id = %s
                          AND job.status = 'processing'
                          AND job.worker_id = %s
                          AND cc.channel_account_id = %s
                          AND cc.external_user_id = %s
                        FOR UPDATE OF job
                        """,
                        (
                            job_id,
                            worker_id,
                            channel_account_id,
                            external_user_id,
                        )
                    )

                    row = cursor.fetchone()

                    if row is None:
                        raise RuntimeError(
                            "Reply job is not claimed by this worker"
                        )

                    conversation_id = row[0]

                    cursor.execute(
                        """
                        INSERT INTO messages (
                            conversation_id,
                            role,
                            content,
                            direction,
                            message_type,
                            metadata
                        )
                        VALUES (
                            %s,
                            'assistant',
                            %s,
                            'outbound',
                            %s,
                            %s
                        )
                        """,
                        (
                            conversation_id,
                            reply_text,
                            message_type,
                            Json(metadata),
                        )
                    )

                    cursor.execute(
                        """
                        UPDATE message_reply_jobs
                        SET
                            status = 'reply_ready',
                            reply_text = %s,
                            worker_id = NULL,
                            locked_at = NULL,
                            last_error = NULL,
                            next_attempt_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                        """,
                        (
                            reply_text,
                            job_id,
                        )
                    )

                    cursor.execute(
                        """
                        UPDATE conversations
                        SET updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                        """,
                        (conversation_id,)
                    )

                    return True

        finally:
            self._release_connection(conn)

    def mark_reply_generation_failed(
        self,
        job_id,
        worker_id,
        error,
        retry_after_seconds=30
    ):
        retry_after_seconds = max(
            1,
            int(retry_after_seconds)
        )
        conn = self._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE message_reply_jobs
                        SET
                            status = 'failed',
                            last_error = %s,
                            worker_id = NULL,
                            locked_at = NULL,
                            next_attempt_at = (
                                CURRENT_TIMESTAMP
                                + (%s * INTERVAL '1 second')
                            ),
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                          AND status = 'processing'
                          AND worker_id = %s
                        """,
                        (
                            str(error),
                            retry_after_seconds,
                            job_id,
                            worker_id,
                        )
                    )

                    return cursor.rowcount == 1

        finally:
            self._release_connection(conn)

    def mark_reply_sent(
        self,
        job_id,
        outbound_external_message_id=None
    ):
        outbound_external_message_id = (
            self._normalize_external_message_id(
                outbound_external_message_id
            )
        )
        conn = self._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE message_reply_jobs
                        SET
                            status = 'sent',
                            outbound_external_message_id = %s,
                            worker_id = NULL,
                            locked_at = NULL,
                            last_error = NULL,
                            sent_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                          AND status IN (
                              'reply_ready',
                              'processing'
                          )
                        """,
                        (
                            outbound_external_message_id,
                            job_id,
                        )
                    )

                    return cursor.rowcount == 1

        finally:
            self._release_connection(conn)

    def mark_reply_delivery_failed(
        self,
        job_id,
        error,
        retry_after_seconds=30
    ):
        retry_after_seconds = max(
            1,
            int(retry_after_seconds)
        )
        conn = self._get_connection()

        try:
            with conn:
                with conn.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE message_reply_jobs
                        SET
                            status = 'reply_ready',
                            last_error = %s,
                            worker_id = NULL,
                            locked_at = NULL,
                            next_attempt_at = (
                                CURRENT_TIMESTAMP
                                + (%s * INTERVAL '1 second')
                            ),
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                          AND reply_text IS NOT NULL
                          AND status IN (
                              'reply_ready',
                              'processing'
                          )
                        """,
                        (
                            str(error),
                            retry_after_seconds,
                            job_id,
                        )
                    )

                    return cursor.rowcount == 1

        finally:
            self._release_connection(conn)

    # ---------------------------------
    # Close Database Pool
    # ---------------------------------

    def close(self):
        if self.db_pool is not None:
            self.db_pool.closeall()
            self.db_pool = None

            print(
                "PostgreSQL connection pool closed"
            )
