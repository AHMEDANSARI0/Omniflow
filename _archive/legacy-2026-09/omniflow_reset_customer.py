#!/usr/bin/env python3
"""
OmniFlow — customer email find + password reset helper (run on YOUR laptop only).

Kya karta hai:
  1. Neon se connect karta hai (env vars se — koi secret file mein nahi)
  2. users/accounts/customers table + email/password columns KHUD detect karta hai
  3. Saare customers ki list dikhata hai (email, role, client_id — passwords nahi)
  4. Jo email chuno uske liye naya password set kar deta hai (werkzeug hash —
     same scheme jo login verify karta hai)

Chalane se pehle (PowerShell):
  cd <jahan yeh file hai>
  pip install psycopg2-binary werkzeug
  $env:DB_HOST="..."        # Vercel > Control Plane project > Settings > Environment Variables
  $env:DB_PORT="5432"
  $env:DB_NAME="..."
  $env:DB_USER="..."
  $env:DB_PASSWORD="..."
  $env:PGSSLMODE="require"
  python omniflow_reset_customer.py

⚠️  Env vars apne terminal mein dalo — CHAT MEIN KABHI NA BHEJNA (safety rule).
"""

import getpass
import os
import sys


def fail(message: str):
    print("\nERROR: " + message)
    sys.exit(1)


def main():
    required = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]
    missing = [n for n in required if not os.environ.get(n)]
    if missing:
        fail(
            "Yeh env vars set nahi hain: " + ", ".join(missing)
            + "\nPowerShell mein: $env:NAAM=\"value\" (Vercel Control Plane project ke"
              " Environment Variables se values lo — chat mein kabhi na bhejo)."
        )

    try:
        import psycopg2
    except ImportError:
        fail("psycopg2 missing. Chalayen: pip install psycopg2-binary")

    try:
        conn = psycopg2.connect(
            host=os.environ["DB_HOST"],
            port=int(os.environ.get("DB_PORT", "5432")),
            dbname=os.environ["DB_NAME"],
            user=os.environ["DB_USER"],
            password=os.environ["DB_PASSWORD"],
            sslmode=os.environ.get("PGSSLMODE", "require"),
            connect_timeout=15,
        )
    except Exception as exc:
        fail(f"DB connect nahi hua: {exc}")

    # auto-commit off; explicit commit for the UPDATE
    conn.autocommit = False
    cur = conn.cursor()

    # ---- 1) find candidate tables --------------------------------------
    cur.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' AND ("
        "  table_name ILIKE '%user%' OR table_name ILIKE '%account%'"
        "  OR table_name ILIKE '%customer%') ORDER BY table_name"
    )
    tables = [r[0] for r in cur.fetchall()]
    if not tables:
        fail(
            "Koi users/account/customer table nahi mili. Neon console > SQL Editor chalayen:\n"
            "  SELECT table_name FROM information_schema.tables WHERE table_schema='public';\n"
            "Phir table ka naam mujhe bata do."
        )

    def pick(prompt, options):
        if len(options) == 1:
            print(f"  -> Detected: {options[0]}")
            return options[0]
        print(prompt)
        for i, opt in enumerate(options, 1):
            print(f"  {i}) {opt}")
        while True:
            s = input("  Number: ").strip()
            if s.isdigit() and 1 <= int(s) <= len(options):
                return options[int(s) - 1]
            print("  Invalid choice.")

    table = pick("Kaunsi table use karein?", tables)

    # ---- 2) detect columns ----------------------------------------------
    cur.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = %s ORDER BY ordinal_position",
        (table,),
    )
    cols = [r[0] for r in cur.fetchall()]

    def find(patterns):
        for p in patterns:
            for c in cols:
                if p in c.lower():
                    return c
        return None

    id_col = find(["id"]) or "id"
    email_col = find(["email", "login", "username"])
    pass_col = find(["password", "passwd", "pwd"])
    name_col = find(["display_name", "full_name", "customer_name", "name"])
    role_col = find(["role"])
    client_col = find(["client_id", "tenant_id", "account_id", "workspace"])

    if not email_col:
        fail(f"'{table}' mein email column nahi mila. Columns: {cols}")
    if not pass_col:
        fail(f"'{table}' mein password column nahi mila. Columns: {cols}")

    print("\nDetected columns:")
    print(f"  table   : {table}")
    print(f"  id      : {id_col}")
    print(f"  email   : {email_col}")
    print(f"  password: {pass_col}")
    if role_col:
        print(f"  role    : {role_col}")
    if client_col:
        print(f"  client  : {client_col}")

    # ---- 3) list customers ----------------------------------------------
    cols_sel = [id_col, email_col]
    for extra in (name_col, role_col, client_col):
        if extra and extra not in cols_sel:
            cols_sel.append(extra)
    sel_sql = "SELECT " + ", ".join(f'"{c}"' for c in cols_sel) + f' FROM "{table}" ORDER BY "{id_col}" LIMIT 50'

    cur.execute(sel_sql)
    rows = cur.fetchall()
    if not rows:
        fail("Table khali hai — koi customer maujood nahi.")

    print(f"\nCustomers ({len(rows)}):")
    print("  " + " | ".join(str(c) for c in cols_sel))
    for r in rows:
        print("  " + " | ".join(str(v) if v is not None else "-" for v in r))

    # ---- 4) reset password ----------------------------------------------
    print("\nKis customer ka password reset karna hai? (email paste karo, blank = exit)")
    target = input("Email: ").strip().lower()
    if not target:
        print("Kuch nahi kiya. Bye!")
        return

    cur.execute(f'SELECT "{id_col}" FROM "{table}" WHERE lower("{email_col}") = %s', (target,))
    row = cur.fetchone()
    if not row:
        fail(f"'{target}' is table mein nahi mili. Upar wali list se sahi email copy karo.")

    user_id = row[0]
    new_pass = getpass.getpass("Naya password (8+ chars): ")
    confirm = getpass.getpass("Dobara likhein: ")
    if new_pass != confirm:
        fail("Passwords match nahi hua — dobara chalao.")
    if len(new_pass) < 8:
        fail("Password kam se kam 8 characters ka ho.")

    try:
        from werkzeug.security import generate_password_hash
    except ImportError:
        fail("werkzeug missing. Chalayen: pip install werkzeug")

    new_hash = generate_password_hash(new_pass)
    cur.execute(
        f'UPDATE "{table}" SET "{pass_col}" = %s WHERE "{id_col}" = %s',
        (new_hash, user_id),
    )
    conn.commit()
    print("\n✅ Password reset ho gaya for:", target)
    print("Ab login karein: https://omniflow-bice.vercel.app/dashboard/login")
    print("Note: agar 'account locked' aaye toh ~15 min wait kar ke try karein.")
    conn.close()


if __name__ == "__main__":
    main()
