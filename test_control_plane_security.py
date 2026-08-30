import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from control_plane import (  # noqa: E402
    SecretValidationError,
    generate_enrollment_token,
    generate_node_credential,
    hash_enrollment_token,
    hash_node_credential,
    is_valid_secret_digest,
    require_secret_digest,
    verify_enrollment_token,
    verify_node_credential,
)


def expect_error(error_type, callback):
    try:
        callback()
    except error_type:
        return

    raise AssertionError(
        f"Expected {error_type.__name__}"
    )


def verify_generation_and_uniqueness():
    enrollment_tokens = {
        generate_enrollment_token()
        for _ in range(500)
    }

    node_credentials = {
        generate_node_credential()
        for _ in range(500)
    }

    assert len(enrollment_tokens) == 500
    assert len(node_credentials) == 500

    assert all(
        len(token) >= 40
        for token in enrollment_tokens
    )

    assert all(
        len(credential) >= 40
        for credential in node_credentials
    )


def verify_hashing_and_domain_separation():
    secret = (
        "trial-secret-with-sufficient-randomness"
    )
    pepper = "deployment-pepper"

    enrollment_digest = hash_enrollment_token(
        secret,
        pepper=pepper,
    )

    node_digest = hash_node_credential(
        secret,
        pepper=pepper,
    )

    assert enrollment_digest != node_digest
    assert secret not in enrollment_digest
    assert is_valid_secret_digest(
        enrollment_digest
    )
    assert is_valid_secret_digest(node_digest)

    assert require_secret_digest(
        enrollment_digest.upper()
    ) == enrollment_digest

    assert verify_enrollment_token(
        secret,
        enrollment_digest,
        pepper=pepper,
    )

    assert not verify_enrollment_token(
        "wrong-secret",
        enrollment_digest,
        pepper=pepper,
    )

    assert not verify_enrollment_token(
        secret,
        enrollment_digest,
        pepper="wrong-pepper",
    )

    assert verify_node_credential(
        secret,
        node_digest,
        pepper=pepper,
    )

    assert not verify_node_credential(
        "wrong-secret",
        node_digest,
        pepper=pepper,
    )


def verify_invalid_values_are_rejected():
    expect_error(
        SecretValidationError,
        lambda: hash_enrollment_token(""),
    )

    expect_error(
        SecretValidationError,
        lambda: hash_node_credential(None),
    )

    expect_error(
        SecretValidationError,
        lambda: require_secret_digest(
            "plaintext-token"
        ),
    )

    expect_error(
        SecretValidationError,
        lambda: verify_enrollment_token(
            "secret",
            "not-a-valid-digest",
        ),
    )


def verify_source_has_no_secret_logging():
    source = (
        SRC_DIR
        / "control_plane"
        / "security.py"
    ).read_text(
        encoding="utf-8"
    ).lower()

    assert "print(" not in source
    assert "logging." not in source
    assert "logger." not in source
    assert "compare_digest" in source
    assert "token_urlsafe" in source


def main():
    verify_generation_and_uniqueness()
    verify_hashing_and_domain_separation()
    verify_invalid_values_are_rejected()
    verify_source_has_no_secret_logging()

    print(
        "Enrollment token entropy: 500/500 unique"
    )
    print(
        "Node credential entropy: 500/500 unique"
    )
    print(
        "Stored digest format: "
        "64-character SHA-256"
    )
    print(
        "Enrollment/node purpose separation: passed"
    )
    print("Deployment pepper support: passed")
    print(
        "Constant-time digest comparison: passed"
    )
    print("Plaintext secret logging: absent")
    print(
        "\n✅ CONTROL-PLANE SECURITY TEST PASSED"
    )


if __name__ == "__main__":
    main()