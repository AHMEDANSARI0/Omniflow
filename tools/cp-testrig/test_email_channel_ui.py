"""243 web pins: the Email channel card on Settings, the three BFF routes,
the portal.ts client, the inbox channel filter and the honest integrations
entry. Every field the web reads is checked against the CP module's real
payload builders so the two sides cannot drift."""
import os
import re
import sys

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "x")
sys.path.insert(0, os.getcwd())

from test_lib import check, summary  # noqa: E402
import portal_email_channel as E  # noqa: E402

ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


PORTAL = read("lib/omniflow/portal.ts")
WIRE = PORTAL[PORTAL.index("// §243 Email channel"):]
BASE = "app/api/omniflow/portal/channels/email/"
ROUTE = read(BASE + "route.ts")
TEST = read(BASE + "test/route.ts")
SYNC = read(BASE + "sync/route.ts")
CARD = read("app/dashboard/(portal)/settings/EmailChannelCard.tsx")
PAGE = read("app/dashboard/(portal)/settings/page.tsx")
INBOX = read("app/dashboard/(portal)/conversations/InboxClient.tsx")
INTEG = read("lib/marketing/integrations.ts")


def fields(name):
    body = re.search(r"export interface " + name + r" \{([^}]*)\}", WIRE).group(1)
    return set(re.findall(r"^\s*([a-z_A-Z]+)\??:", body, re.M))


print("== portal.ts ==")
check("one client per call, own names", all(WIRE.count("export function " + n + "(") == 1 for n in (
    "getEmailChannel", "saveEmailChannel", "testEmailChannel", "syncEmailChannel"))
      and PORTAL.count('const EMAIL_CHANNEL = "api/v1/portal/channels/email";') == 1)
state = E.public_settings({})
state.update({"available": True, "can_edit": True, "poll_seconds": 60})
check("state type == the CP payload (no drift)", fields("EmailChannelState") == set(state),
      fields("EmailChannelState") ^ set(state))
run_keys = {"ran", "sent", "failed", "refused", "imported", "skipped", "error"}
E.ENABLED = False
run_result = E.run(1)
E.ENABLED = True
check("run type covers the CP run result", fields("EmailChannelRun") == run_keys
      and run_keys <= set(run_result), set(run_result))
clean, _ = E.clean_settings({"address": "a@b.pk", "password": "p", "imap_host": "imap.b.pk",
                             "smtp_host": "smtp.b.pk"}, None)
check("input type == what the CP validates", fields("EmailChannelInput")
      == set(clean) - {"credentials_changed"} | {"enabled"})
check("test / sync get the long timeout (mail servers), reads the default",
      'EMAIL_CHANNEL + "/test", { method: "POST" }, EMAIL_CHANNEL_TIMEOUT_MS' in WIRE
      and 'EMAIL_CHANNEL + "/sync", { method: "POST" }, EMAIL_CHANNEL_TIMEOUT_MS' in WIRE
      and "EMAIL_CHANNEL_TIMEOUT_MS = 25_000" in WIRE and E.TIMEOUT_SECONDS * 2 + 5 < 25)

print("== BFF ==")
check("routes use the shared plumbing; writes are same-origin checked",
      all("withPortalToken(" in r and "serviceResponse(" in r for r in (ROUTE, TEST, SYNC))
      and "}, request);" in ROUTE and "), request);" in TEST and "), request);" in SYNC
      and "export async function GET()" in ROUTE and "export async function PUT(request: Request)" in ROUTE)
check("test + sync allow 30 s (two mail servers)", "export const maxDuration = 30;" in TEST
      and "export const maxDuration = 30;" in SYNC)
check("PUT validates types before the CP: text caps, password <= 500, ports 1-65535, boolean switch",
      "text(body.address, 254)" in ROUTE and "password.length > 500" in ROUTE
      and "num >= 1 && num <= 65535" in ROUTE and 'typeof body.enabled !== "boolean"' in ROUTE
      and "/^\\d{1,5}$/" in ROUTE)
check("PUT passes exactly the CP fields", all(("  " + f + ",") in ROUTE or ("  " + f + ":") in ROUTE
                                               for f in fields("EmailChannelInput")))
check("import depth matches the folder", ROUTE.count('"../../../../../../lib/omniflow/') == 4
      and TEST.count('"../../../../../../../lib/omniflow/') == 2
      and SYNC.count('"../../../../../../../lib/omniflow/') == 2)

print("== card ==")
check("settings page renders the card once, after Instagram",
      PAGE.count("<EmailChannelCard />") == 1 and PAGE.index("<InstagramCard />") < PAGE.index("<EmailChannelCard />")
      and 'import EmailChannelCard from "./EmailChannelCard";' in PAGE)
check("card reads only fields the CP sends", all(
    ("state." + key) not in CARD or key in state for key in re.findall(r"state\??\.([a-z_]+)", CARD))
      and set(re.findall(r"state\??\.([a-z_]+)", CARD)) <= set(state))
check("password write-only: never prefilled, blank keeps", 'password: "",' in CARD
      and "Saved - leave blank to keep" in CARD and 'type="password"' in CARD
      and 'autoComplete="new-password"' in CARD)
check("switch only after a passing test; editors only", "disabled={!canEdit || !state?.verified}" in CARD
      and "Run Test connection first" in CARD and "Only owners and admins can change the mailbox." in CARD)
check("Check now only when connected; Test only once saved", "disabled={busy !== \"\" || !connected}" in CARD
      and "disabled={busy !== \"\" || !state?.password_set}" in CARD)
check("honest copy: early access, read-only mailbox, only new email, skips robots, TLS only",
      "Early access" in CARD and "read-only" in CARD and "Only email that arrives after" in CARD
      and "auto-replies are skipped" in CARD and "Encrypted connections only" in CARD)
check("last error shown in the danger tone", 'className="text-danger"' in CARD and "state.last_error" in CARD)
check("card on the house style (tokens, no raw colours)",
      "rounded-xl2 border border-line bg-white p-5 shadow-card" in CARD and "bg-brand-soft" in CARD
      and not re.search(r"#[0-9a-fA-F]{3,6}\b", CARD))
check("same-origin fetches only (relative API)", 'const API = "/api/omniflow/portal/channels/email";' in CARD
      and "http" not in CARD.replace("https://", ""))

print("== inbox + integrations ==")
check("inbox filter: one list incl. telegram + email, used for buttons and the URL param",
      'const INBOX_CHANNELS = ["whatsapp", "instagram", "messenger", "telegram", "email", "sms", "website"] as const;' in INBOX
      and '(["all", ...INBOX_CHANNELS] as const)' in INBOX
      and 'INBOX_CHANNELS.find((value) => value === urlFilters.get("channel"))' in INBOX
      and 'useState<"all" | InboxChannel>("all")' in INBOX)
import portal_conversations as PC  # noqa: E402
check("web filter list == CP filter list", sorted(re.search(
    r"const INBOX_CHANNELS = \[([^\]]*)\]", INBOX).group(1).replace('"', "").replace(" ", "").split(","))
      == sorted(PC.INBOX_CHANNELS))
email_entry = INTEG[INTEG.index('id: "email"'):INTEG.index('id: "tiktok"')]
check("Email channel listed as early access (not live), TikTok still coming soon",
      'status: "beta"' in email_entry and 'category: "channels"' in email_entry
      and 'status: "soon"' in INTEG[INTEG.index('id: "tiktok"'):INTEG.index('id: "youtube"')])
check("Gmail entry no longer promises what the Email channel already does",
      "Gmail already works through the Email channel" in INTEG)

for rel, text in (("EmailChannelCard.tsx", CARD), ("route.ts", ROUTE)):
    bad = [ch for ch in text if ord(ch) in (0x25B6, 0x261D, 0x2714, 0x26A1, 0x2699, 0x2709,
                                             0x260E, 0x2733, 0x263A, 0x25FC, 0x27A1)]
    check("no emoji-capable glyphs: " + rel, not bad, bad)

summary("email_channel_ui")
