"""Tests for customer CSV import/export (Phases 136-140)."""
import sys

from flask import Flask

import portal_conversations
import test_lib
from test_lib import check, human_principal, install_db_stub, PrincipalStub, status, summary, portal_page_source

app = Flask(__name__)
app.register_blueprint(portal_conversations.bp)
client = app.test_client()

human = human_principal(client_id=1, user_id=11, email="ahmed@example.com")
PrincipalStub(portal_conversations, principal=human)


def fresh(script):
    return install_db_stub(portal_conversations, script)


print("== phone normalization ==")

norm = portal_conversations._normalize_pk_phone
check("0300 format", norm("03001234567") == "923001234567", norm("03001234567"))
check("92 format", norm("923001234567") == "923001234567")
check("+92 spaced", norm("+92 300 1234567") == "923001234567")
check("0092 format", norm("00923001234567") == "923001234567")
check("bare 3xxx", norm("3001234567") == "923001234567")
check("short rejected", norm("0300123") is None)
check("landline rejected", norm("02134567890") is None, norm("02134567890"))
check("empty rejected", norm("") is None)

print("== import endpoint ==")

ROWS = [
    {"name": "Ali", "phone": "03001234567"},
    {"name": "Sara", "phone": "+92 301 7654321"},
]
CREATED_ROWS = [{"created": True}, {"created": False}]
conn = fresh([CREATED_ROWS, [], []])
response = client.post("/api/v1/portal/customers/import", json={"customers": ROWS})
check("200 import", status(response) == 200, status(response))
body = response.get_json()
check("created/merged counted", body["created"] == 1 and body["merged"] == 1, body)
insert_sql = conn.cur.executed[0][0]
check("upsert conflict clause", "ON CONFLICT (client_id, channel, contact_id)" in insert_sql)
check("contact id c.us", conn.cur.executed[0][1][1] == "923001234567@c.us",
      conn.cur.executed[0][1])
check("audit logged", conn.cur.executed[2][1][1] == "customers.imported", conn.cur.executed[2][1])

conn = fresh([[], []])
response = client.post("/api/v1/portal/customers/import",
                       json={"customers": [{"name": "X", "phone": "123"}]})
check("invalid reported", status(response) == 200
      and response.get_json()["invalid_count"] == 1
      and response.get_json()["invalid"][0]["row"] == 1, response.get_json())

conn = fresh([[], []])
response = client.post("/api/v1/portal/customers/import", json={"customers": []})
check("400 empty list", status(response) == 400, status(response))

conn = fresh([[], []])
response = client.post("/api/v1/portal/customers/import",
                       json={"customers": [{"name": "x", "phone": "0300"} for _ in range(301)]})
check("400 over 300", status(response) == 400, status(response))

print("== export endpoint ==")

EXPORT_ROWS = [{"contact_id": "923001234567@c.us", "name": "Ali",
                "conversations": 2, "open_count": 1, "has_hot": True,
                "last_message_at": None}]
conn = fresh([EXPORT_ROWS])
response = client.get("/api/v1/portal/customers/export")
check("200 export csv", status(response) == 200
      and "text/csv" in response.content_type, status(response))
csv_text = response.data.decode("utf-8")
check("csv header", "contact_id,name,conversations,open_chats,hot_lead,last_message_at" in csv_text,
      csv_text[:90])
check("csv row", "923001234567@c.us,Ali,2,1,yes," in csv_text, csv_text[:120])
check("attachment header", "attachment" in response.headers.get("Content-Disposition", ""))
check("limit 2000", "LIMIT 2000" in conn.cur.executed[0][0])

PrincipalStub(portal_conversations, principal=None)
response = client.get("/api/v1/portal/customers/export")
check("401 without session", status(response) == 401, status(response))

print("== structural ==")
lib_src = open("/tmp/p13/Omniflow/lib/omniflow/portal.ts").read()
check("lib import fn", "export async function importCustomers(" in lib_src)
check("lib export fn", "export async function exportCustomersCsv(" in lib_src)
bff1 = open("/tmp/p13/Omniflow/app/api/omniflow/portal/customers/import/route.ts").read()
bff2 = open("/tmp/p13/Omniflow/app/api/omniflow/portal/customers/export/route.ts").read()
check("bff depths", bff1.count("../") == 18 and bff2.count("../") == 12,
      (bff1.count("../"), bff2.count("../")))
comp = open("/tmp/p13/Omniflow/app/dashboard/(portal)/customers/CustomersImport.tsx").read()
check("component parses csv", "function parseCsv(" in comp)
check("component sniffs phone col", "phone|number|mobile|whats" in comp)
check("component caps 300", "300" in comp)
page_src = portal_page_source("customers")
check("toolbar has import", "<CustomersImport" in page_src)
check("export kept", "exportCustomers()" in page_src)

failures = summary("customer_import")
sys.exit(1 if failures else 0)
