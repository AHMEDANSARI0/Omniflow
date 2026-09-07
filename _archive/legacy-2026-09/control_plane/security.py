import hashlib
import hmac
import secrets
import string
from typing import Optional, Union


_SECRET_BYTES = 32
_DIGEST_LENGTH = 64
_HEX_CHARACTERS = frozenset(string.hexdigits.lower())
_DOMAIN_PREFIX = b"omniflow-control-plane:v1"


class SecretValidationError(ValueError):
    """Raised when a control-plane secret or digest is malformed."""


def _required_secret(value, field_name):
    if isinstance(value, bytes):
        normalized = value
    elif isinstance(value, str):
        normalized = value.encode("utf-8")
    else:
        raise SecretValidationError(
            f"{field_name} must be text or bytes"
        )

    if not normalized:
        raise SecretValidationError(
            f"{field_name} is required"
        )

    return normalized


def _optional_pepper(value):
    if value is None:
        return b""

    return _required_secret(value, "pepper")


def _purpose_bytes(purpose):
    normalized = str(purpose or "").strip().lower()

    if normalized not in {
        "enrollment-token",
        "node-credential",
    }:
        raise SecretValidationError(
            "unsupported secret purpose"
        )

    return normalized.encode("ascii")


def generate_enrollment_token():
    """Create a short-lived, high-entropy pairing token."""
    return secrets.token_urlsafe(_SECRET_BYTES)


def generate_node_credential():
    """Create a high-entropy credential for a managed node."""
    return secrets.token_urlsafe(_SECRET_BYTES)


def hash_high_entropy_secret(
    secret: Union[str, bytes],
    purpose: str,
    pepper: Optional[Union[str, bytes]] = None,
):
    """
    Hash a generated high-entropy secret for durable storage.

    This is for random enrollment/node tokens, not user passwords.
    Dashboard passwords require a KDF such as Argon2id.
    """
    secret_bytes = _required_secret(secret, "secret")
    purpose_bytes = _purpose_bytes(purpose)
    pepper_bytes = _optional_pepper(pepper)

    material = b"\x00".join(
        (
            _DOMAIN_PREFIX,
            purpose_bytes,
            pepper_bytes,
            secret_bytes,
        )
    )

    return hashlib.sha256(material).hexdigest()


def hash_enrollment_token(token, pepper=None):
    return hash_high_entropy_secret(
        token,
        purpose="enrollment-token",
        pepper=pepper,
    )


def hash_node_credential(credential, pepper=None):
    return hash_high_entropy_secret(
        credential,
        purpose="node-credential",
        pepper=pepper,
    )


def is_valid_secret_digest(digest):
    normalized = str(digest or "").strip().lower()

    return (
        len(normalized) == _DIGEST_LENGTH
        and all(
            character in _HEX_CHARACTERS
            for character in normalized
        )
    )


def require_secret_digest(
    digest,
    field_name="secret_digest",
):
    normalized = str(digest or "").strip().lower()

    if not is_valid_secret_digest(normalized):
        raise SecretValidationError(
            f"{field_name} must be a "
            "64-character SHA-256 digest"
        )

    return normalized


def verify_high_entropy_secret(
    secret,
    expected_digest,
    purpose,
    pepper=None,
):
    expected = require_secret_digest(
        expected_digest
    )

    actual = hash_high_entropy_secret(
        secret,
        purpose=purpose,
        pepper=pepper,
    )

    return hmac.compare_digest(
        actual,
        expected,
    )


def verify_enrollment_token(
    token,
    expected_digest,
    pepper=None,
):
    return verify_high_entropy_secret(
        token,
        expected_digest,
        purpose="enrollment-token",
        pepper=pepper,
    )


def verify_node_credential(
    credential,
    expected_digest,
    pepper=None,
):
    return verify_high_entropy_secret(
        credential,
        expected_digest,
        purpose="node-credential",
        pepper=pepper,
    )   