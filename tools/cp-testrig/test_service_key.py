"""245: one service-key check for every machine-facing CP route (strip +
constant-time), the website naming a rejected key instead of a generic
"Could not load", the Next.js security bump, and the history-purge helper
(end-to-end on throwaway repos when git-filter-repo is installed)."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

os.environ.setdefault("OMNIFLOW_SERVICE_KEY", "x")
os.environ.setdefault("OMNIFLOW_ADMIN_API_KEY", "x")
sys.path.insert(0, os.getcwd())

from flask import Flask  # noqa: E402

from test_lib import check, summary  # noqa: E402
import portal_auth  # noqa: E402

ROOT = os.environ.get("OF_RIG_WEB_ROOT") or os.path.abspath(os.path.join(os.getcwd(), ".."))
CP_DIR = os.getcwd()
MODULES = ["admin_ai", "admin_providers", "admin_users", "connector_api", "portal_cloud",
           "portal_media", "portal_model_router"]


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


def cp_src(name):
    with open(os.path.join(CP_DIR, name + ".py"), encoding="utf-8") as fh:
        return fh.read()


app = Flask("t245")


def with_env(service, admin, header, fn=portal_auth.service_key_ok):
    saved = {k: os.environ.get(k) for k in portal_auth.SERVICE_KEY_ENVS}
    try:
        for k, v in zip(portal_auth.SERVICE_KEY_ENVS, (service, admin)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        headers = {} if header is None else {"X-Omniflow-Key": header}
        with app.test_request_context("/", headers=headers):
            return fn()
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


# ---- CP helper behaviour ----
check("exact key accepted", with_env("s3cret-key", None, "s3cret-key") is True)
check("env trailing newline still accepted", with_env("s3cret-key\n", None, "s3cret-key") is True)
check("env trailing space + CRLF accepted", with_env("  s3cret-key \r\n", None, "s3cret-key") is True)
check("header whitespace accepted", with_env("s3cret-key", None, " s3cret-key\t") is True)
check("admin api key accepted", with_env(None, "adm1n", "adm1n") is True)
check("wrong key rejected", with_env("s3cret-key", "adm1n", "s3cret-kez") is False)
check("prefix of key rejected", with_env("s3cret-key", None, "s3cret") is False)
check("missing header rejected", with_env("s3cret-key", None, None) is False)
check("blank header rejected", with_env("s3cret-key", None, "   ") is False)
check("no env configured rejects everything", with_env(None, None, "anything") is False)
check("whitespace-only env never matches blank", with_env("   ", "\n", " ") is False)
check("non-ASCII header rejected without error", with_env("s3cret-key", None, "s3cr\u00e9t") is False)
check("non-ASCII key works both sides", with_env("k\u00e9y", None, "k\u00e9y") is True)
check("explicit argument path", with_env("abc", None, None, lambda: portal_auth.service_key_ok(" abc ")) is True)
AUTH = open(os.path.join(CP_DIR, "portal_auth.py"), encoding="utf-8").read()
helper = AUTH[AUTH.index("def service_key_ok"):AUTH.index("def bind_root_application")]
check("helper is constant-time (hmac.compare_digest on bytes)", "hmac.compare_digest(key, accepted)" in helper
      and '.encode("utf8")' in helper)
check("helper strips both sides", helper.count(".strip()") == 2)

# ---- every machine-facing module uses the one helper ----
for name in MODULES:
    src = cp_src(name)
    body = src[src.index("def _authorized() -> bool:"):]
    body = body[:body.index("\n\n")]
    check(name + ": _authorized delegates to portal_auth.service_key_ok",
          body.rstrip().endswith("return portal_auth.service_key_ok()"), body)
    check(name + ": no private key compare left", "compare_digest(key" not in src and "bool(key) and key in" not in src
          and 'request.headers.get("X-Omniflow-Key"' not in src)
    check(name + ": imports portal_auth", re.search(r"^import portal_auth$", src, re.M) is not None)
    mod = __import__(name)
    check(name + ": live - padded env key accepted",
          with_env("live-key\n", None, "live-key", mod._authorized) is True)
    check(name + ": live - wrong key rejected",
          with_env("live-key\n", None, "live-kex", mod._authorized) is False)

# ---- website: rejected key gets a name and a clear message ----
LIB = read("lib/omniflow/admin-control-plane.ts")
BRIDGE = read("lib/omniflow/admin-bridge-error.ts")
check("failureCode maps 401/403 to service_key_rejected",
      'status === 401 || status === 403 ? "service_key_rejected" : "admin_request_failed"' in LIB)
check("adminRequest uses failureCode", "new ControlPlaneRequestError(response.status, failureCode(response.status))" in LIB)
voice = LIB[LIB.index("async function adminVoiceFetch"):LIB.index("export async function listAdminVoiceNumbers")]
check("voice/twilio fetch also throws on 401/403",
      "response.status === 401 || response.status === 403" in voice and "failureCode(" in voice)
check("bridge helper maps the key rejection", 'if (error.code === "service_key_rejected") {' in BRIDGE
      and "SERVICE_KEY_REJECTED_MESSAGE" in BRIDGE and "OMNIFLOW_ADMIN_API_KEY" in BRIDGE)
for code in ("service_not_configured", "control_plane_not_configured", "control_plane_url_invalid",
             "control_plane_tls_required"):
    check("bridge helper maps " + code, '"%s"' % code in BRIDGE)
check("bridge helper falls through with null", "return null;" in BRIDGE)

ROUTES = []
for base, _dirs, files in os.walk(os.path.join(ROOT, "app/api/omniflow/admin")):
    ROUTES += [os.path.join(base, f) for f in files if f == "route.ts"]
check("all admin routes found", len(ROUTES) >= 17, str(len(ROUTES)))
sites = 0
for path in sorted(ROUTES):
    src = open(path, encoding="utf-8").read()
    rel = os.path.relpath(path, ROOT)
    catches = re.findall(r"(?<![.\w])catch\s*(?:\((\w+)\))?\s*\{\s*\n\s*(.*)", src)
    sites += len(catches)
    check(rel + ": imports adminBridgeError", "lib/omniflow/admin-bridge-error" in src)
    check(rel + ": every catch starts with adminBridgeError",
          catches and all(v and line.strip() == "const bridge = adminBridgeError(%s);" % v for v, line in catches),
          repr(catches))
    check(rel + ": no duplicated config/403 mapping left",
          'code === "service_not_configured"' not in src and "status === 403" not in src
          and "Service key rejected by the Control Plane." not in src)
check("19 catch sites covered", sites == 19, str(sites))

INTEG = read("app/admin/(panel)/integrations/IntegrationsClient.tsx")
check("integrations: load error state", 'const [loadError, setLoadError] = useState("");' in INTEG)
check("integrations: shows the server message", "payload?.error?.message ||" in INTEG
      and "setLoadError(" in INTEG)
check("integrations: alert banner with retry", 'role="alert"' in INTEG and "onClick={() => void load()}" in INTEG
      and "Retry" in INTEG)
check("integrations: no silent catch", "// keep whatever is on screen" not in INTEG)

# ---- Next.js security bump (GHSA-2xp9-vwfh-vxw4 / GHSA-p293-qw3h-jr36: RCE < 16.3.3) ----
PKG = json.loads(read("package.json"))


def ver(v):
    return tuple(int(x) for x in re.sub(r"^[^\d]*", "", v).split(".")[:3])


check("next >= 16.3.3", ver(PKG["dependencies"]["next"]) >= (16, 3, 3), PKG["dependencies"]["next"])
eslint_next = PKG.get("devDependencies", {}).get("eslint-config-next") or PKG["dependencies"].get("eslint-config-next")
check("eslint-config-next matches next", eslint_next == PKG["dependencies"]["next"], str(eslint_next))
LOCK = json.loads(read("package-lock.json"))
check("lock resolves next to the bumped version",
      LOCK["packages"]["node_modules/next"]["version"] == PKG["dependencies"]["next"])
check("lock: source-map-js >= 1.2.2", ver(LOCK["packages"]["node_modules/source-map-js"]["version"]) >= (1, 2, 2))
check("lock root mirrors package.json", LOCK["packages"][""]["dependencies"]["next"] == PKG["dependencies"]["next"])

# ---- history purge helper ----
# The helper runs from the bot root / PATCHERS_TO_RUN and is not kept in git after the 222 cleanup:
# check it wherever this checkout has it, skip otherwise (like test_design_system).
PURGE_PATH = next((p for p in (os.path.join(ROOT, d, "history_purge_245.mjs")
                               for d in ("tools/patchers", "PATCHERS_TO_RUN", ""))
                   if os.path.isfile(p)), None)
if PURGE_PATH is None:
    print("  skip: history_purge_245.mjs not in this checkout")
else:
    PURGE = open(PURGE_PATH, encoding="utf-8").read()
    check("purge: ASCII only", all(ord(c) < 128 for c in PURGE))
    check("purge: never pushes", re.search(r"spawnSync\([^)]*\[\s*\"push\"", PURGE) is None
          and 'git(["push"' not in PURGE)
    check("purge: dry run by default", 'process.argv.includes("--apply") ? "apply"' in PURGE and ': "dry"' in PURGE)
    for needle, why in (('"--is-shallow-repository"', "refuses shallow clones"),
                        ('"--untracked-files=no"', "refuses uncommitted tracked changes"),
                        ('git(["ls-files", "--", ...PATHSPECS])', "requires 222 first"),
                        ('"rm", "-r", "-q", "--cached", "--ignore-unmatch"', "laptop untracks before the switch"),
                        ("would be replaced by the cleaned main", "laptop never overwrites untracked files"),
                        ('"bundle", "create"', "backup bundle before rewrite"),
                        ('":(exclude,glob)**/.env.example"', "keeps .env.example"),
                        ('"--path-regex"', "env files via regex"),
                        ('"rev-list", "--count", "HEAD", "--not"', "laptop refuses unpushed commits"),
                        ('const PRE = "refs/purge245/pre-origin";', "laptop rerun compares with the old remote"),
                        ("Already on the cleaned history", "laptop mode is idempotent")):
        check("purge: " + why, needle in PURGE)
    node = shutil.which("node")
    if node:
        check("purge: node --check", subprocess.run([node, "--check", PURGE_PATH]).returncode == 0)


    def have_filter_repo():
        for cmd in (["git", "filter-repo", "--version"], [sys.executable, "-m", "git_filter_repo", "--version"]):
            try:
                if subprocess.run(cmd, capture_output=True).returncode == 0:
                    return True
            except OSError:
                pass
        return False


    def sh(cwd, *args, ok=True):
        r = subprocess.run(list(args), cwd=cwd, capture_output=True, text=True, env=GIT_ENV)
        if ok and r.returncode != 0:
            raise RuntimeError("%s failed: %s" % (args, r.stderr))
        return r


    GIT_ENV = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
                   GIT_COMMITTER_EMAIL="t@t", PATH=os.path.dirname(sys.executable) + os.pathsep + os.environ.get("PATH", ""))
    if node and shutil.which("git") and have_filter_repo():
        tmp = tempfile.mkdtemp(prefix="purge245-")
        try:
            seed = os.path.join(tmp, "seed")
            os.makedirs(os.path.join(seed, "omniflow-backend-patch"))
            sh(tmp, "git", "init", "-q", "-b", "main", seed)

            def put(rel, text):
                full = os.path.join(seed, rel)
                os.makedirs(os.path.dirname(full) or seed, exist_ok=True)
                open(full, "w").write(text)
            put("package.json", "{}")
            put("omniflow-backend-patch/x.py", "x = 1\n")
            put(".env.example", "K=\n")
            sh(seed, "git", "add", "-A")
            sh(seed, "git", "commit", "-qm", "c1")
            private = {"whatsapp_session/Default/Cookies": "c", "backups/a.dump": "d", "data/conversations.json": "{}",
                       ".connector_node.env": "CONNECTOR_NODE_CREDENTIAL=s", ".env.local": "S=1",
                       "sub/.env.production": "P=1", "venv/lib/x.py": "v"}
            for rel, text in private.items():
                put(rel, text)
            sh(seed, "git", "add", "-A")
            sh(seed, "git", "commit", "-qm", "leak")
            sh(seed, "git", "rm", "-r", "-q", "--cached", "whatsapp_session", "backups", "data", "venv",
               ".connector_node.env", ".env.local", "sub/.env.production")
            put(".gitignore", "whatsapp_session/\nbackups/\ndata/\nvenv/\n.connector_node.env\n.env*\n!.env.example\n")
            sh(seed, "git", "add", ".gitignore")
            sh(seed, "git", "commit", "-qm", "222 cleanup")
            origin = os.path.join(tmp, "origin.git")
            sh(tmp, "git", "clone", "-q", "--bare", seed, origin)
            office = os.path.join(tmp, "office")
            laptop = os.path.join(tmp, "laptop")
            sh(tmp, "git", "clone", "-q", origin, office)
            laptop2 = os.path.join(tmp, "laptop2")  # 222 never synced here: private files still tracked
            sh(tmp, "git", "clone", "-q", origin, laptop)
            sh(tmp, "git", "clone", "-q", origin, laptop2)
            sh(laptop2, "git", "reset", "-q", "--hard", "HEAD~1")
            for rel, text in private.items():
                for repo in (office, laptop):
                    full = os.path.join(repo, rel)
                    os.makedirs(os.path.dirname(full) or repo, exist_ok=True)
                    open(full, "w").write(text)

            def purge(cwd, *flags):
                return sh(cwd, node, PURGE_PATH, *flags, ok=False)

            def history(cwd, ref="--all"):
                return sh(cwd, "git", "log", ref, "--format=", "--name-only").stdout.split()

            dry = purge(office)
            check("e2e: dry run ok", dry.returncode == 0 and "DRY RUN - nothing was written" in dry.stdout, dry.stdout)
            check("e2e: dry run lists the private dirs", "whatsapp_session/" in dry.stdout and "backups/" in dry.stdout)
            check("e2e: dry run changes nothing", "whatsapp_session/Default/Cookies" in history(office))
            early = purge(laptop, "--other-machine")
            check("e2e: laptop refuses before the force push", early.returncode == 1
                  and "not force-pushed yet" in early.stdout, early.stdout)
            open(os.path.join(office, "package.json"), "w").write('{"dirty": 1}')
            dirty = purge(office, "--apply")
            check("e2e: apply refuses uncommitted changes", dirty.returncode == 1 and "Nothing was changed" in dirty.stdout)
            sh(office, "git", "checkout", "-q", "package.json")
            applied = purge(office, "--apply")
            check("e2e: apply ok", applied.returncode == 0 and "History cleaned and verified" in applied.stdout,
                  applied.stdout + applied.stderr)
            names = history(office)
            check("e2e: private paths gone from every commit",
                  not [n for n in names if n.split("/")[0] in ("whatsapp_session", "backups", "data", "venv")
                       or n.endswith((".connector_node.env", ".env.local", ".env.production"))], str(names))
            check("e2e: code and .env.example kept", "omniflow-backend-patch/x.py" in names and ".env.example" in names)
            check("e2e: origin remote restored", sh(office, "git", "remote", "get-url", "origin").stdout.strip() == origin)
            check("e2e: backup bundle written outside the repo",
                  any(f.startswith("Omniflow-before-purge-") and f.endswith(".bundle") for f in os.listdir(tmp)))
            check("e2e: office files on disk untouched",
                  all(os.path.exists(os.path.join(office, rel)) for rel in private))
            check("e2e: prints the force push, never runs it", "git push --force origin main" in applied.stdout
                  and "whatsapp_session/Default/Cookies" in history(origin))
            shutil.rmtree(origin)
            sh(tmp, "git", "clone", "-q", "--bare", office, origin)  # what the user's force push does
            open(os.path.join(laptop, "new.txt"), "w").write("x")
            sh(laptop, "git", "add", "new.txt")
            sh(laptop, "git", "commit", "-qm", "unpushed")
            unpushed = purge(laptop, "--other-machine")
            check("e2e: laptop refuses unpushed commits", unpushed.returncode == 1 and "never pushed" in unpushed.stdout)
            sh(laptop, "git", "reset", "-q", "--hard", "HEAD~1")
            synced = purge(laptop, "--other-machine")
            check("e2e: laptop switches to the cleaned history", synced.returncode == 0
                  and "now uses the cleaned history" in synced.stdout, synced.stdout + synced.stderr)
            check("e2e: laptop main history clean", "whatsapp_session/Default/Cookies" not in history(laptop, "main"))
            check("e2e: laptop keeps a local backup branch", "pre-purge-backup-" in sh(laptop, "git", "branch").stdout)
            check("e2e: laptop files on disk untouched", all(os.path.exists(os.path.join(laptop, rel)) for rel in private))
            again = purge(laptop, "--other-machine")
            check("e2e: laptop second run is a no-op", again.returncode == 0 and "Already on the cleaned history" in again.stdout)
            open(os.path.join(laptop2, ".gitignore"), "w").write("mine\n")
            clash = purge(laptop2, "--other-machine")
            check("e2e: laptop refuses to overwrite a differing untracked file", clash.returncode == 1
                  and "would be replaced" in clash.stdout and ".gitignore" in clash.stdout, clash.stdout)
            os.remove(os.path.join(laptop2, ".gitignore"))
            unsynced = purge(laptop2, "--other-machine")
            check("e2e: laptop without 222 switches too", unsynced.returncode == 0
                  and "kept on disk (untracked first)" in unsynced.stdout, unsynced.stdout + unsynced.stderr)
            check("e2e: laptop without 222 keeps every private file on disk",
                  all(os.path.exists(os.path.join(laptop2, rel)) for rel in private))
            check("e2e: laptop without 222 now on the cleaned main",
                  sh(laptop2, "git", "rev-parse", "HEAD").stdout == sh(laptop2, "git", "rev-parse", "origin/main").stdout
                  and "whatsapp_session/Default/Cookies" not in history(laptop2, "main")
                  and not sh(laptop2, "git", "status", "--porcelain", "--untracked-files=no").stdout.strip())
            clean = purge(office)
            check("e2e: office dry run after purge says clean", "History is already clean" in clean.stdout)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    else:
        print("  skip: purge end-to-end (needs node, git and git-filter-repo)")

summary("service key + security 245")
