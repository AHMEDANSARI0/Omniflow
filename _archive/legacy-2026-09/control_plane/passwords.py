import base64
import hashlib
import hmac
import secrets


SCHEME = "scrypt"
VERSION = 1
N = 16384
R = 8
P = 1
SALT_BYTES = 16
KEY_BYTES = 32
MAX_MEMORY_BYTES = 64 * 1024 * 1024


class PasswordValidationError(ValueError):
    pass


def validate_password(password):
    if not isinstance(
        password,
        str,
    ):
        raise PasswordValidationError(
            "password must be text"
        )

    if len(password) < 10:
        raise PasswordValidationError(
            "password must contain "
            "at least 10 characters"
        )

    if len(password) > 1024:
        raise PasswordValidationError(
            "password is too long"
        )

    if password.strip() != password:
        raise PasswordValidationError(
            "password cannot start or "
            "end with whitespace"
        )

    return password


def _encode(value):
    return (
        base64
        .urlsafe_b64encode(value)
        .decode("ascii")
        .rstrip("=")
    )


def _decode(value):
    padding = "=" * (
        -len(value) % 4
    )

    try:
        return (
            base64
            .urlsafe_b64decode(
                value + padding
            )
        )

    except Exception as error:
        raise PasswordValidationError(
            "password hash contains "
            "invalid base64"
        ) from error


def _derive(
    password,
    salt,
    n=N,
    r=R,
    p=P,
):
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=int(n),
        r=int(r),
        p=int(p),
        dklen=KEY_BYTES,
        maxmem=MAX_MEMORY_BYTES,
    )


def hash_password(password):
    password = validate_password(
        password
    )

    salt = secrets.token_bytes(
        SALT_BYTES
    )

    derived = _derive(
        password,
        salt,
    )

    return (
        f"{SCHEME}$"
        f"v={VERSION}$"
        f"n={N}$"
        f"r={R}$"
        f"p={P}$"
        f"{_encode(salt)}$"
        f"{_encode(derived)}"
    )


def parse_password_hash(encoded):
    parts = str(
        encoded or ""
    ).split("$")

    if (
        len(parts) != 7
        or parts[0] != SCHEME
    ):
        raise PasswordValidationError(
            "unsupported password "
            "hash format"
        )

    try:
        version = int(
            parts[1].split(
                "=",
                1,
            )[1]
        )

        n = int(
            parts[2].split(
                "=",
                1,
            )[1]
        )

        r = int(
            parts[3].split(
                "=",
                1,
            )[1]
        )

        p = int(
            parts[4].split(
                "=",
                1,
            )[1]
        )

    except (
        IndexError,
        ValueError,
    ) as error:
        raise PasswordValidationError(
            "invalid password "
            "hash parameters"
        ) from error

    salt = _decode(
        parts[5]
    )

    expected = _decode(
        parts[6]
    )

    if version != VERSION:
        raise PasswordValidationError(
            "unsupported password "
            "hash version"
        )

    if (
        n <= 1
        or n & (n - 1)
        or n > N * 4
        or r <= 0
        or r > 32
        or p <= 0
        or p > 16
    ):
        raise PasswordValidationError(
            "unsafe password "
            "hash parameters"
        )

    if (
        len(salt) < 16
        or len(expected) != KEY_BYTES
    ):
        raise PasswordValidationError(
            "invalid password "
            "hash material"
        )

    return {
        "version": version,
        "n": n,
        "r": r,
        "p": p,
        "salt": salt,
        "expected": expected,
    }


def verify_password(
    password,
    encoded,
):
    if not isinstance(
        password,
        str,
    ):
        return False

    try:
        parsed = parse_password_hash(
            encoded
        )

        actual = _derive(
            password,
            parsed["salt"],
            n=parsed["n"],
            r=parsed["r"],
            p=parsed["p"],
        )

    except (
        PasswordValidationError,
        ValueError,
    ):
        return False

    return hmac.compare_digest(
        actual,
        parsed["expected"],
    )


def password_hash_needs_upgrade(
    encoded,
):
    try:
        parsed = parse_password_hash(
            encoded
        )

    except PasswordValidationError:
        return True

    return (
        parsed["version"] != VERSION
        or parsed["n"] != N
        or parsed["r"] != R
        or parsed["p"] != P
    )