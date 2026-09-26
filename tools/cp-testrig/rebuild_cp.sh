#!/bin/sh
# Assembles the Control Plane sandbox inside /tmp/p13 on top of rebuild.sh.
# Run AFTER tools/cp-testrig/rebuild.sh, from the website repo root:
#   sh tools/cp-testrig/rebuild.sh && sh tools/cp-testrig/rebuild_cp.sh
# Then apply any NEW patcher: cd /tmp/p13 && node /path/to/tools/patchers/add_batch_XXX.mjs
set -e
cd "$(dirname "$0")/../.."
CP=/tmp/p13/OmniFlow-Control-Plane

# Base reference copies (older era; the chain below brings them current).
cp omniflow-backend-patch/app.py omniflow-backend-patch/connector_api.py "$CP/"

# Modules that only exist as NEW-file sections inside patchers.
node --input-type=module -e '
import fs from "fs";
function extract(file, decl, out) {
  const src = fs.readFileSync(file, "utf8");
  const start = src.indexOf(decl) + decl.length;
  const end = src.indexOf("`;", start);
  const body = src.slice(start, end).replace(/\\`/g, "`").replace(/\\\$\{/g, "${}");
  fs.writeFileSync(out, body.replace(/\r\n/g, "\n"));
}
extract("tools/patchers/add_growth_ops.mjs", "const PY_MODULE = `", "/tmp/p13/OmniFlow-Control-Plane/portal_growth.py");
extract("tools/patchers/add_knowledge_base.mjs", "const MODULE_FILE = `", "/tmp/p13/OmniFlow-Control-Plane/portal_kb.py");
'
python3 -m py_compile "$CP/portal_growth.py" "$CP/portal_kb.py"

# The rig portal_conversations.py predates the customers section: append it.
node --input-type=module -e '
import fs from "fs";
const src = fs.readFileSync("tools/patchers/add_customers_page.mjs", "utf8");
const start = src.indexOf("const CP_CUSTOMERS_APPEND = `") + "const CP_CUSTOMERS_APPEND = `".length;
const end = src.indexOf("`;", start);
const append = src.slice(start, end).replace(/\\`/g, "`").replace(/\\\$\{/g, "${}");
const p = "/tmp/p13/OmniFlow-Control-Plane/portal_conversations.py";
let body = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
if (!body.includes("customers/import")) {
  fs.writeFileSync(p, body + "\n\n" + append.replace(/\r\n/g, "\n") + "\n");
}
'

# Early-era saved replies: the rig reconstruction predates the section, and
# batch 281-295 upgrades it (edit + usage stats), so the base must exist.
node --input-type=module -e '
import fs from "fs";
const src = fs.readFileSync("tools/patchers/add_saved_replies.mjs", "utf8");
const start = src.indexOf("const CP_SAVED_REPLIES_APPEND = `") + "const CP_SAVED_REPLIES_APPEND = `".length;
const end = src.indexOf("`;", start);
const append = src.slice(start, end).replace(/\\`/g, "`").replace(/\\\$\{/g, "${}");
const p = "/tmp/p13/OmniFlow-Control-Plane/portal_conversations.py";
let body = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
if (!/^import re$/m.test(body)) {
  body = body.replace(/^import io$/m, "import io\nimport re");
}
if (!body.includes("saved-replies")) {
  fs.writeFileSync(p, body + append.replace(/\r\n/g, "\n") + "\n");
}
'

# Rig portal_db.py predates the growth-era constants and lazy DDL.
python3 - <<'PYEOF'
p = "/tmp/p13/OmniFlow-Control-Plane/portal_db.py"
s = open(p).read()
if "BROADCASTS_TABLE" not in s:
    s = s.replace('USER_EMAIL_COL = os.environ.get("OF_USER_EMAIL_COL", "email")',
'''USER_EMAIL_COL = os.environ.get("OF_USER_EMAIL_COL", "email")
NOTES_TABLE = os.environ.get("OF_NOTES_TABLE", "portal_conversation_notes")
BROADCASTS_TABLE = os.environ.get("OF_BROADCASTS_TABLE", "portal_broadcasts")
GAPS_TABLE = os.environ.get("OF_GAPS_TABLE", "portal_kb_gaps")
CSAT_TABLE = os.environ.get("OF_CSAT_TABLE", "portal_csat_requests")
SAVED_REPLIES_TABLE = os.environ.get("OF_SAVED_REPLIES_TABLE", "portal_saved_replies")''')
    ddl_anchor = '''CREATE INDEX IF NOT EXISTS idx_portal_messages_conv
  ON portal_messages (conversation_id, id);
"""'''
    ddl_new = '''CREATE INDEX IF NOT EXISTS idx_portal_messages_conv
  ON portal_messages (conversation_id, id);
CREATE TABLE IF NOT EXISTS portal_conversation_notes (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  author_email TEXT,
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_conv_notes
  ON portal_conversation_notes (conversation_id, id DESC);
CREATE TABLE IF NOT EXISTS portal_broadcasts (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all',
  body TEXT NOT NULL,
  recipient_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_portal_broadcasts
  ON portal_broadcasts (client_id, id DESC);
CREATE TABLE IF NOT EXISTS portal_kb_gaps (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL DEFAULT 'general',
  resolved INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_portal_kb_gaps
  ON portal_kb_gaps (client_id, resolved, id DESC);
CREATE TABLE IF NOT EXISTS portal_csat_requests (
  id BIGSERIAL PRIMARY KEY,
  client_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL UNIQUE,
  contact_id TEXT NOT NULL,
  contact_name TEXT,
  score INT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_portal_csat_requests
  ON portal_csat_requests (client_id, requested_at DESC);
"""'''
    assert ddl_anchor in s
    s = s.replace(ddl_anchor, ddl_new)
    open(p, "w").write(s)
    print("portal_db consts + DDL added")
PYEOF

# The reference app.py predates the growth registration the chain anchors on.
python3 - <<'PYEOF'
p = "/tmp/p13/OmniFlow-Control-Plane/app.py"
s = open(p).read()
if "portal_growth_bp" not in s:
    s = s.replace(
        "from portal_conversations import bp as portal_conversations_bp  # noqa: E402",
        "from portal_conversations import bp as portal_conversations_bp  # noqa: E402\nfrom portal_growth import bp as portal_growth_bp  # noqa: E402")
    s = s.replace(
        "aux_app.register_blueprint(portal_conversations_bp)",
        "aux_app.register_blueprint(portal_conversations_bp)\naux_app.register_blueprint(portal_growth_bp)")
    open(p, "w").write(s)
    print("app.py growth lines added")
PYEOF
python3 -m py_compile "$CP/app.py" "$CP/portal_db.py" "$CP/portal_conversations.py"

# Laptop bridge simulation (only its shape is asserted by the tests).
mkdir -p /tmp/p13/src
cat > /tmp/p13/src/control_plane_bridge.py <<'EOF'
"""Laptop bridge simulation: polls the control plane and drives WhatsApp."""

from prefect_gmail_types import OutboundMessage


class ControlPlaneBridge:
    def process_due_followups(self, adapter):
        pass

    def process_due_away(self, adapter):
        for away_id, note in self.due_away:
            self.send_outbound(adapter, note)
            self.acknowledge_away(away_id, success, note)

    def send_outbound(self, adapter, to, body):
        message = OutboundMessage(to=to, body=body)
        adapter.send(message)
        self.ingest_outbound(message)

    def ingest_outbound(self, message):
        self.store.append(direction="out", body=message.body)

    def acknowledge_away(self, away_id, success, note):
        pass

    def acknowledge_followup(self, followup_id, success, note):
        pass

    def run_due_commands(
        self,
    ):
        pass

    def poll_once(self, adapter):
        self.process_due_followups(adapter)
        self.process_due_away(adapter)
        self.run_due_commands(adapter)
EOF

# Era chain: each patcher is idempotent, run them all in delivery order.
cd /tmp/p13
for b in add_batch_101_105 add_batch_111_114 add_batch_115_116 \
         add_batch_121_125 add_batch_126_130 add_batch_136_140 \
         add_batch_141_145 add_batch_146_150 add_batch_151_155; do
  echo "== $b"
  node /home/user/Omniflow/$b.mjs 2>&1 | tail -1
done
if [ -f /home/user/Omniflow/add_batch_156_160.mjs ]; then
  echo "== add_batch_156_160"
  node /home/user/Omniflow/add_batch_156_160.mjs 2>&1 | tail -1
fi

cd /tmp/p13/OmniFlow-Control-Plane
export OMNIFLOW_SERVICE_KEY=x
python3 test_perf.py >/dev/null 2>&1 || true
echo "CP SANDBOX READY (run the sweep: for t in test_*.py; do python3 \$t; done)"
