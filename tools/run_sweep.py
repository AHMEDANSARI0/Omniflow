"""Full rig sweep: refresh smoke971 snapshots + shared CP modules, run
every tools/cp-testrig/test_*.py suite. Lives IN the repo so sandbox
rebuilds cannot wipe it. Usage: python3 tools/run_sweep.py"""
import os, subprocess, sys, shutil, glob, re

ROOT = "/home/user/Omniflow"
RIG = ROOT + "/tools/cp-testrig"
CP = ROOT + "/omniflow-backend-patch"

for mod in ("portal_db.py", "portal_auth.py", "portal_conversations.py"):
    src = os.path.join(CP, mod)
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(RIG, mod))

SMOKE = "/tmp/smoke971"
os.makedirs(SMOKE, exist_ok=True)
for name in ("app.py", "connector_api.py", "portal_changes.py",
             "portal_checkout.py", "portal_cod.py", "portal_coupons.py",
             "portal_events.py", "portal_intents.py", "portal_kb.py",
             "portal_llm.py", "portal_payments.py", "portal_ratelimit.py"):
    src = os.path.join(CP, name)
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(SMOKE, name))
P = "app/api/omniflow/portal/"
D = "app/dashboard/(portal)/"
SMOKE_MAP = {
    "journey_card.tsx": D + "customers/profile/CustomerJourneyCard.tsx",
    "memory_card.tsx": D + "customers/profile/CustomerMemoryCard.tsx",
    "profile_client.tsx": D + "customers/profile/ProfileClient.tsx",
    "risk_card.tsx": D + "cod/RiskCard.tsx",
    "media_page.tsx": D + "media/page.tsx",
    "perf_card.tsx": D + "settings/PerfCard.tsx",
    "settings_page.tsx": D + "settings/page.tsx",
    "sidebar.tsx": "app/dashboard/components/DashSidebar.tsx",
    "recovery_card.tsx": "app/dashboard/components/RecoveryCard.tsx",
    "address_card.tsx": D + "cod/AddressCard.tsx",
    "negotiation_card.tsx": D + "settings/NegotiationCard.tsx",
    "copygen_card.tsx": D + "broadcasts/CopyGenCard.tsx",
    "overview_page.tsx": D + "page.tsx",
    "broadcasts_page.tsx": D + "broadcasts/page.tsx",
    "courier_page.tsx": D + "courier/page.tsx",
    "palette.tsx": "app/dashboard/components/CommandPalette.tsx",
    "cod_page.tsx": D + "cod/page.tsx",
    "bff_memory.ts": P + "memory/route.ts",
    "bff_id_memory_id.ts": P + "memory/[id]/route.ts",
    "bff_journey.ts": P + "journey/route.ts",
    "bff_journey_stages.ts": P + "journey/stages/route.ts",
    "bff_id_stage_id.ts": P + "journey/stages/[id]/route.ts",
    "bff_explain.ts": P + "explain/route.ts",
    "bff_media.ts": P + "media/route.ts",
    "bff_media_delete.ts": P + "media/delete/route.ts",
    "bff_media_send.ts": P + "media/send/route.ts",
    "bff_media_transcribe.ts": P + "media/transcribe/route.ts",
    "bff_media_download.ts": P + "media/[id]/download/route.ts",
    "bff_risk_score.ts": P + "risk/score/route.ts",
    "bff_risk_settings.ts": P + "risk/settings/route.ts",
    "bff_risk_tasks.ts": P + "risk/tasks/route.ts",
    "bff_address_normalize.ts": P + "address/normalize/route.ts",
    "bff_recovery.ts": P + "recovery/route.ts",
    "bff_recovery_followup.ts": P + "recovery/followup/route.ts",
    "bff_recovery_dismiss.ts": P + "recovery/dismiss/route.ts",
    "bff_recovery_settings.ts": P + "recovery/settings/route.ts",
    "bff_negotiation_bounds.ts": P + "negotiation/bounds/route.ts",
    "bff_negotiation_decide.ts": P + "negotiation/decide/route.ts",
    "bff_copygen_broadcast.ts": P + "copygen/broadcast/route.ts",
    "bff_courier_settings.ts": P + "courier/settings/route.ts",
    "bff_courier_test.ts": P + "courier/test/route.ts",
    "bff_courier_book.ts": P + "courier/book/route.ts",
    "bff_courier_bookings.ts": P + "courier/bookings/route.ts",
    "bff_courier_track.ts": P + "courier/track/route.ts",
    "bff_perf.ts": P + "perf/route.ts",
}
for name, rel in SMOKE_MAP.items():
    src = os.path.join(ROOT, rel)
    if os.path.exists(src):
        shutil.copy2(src, os.path.join(SMOKE, name))

suites = sorted(glob.glob(RIG + "/test_*.py"))
env = dict(os.environ)
env["OMNIFLOW_SERVICE_KEY"] = "x"
env["OMNIFLOW_ADMIN_API_KEY"] = "x"
env["PYTHONPATH"] = CP + ":" + RIG

total_pass = 0
total_fail = 0
fail_suites = []
crashes = []
for suite in suites:
    proc = subprocess.run(
        [sys.executable, "-B", suite],
        cwd=CP, env=env, capture_output=True, text=True, timeout=600)
    out = proc.stdout + proc.stderr
    summary = None
    for line in out.splitlines():
        if line.startswith("SUMMARY["):
            summary = line
    if summary:
        m = re.search(r"(\d+) PASS, (\d+) FAIL", summary)
        p, f = int(m.group(1)), int(m.group(2))
        total_pass += p
        total_fail += f
        if f or proc.returncode != 0:
            fail_suites.append((os.path.basename(suite), p, f, proc.returncode, out))
    elif proc.returncode == 0:
        pass  # helper library (e.g. test_lib.py = shared stubs)
    else:
        crashes.append((os.path.basename(suite), proc.returncode, out[-400:]))
        total_fail += 1

for name, p, f, rc, out in fail_suites:
    print("FAIL  %s %d PASS %d FAIL rc= %d" % (name, p, f, rc))
    for line in out.splitlines():
        if line.strip().startswith("- ") and "::" in line:
            print("       " + line.strip())
for name, rc, tail in crashes:
    print("CRASH %s rc= %d" % (name, rc))
    print(tail)
print("")
print("SWEEP TOTAL: %d suites, %d PASS, %d FAIL" % (len(suites), total_pass, total_fail))
sys.exit(1 if (total_fail or crashes) else 0)
