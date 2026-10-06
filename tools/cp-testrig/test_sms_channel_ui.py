"""244 web pins: the SMS channel card on Settings, the two BFF routes, the
portal.ts client, the inbox filter label, the honest integrations entry and
the admin "Connect SMS" flow. Every field the web reads is checked against
the CP module's real payloads so the two sides cannot drift."""
import os
import re
import sys

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "x")
sys.path.insert(0, os.getcwd())

from test_lib import check, summary  # noqa: E402
import portal_sms as S  # noqa: E402
import portal_voice  # noqa: E402

ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))
CP = open(os.path.join(os.getcwd(), "portal_sms.py"), encoding="utf-8").read()


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


PORTAL = read("lib/omniflow/portal.ts")
WIRE = PORTAL[PORTAL.index("// §244 SMS channel"):]
BASE = "app/api/omniflow/portal/channels/sms/"
ROUTE = read(BASE + "route.ts")
TEST = read(BASE + "test/route.ts")
CARD = read("app/dashboard/(portal)/settings/SmsChannelCard.tsx")
PAGE = read("app/dashboard/(portal)/settings/page.tsx")
INBOX = read("app/dashboard/(portal)/conversations/InboxClient.tsx")
INTEG = read("lib/marketing/integrations.ts")
TYPES = read("lib/marketing/types.ts")
ADMIN_LIB = read("lib/omniflow/admin-control-plane.ts")
CONNECT = read("app/api/omniflow/admin/voice/twilio/connect/route.ts")
SECTION = read("app/admin/(panel)/integrations/TwilioNumbersSection.tsx")


def fields(name, text=WIRE):
    body = re.search(r"(?:export )?interface " + name + r" \{([^}]*)\}", text).group(1)
    return set(re.findall(r"^\s*([a-z_A-Z]+)\??:", body, re.M))


def cp_keys(start, end):
    block = CP[CP.index(start):CP.index(end, CP.index(start))]
    return set(re.findall(r'"([a-z_]+)":', block))


STATE = cp_keys("def _state(", "@bp.get(URL)")
RECENT = cp_keys("def _recent(", "def _state(")

print("== portal.ts ==")
check("one client per call, own names", all(WIRE.count("export function " + n + "(") == 1 for n in (
    "getSmsChannel", "saveSmsChannel", "testSmsChannel"))
      and PORTAL.count('const SMS_CHANNEL = "api/v1/portal/channels/sms";') == 1)
check("state type == the CP payload (no drift)", fields("SmsChannelState") == STATE,
      fields("SmsChannelState") ^ STATE)
check("recent row type == the CP rows", fields("SmsChannelRecent") == RECENT, fields("SmsChannelRecent") ^ RECENT)
check("input type == what the CP PUT reads", fields("SmsChannelInput") == {"enabled", "daily_limit"}
      and 'if "enabled" in payload:' in CP and 'if "daily_limit" in payload:' in CP)
check("test SMS gets a timeout above the CP's Twilio wait (15 s)",
      "SMS_CHANNEL_TIMEOUT_MS = 20_000" in WIRE and "}, SMS_CHANNEL_TIMEOUT_MS);" in WIRE
      and "urlopen(req, timeout=15)" in open(os.path.join(os.getcwd(), "portal_voice.py"), encoding="utf-8").read())

print("== BFF ==")
check("routes use the shared plumbing; writes are same-origin checked",
      all("withPortalToken(" in r and "serviceResponse(" in r for r in (ROUTE, TEST))
      and "}, request);" in ROUTE and "}, request);" in TEST
      and "export async function GET()" in ROUTE and "export async function PUT(request: Request)" in ROUTE
      and "export async function POST(request: Request)" in TEST)
check("PUT validates types before the CP: boolean switch, whole-number limit, nothing to save",
      'typeof body.enabled !== "boolean"' in ROUTE and "Number.isInteger(body.daily_limit)" in ROUTE
      and "body.daily_limit < 1" in ROUTE and 'bad("Nothing to save.")' in ROUTE)
check("PUT passes exactly the CP fields", "input.enabled = body.enabled;" in ROUTE
      and "input.daily_limit = body.daily_limit;" in ROUTE and ROUTE.count("input.") == 4)
check("test number check == the CP's E.164 rule", "/^\\+[1-9]\\d{7,14}$/" in TEST
      and "/^\\+[1-9]\\d{7,14}$/" in CARD and 'r"^\\+[1-9][0-9]{7,14}$"' in open(
          os.path.join(os.getcwd(), "portal_voice.py"), encoding="utf-8").read())
check("test route allows 30 s", "export const maxDuration = 30;" in TEST)
check("import depth matches the folder", ROUTE.count('"../../../../../../lib/omniflow/') == 4
      and TEST.count('"../../../../../../../lib/omniflow/') == 3 and "../../../../../../../../" not in TEST)

print("== card ==")
check("settings page renders the card once, after Email",
      PAGE.count("<SmsChannelCard />") == 1 and PAGE.index("<EmailChannelCard />") < PAGE.index("<SmsChannelCard />")
      and 'import SmsChannelCard from "./SmsChannelCard";' in PAGE)
used = set(re.findall(r"state\??\.([a-z_]+)", CARD))
check("card reads only fields the CP sends", used <= STATE, used - STATE)
rows = set(re.findall(r"row\.([a-z_]+)", CARD))
check("recent list reads only fields the CP sends", rows <= RECENT, rows - RECENT)
check("switch: editors only, cannot turn on before keys + number",
      'disabled={!canEdit || busy !== "" || !state || (!state.enabled && !ready)}' in CARD
      and 'state.twilio_ready && state.number !== ""' in CARD
      and "Only owners and admins can change the SMS channel." in CARD)
check("limit input bounded by the platform max", "limitNumber <= (state?.daily_max ?? 0)" in CARD)
check("honest copy: early access, STOP, MMS not shown, no two-way in Pakistan",
      "Early access" in CARD and "STOP" in CARD and "MMS are not shown" in CARD
      and "In Pakistan, for example" in CARD and "cannot reply" in CARD)
check("last error in the danger tone; delivery error codes shown",
      'className="text-danger">{state.last_error}' in CARD and "Twilio error " in CARD)
check("card on the house style (tokens, no raw colours)",
      "rounded-xl2 border border-line bg-white p-5 shadow-card" in CARD and "bg-brand-soft" in CARD
      and not re.search(r"#[0-9a-fA-F]{3,6}\b", CARD))
check("same-origin fetches only (relative API)", 'const API = "/api/omniflow/portal/channels/sms";' in CARD
      and "http" not in CARD and "dangerouslySetInnerHTML" not in CARD)

print("== inbox + integrations ==")
check("inbox filter shows SMS (not 'Sms')", '"email", "sms", "website"] as const;' in INBOX
      and 'value === "sms" ? "SMS" : value' in INBOX)
sms_entry = INTEG[INTEG.index('id: "sms"'):INTEG.index('id: "tiktok"')]
icon = re.search(r'icon: "([a-z-]+)"', sms_entry).group(1)
check("SMS listed as early access with an existing icon, honest about Pakistan",
      'status: "beta"' in sms_entry and 'category: "channels"' in sms_entry
      and ('"' + icon + '",') in TYPES and "not Pakistan" in sms_entry, icon)

print("== admin: Connect SMS ==")
twilio_keys = set(portal_voice.twilio_number_state({}, "")) | {"assigned_client_id"}
check("admin lib number type == the CP number state", fields("AdminTwilioNumber", ADMIN_LIB) == twilio_keys,
      fields("AdminTwilioNumber", ADMIN_LIB) ^ twilio_keys)
section_type = fields("TwilioNumber", SECTION)
check("panel number type == the CP number state", section_type == twilio_keys, section_type ^ twilio_keys)
check("list payload carries the SMS address (lib + panel)", "  sms_url: string;" in ADMIN_LIB
      and "  sms_url: string;" in SECTION and '"sms_url": (base + portal_sms.INCOMING_PATH)' in read(
          "omniflow-backend-patch/admin_providers.py"))
check("lib passes what (default voice)", 'what: "voice" | "sms" = "voice"' in ADMIN_LIB
      and "body: JSON.stringify({ sid, what })," in ADMIN_LIB)
check("BFF accepts only voice / sms and forwards it",
      'rawWhat !== "voice" && rawWhat !== "sms"' in CONNECT
      and 'connectAdminTwilioNumber(sid, rawWhat === "sms" ? "sms" : "voice")' in CONNECT)
labels = set(re.findall(r"^  ([a-z_]+): \{ label", SECTION[SECTION.index("const SMS_LABELS"):
                                                           SECTION.index("const SOURCE_LABELS")], re.M))
check("every CP SMS state has a label", labels == {"connected", "elsewhere", "not_set", "app"}, labels)
check("Connect SMS only for SMS-capable numbers not yet connected / app-held",
      'row.sms_capable && row.sms_state !== "connected" && row.sms_state !== "app"' in SECTION
      and '"Connect SMS"' in SECTION)
check("SMS connect confirmed first and says voice is untouched", "Call routing is not changed." in SECTION
      and SECTION.index("window.confirm(") < SECTION.index('"/api/omniflow/admin/voice/twilio/connect"')
      and "body: JSON.stringify({ sid: row.sid, what })," in SECTION)
check("voice Connect unchanged", 'onClick={() => void connect(row)}' in SECTION
      and 'row.state !== "connected" && !blocked' in SECTION)

for rel, text in (("SmsChannelCard.tsx", CARD), ("route.ts", ROUTE), ("TwilioNumbersSection.tsx", SECTION)):
    bad = [ch for ch in text if ord(ch) in (0x25B6, 0x261D, 0x2714, 0x26A1, 0x2699, 0x2709,
                                             0x260E, 0x2733, 0x263A, 0x25FC, 0x27A1)]
    check("no emoji-capable glyphs: " + rel, not bad, bad)

summary("sms_channel_ui")
