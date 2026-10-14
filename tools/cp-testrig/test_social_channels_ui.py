"""255 web pins: the Social channels card on Settings, the five BFF routes,
the portal.ts client, the inbox filter + comment marker, the honest
integrations entries and the laptop bridge README. Every list the web keeps
(channels, actions, switches, prefixes) is compared with the CP module so the
two sides cannot drift; the runtime payload keys are compared in
test_social_channels.py (pgserver)."""
import os
import re
import sys

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "x")
sys.path.insert(0, os.getcwd())

from test_lib import check, summary  # noqa: E402
import portal_social as S  # noqa: E402
import portal_conversations  # noqa: E402

ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))
CP = open(os.path.join(os.getcwd(), "portal_social.py"), encoding="utf-8").read()


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


PORTAL = read("lib/omniflow/portal.ts")
WIRE = PORTAL[PORTAL.index("// §255 social channels"):]
BFF = read("lib/omniflow/social-bff.ts")
BASE = "app/api/omniflow/portal/channels/social/"
LIST = read(BASE + "route.ts")
PUT = read(BASE + "[channel]/route.ts")
ACTION = read(BASE + "[channel]/[action]/route.ts")
CALLBACK = read(BASE + "callback/route.ts")
POSTS = read(BASE + "posts/route.ts")
CARD = read("app/dashboard/(portal)/settings/SocialChannelsCard.tsx")
PAGE = read("app/dashboard/(portal)/settings/page.tsx")
INBOX = read("app/dashboard/(portal)/conversations/InboxClient.tsx")
INTEG = read("lib/marketing/integrations.ts")
TYPES = read("lib/marketing/types.ts")
README = read("connector-node/README.md")


def fields(name, text=WIRE):
    body = re.search(r"export interface " + name + r" \{(.*?)\n\}", text, re.S).group(1)
    return set(re.findall(r"^  ([a-z_A-Z]+)\??:", body, re.M))


def ts_list(text, name):
    block = re.search(r"const " + name + r" = \[(.*?)\]", text, re.S).group(1)
    return re.findall(r'"([a-z_]+)"', block)


print("== portal.ts ==")
check("one client per call", all(WIRE.count("export function " + n + "(") == 1 for n in (
    "getSocialChannels", "saveSocialChannel", "startSocialOAuth", "finishSocialOAuth", "runSocialAction",
    "createSocialPost")) and PORTAL.count('const SOCIAL_CHANNELS = "api/v1/portal/channels/social";') == 1)
check("channel ids == CP channels (same order)", ts_list(WIRE, "SOCIAL_CHANNEL_IDS") == list(S.CHANNELS))
check("actions == the CP action route", ts_list(WIRE, "SOCIAL_ACTIONS") == ["test", "webhook", "sync", "disconnect"]
      and 'action not in ("test", "webhook", "sync", "disconnect")' in CP)
check("feature type == CP FEATURES", set(re.findall(r'"([a-z]+)"', re.search(
    r"export type SocialFeature = ([^;]+);", WIRE).group(1))) == set(S.FEATURES))
check("post status type == every status the CP writes",
      set(re.findall(r'"([a-z_]+)"', re.search(r'status: ("pending_approval"[^;]+);', WIRE).group(1)))
      == {"pending_approval", "queued", "published", "failed", "rejected"}
      and all("'" + s + "'" in CP or '"' + s + '"' in CP for s in ("pending_approval", "queued", "published",
                                                                    "failed", "rejected")))
check("input type == what the CP PUT reads", fields("SocialChannelInput") == {
    "mode", "enabled", "app_id", "app_secret", "consumer_secret", "bearer_token", "organization_id", "flags"}
      and 'payload.get("mode", account["mode"])' in CP
      and all('"' + k + '" in payload' in CP for k in ("app_id", "organization_id", "enabled", "flags"))
      and '_SECRET_KEYS = ("app_secret", "consumer_secret", "bearer_token")' in CP)
check("platform calls get a timeout above the CP's waits", "SOCIAL_TIMEOUT_MS = 45_000" in WIRE
      and WIRE.count("SOCIAL_TIMEOUT_MS);") == 3)

print("== BFF ==")
check("read route: GET only, shared plumbing", "export async function GET()" in LIST
      and "withPortalToken(" in LIST and "serviceResponse(await getSocialChannels(accessToken))" in LIST)
check("writes are same-origin checked", all("}, request);" in r for r in (PUT, ACTION, POSTS)))
check("OAuth callback: no same-origin check (cross-site by design), one-time state is the guard",
      "}, request);" not in CALLBACK and "withPortalToken(async (accessToken)" in CALLBACK
      and "one-time state" in CALLBACK)
check("callback path == the CP redirect rule", 'SOCIAL_CALLBACK_PATH = "/api/omniflow/portal/channels/social/callback"'
      in BFF and '"/channels/social/callback"' in CP)
check("callback returns to the card with a result only (303, no token / code in the URL)",
      '"/dashboard/settings?social="' in CALLBACK and '"#social"' in CALLBACK and "303" in CALLBACK
      and 'searchParams.get("auth_code")' in CALLBACK and "code=" not in CALLBACK.split("Response.redirect", 1)[1])
check("PUT: channel checked, flags == CP switches, text bounded", "isSocialChannel(channel)" in PUT
      and ts_list(PUT, "FLAG_KEYS") == list(S.FEATURES) + ["comment_auto_reply"]
      and ts_list(PUT, "TEXT_FIELDS") == ["app_id", "app_secret", "consumer_secret", "bearer_token", "organization_id"]
      and "value.length > 500" in PUT and 'bad("Nothing to save.")' in PUT
      and 'body.mode !== "api" && body.mode !== "login"' in PUT and 'typeof body.enabled !== "boolean"' in PUT)
check("action route: known actions + connect (OAuth start with our callback)",
      'action !== "connect"' in ACTION and "SOCIAL_ACTIONS.find(" in ACTION
      and "publicOrigin(request) + SOCIAL_CALLBACK_PATH" in ACTION)
check("posts route: channel + size checked before the CP", "isSocialChannel(channel)" in POSTS
      and "text.length > 3000" in POSTS and "mediaUrl.length > 1500" in POSTS)
check("slow routes allow 60 s", all("export const maxDuration = 60;" in r for r in (ACTION, CALLBACK, POSTS)))
for name, text, depth in (("list", LIST, 6), ("put", PUT, 7), ("action", ACTION, 8), ("callback", CALLBACK, 7),
                          ("posts", POSTS, 7)):
    imports = re.findall(r'from "((?:\.\./)+)lib/omniflow/', text)
    check("import depth matches the folder: " + name, imports and all(i == "../" * depth for i in imports), imports)
check("dynamic params awaited (Next 16)", "params: Promise<{ channel: string }>" in PUT
      and "params: Promise<{ channel: string; action: string }>" in ACTION and "await context.params" in PUT)

print("== card ==")
check("settings page renders the card once, after SMS", PAGE.count("<SocialChannelsCard />") == 1
      and PAGE.index("<SmsChannelCard />") < PAGE.index("<SocialChannelsCard />")
      and 'import SocialChannelsCard from "./SocialChannelsCard";' in PAGE)
account_fields = fields("SocialChannelAccount")
used = set(re.findall(r"\baccount\??\.([a-z_]+)", CARD)) | set(re.findall(r"\bitem\.([a-z_]+)", CARD))
check("card reads only account fields the CP sends", used <= account_fields, used - account_fields)
post_used = set(re.findall(r"\bpost\.([a-z_]+)", CARD))
check("post list reads only post fields", post_used <= fields("SocialPost"), post_used - fields("SocialPost"))
state_used = set(re.findall(r"\bstate\??\.([a-z_]+)", CARD))
check("card reads only state fields", state_used <= fields("SocialChannelsState"), state_used)
check("same-origin fetches; OAuth only to an https authorize URL",
      'const API = "/api/omniflow/portal/channels/social";' in CARD
      and 'payload.url.startsWith("https://")' in CARD and "dangerouslySetInnerHTML" not in CARD)
check("both modes offered where the platform has them", '"API connection"' in CARD and '"Account login"' in CARD
      and "account.modes.map(" in CARD and "account.modes.length < 2" in CARD)
check("honest copy: platform limits listed, login is unofficial, keys encrypted, password stays on the laptop",
      "account.limits.map(" in CARD and "unofficial, so the platform may limit the account" in CARD
      and "keys are stored encrypted" in CARD and "its password never reaches OmniFlow" in CARD)
check("switch cannot turn API mode on before connecting",
      '(!account.enabled && mode === "api" && !account.connected)' in CARD)
check("AI comment replies: separate switch, needs comments on, says public",
      "disabled={!canEdit || busy !== \"\" || !account.flags.comments}" in CARD and "posted publicly" in CARD)
check("posting: only channels that can publish; approval copy for teammates and AI",
      "item.capabilities[item.mode].includes(\"publish\")" in CARD and "AI-drafted posts always need an" in CARD
      and '"Send for approval"' in CARD)
check("X reads are billed - said on the button", "each read is billed by X" in CARD)
check("secrets write-only (password inputs with masked placeholders)",
      CARD.count('type="password"') == 3 and "account.app_secret_masked ||" in CARD)
check("card on the house style (tokens, no raw colours, no emoji)",
      "rounded-xl2 border border-line bg-white p-5 shadow-card" in CARD and 'id="social"' in CARD
      and not re.search(r"#[0-9a-fA-F]{3,6}\b", CARD) and not re.search(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]", CARD))
check("no setState inside effects (draft reset during render, load in a callback)",
      "if (account && draftKey !== shownKey)" in CARD and "void fetchState().then(" in CARD
      and "eslint-disable" not in CARD)

print("== inbox ==")
check("filter list == CP inbox channels", set(ts_list(INBOX, "INBOX_CHANNELS")) == set(
    portal_conversations.INBOX_CHANNELS), set(ts_list(INBOX, "INBOX_CHANNELS")) ^ set(portal_conversations.INBOX_CHANNELS))
labels = dict(re.findall(r"^  ([a-z_]+): \"([^\"]+)\",", INBOX[INBOX.index("const CHANNEL_LABELS"):
                                                          INBOX.index("type InboxChannel")], re.M))
check("brand spellings == CP labels", all(labels.get(c) == S.SPECS[c]["label"] for c in S.CHANNELS if c != "x"),
      labels)
marker = re.search(r"/\^\(([a-z|]+)\):/\.test\(item\.contactId", INBOX).group(1).split("|")
check("comment marker == every comment prefix (Meta + social)", set(marker) == {"igc", "fbc"} | {
    S.SPECS[c]["comment"].rstrip(":") for c in S.CHANNELS if S.SPECS[c]["comment"]}, marker)

print("== integrations ==")
for channel in ("tiktok", "youtube", "linkedin", "x"):
    start = INTEG.index('id: "' + channel + '"')
    entry = INTEG[start:INTEG.index("\n  },", start)]
    check(channel + ": early access channel with honest points",
          'status: "beta"' in entry and "points: [" in entry and 'category: "channels"' in entry
          and 'AvailabilityStatus = "live" | "beta" | "soon"' in TYPES, entry[:120])
start = INTEG.index('id: "telegram"')
check("Telegram bot stays live", 'status: "live"' in INTEG[start:INTEG.index("\n  },", start)])
check("TikTok limits stated", "EEA" in INTEG and "Business" in INTEG[INTEG.index('id: "tiktok"'):])
check("YouTube: comments only, no DMs", "comments" in INTEG[INTEG.index('id: "youtube"'):].split("\n  },")[0].lower())

print("== laptop README ==")
section = README[README.index("## Social login bridge"):]
check("README: install per channel, env, unofficial warning, endpoints",
      all(t in section for t in ("twikit", "linkedin-api", "telethon", "SOCIAL_LOGIN_CHANNELS", "UNOFFICIAL",
                                 "TELEGRAM_API_ID", "X_USERNAME", "LINKEDIN_EMAIL", "/api/v1/connector/social/status",
                                 "away-replies?social=", "TikTok and YouTube have no login mode")))

sys.exit(1 if summary("social_channels_ui") else 0)
