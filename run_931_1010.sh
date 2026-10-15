#!/usr/bin/env bash
# OmniFlow laptop batch runner — 931 heal -> 951 WATI -> 971-990 -> 991-1010
# Copy this file + the four add_batch_*.mjs patchers to the BOT ROOT on the
# laptop, then:  bash run_931_1010.sh
# Safe to re-run: every patcher is idempotent ("already done" skips).
set -u

BATCHES=(
  "add_batch_931_950_heal.mjs|10|931-950 heal + analytics depth"
  "add_batch_951_970_wati.mjs|10|951-970 WATI provider templates"
  "add_batch_971_990_combined.mjs|27|971-990 catalog+changes+coupons+segments+language+PWA"
  "add_batch_991_1010_cloud_lang.mjs|14|991-1010 cloud templates+multilingual KB+insights"
)

FAILED=0
echo "== OmniFlow batch runner =="
for row in "${BATCHES[@]}"; do
  FILE="${row%%|*}"; REST="${row#*|}"; EXPECT="${REST%%|*}"; NAME="${REST#*|}"
  if [ ! -f "$FILE" ]; then
    echo "MISSING FILE: $FILE (copy it to this folder) — STOP"
    FAILED=1; break
  fi
  echo ""
  echo "-- $NAME ($FILE, expect ~$EXPECT applied) --"
  OUT="$(node "$FILE" 2>&1)"
  echo "$OUT" | tail -20
  SUMMARY="$(echo "$OUT" | grep 'SUMMARY:' | tail -1)"
  WARN="$(echo "$SUMMARY" | grep -o '[0-9]* warnings' | grep -o '[0-9]*')"
  APPLIED="$(echo "$SUMMARY" | grep -o '[0-9]* applied' | head -1 | grep -o '[0-9]*')"
  if echo "$OUT" | grep -qE "FAIL|NOT FOUND|not found — report"; then
    echo "!! $FILE reported FAIL/NOT FOUND — STOP, send me the full output."
    FAILED=1; break
  fi
  if [ "${WARN:-0}" != "0" ]; then
    echo "!! $FILE finished with $WARN warnings — STOP, send me the full output."
    FAILED=1; break
  fi
  if [ -n "$APPLIED" ] && [ "$APPLIED" != "$EXPECT" ] && echo "$SUMMARY" | grep -q "0 already done"; then
    echo "?? $FILE applied $APPLIED (expected $EXPECT) with nothing already done — note it, but continuing."
  fi
  echo "OK: $SUMMARY"
done

echo ""
if [ "$FAILED" = "0" ]; then
  cat <<'NEXT'
== ALL PATCHERS DONE ==
1) RESTART services (one final restart covers all four batches):
     - restart the CP (control-plane) service once
     - restart the bot/bridge once
2) Git commits (two repos):
   CP repo:
     git add portal_cloud.py portal_kb.py portal_analytics.py portal_catalog.py portal_changes.py portal_coupons.py portal_growth.py portal_segments.py portal_contacts.py portal_conversations.py portal_checkout.py connector_api.py app.py
     git commit -m "feat: heal, wati templates, catalog+coupons+self-serve, cloud templates, multilingual kb, insights"
     git push
   Bridge (if it is its own repo):
     git add src/control_plane_bridge.py connector-bridge/control_plane_bridge.py
     git commit -m "feat: bridge wati/cloud template sends + template sync"
     git push
   Website repo:
     git add lib/omniflow/portal.ts app/api/omniflow app/dashboard app/manifest.ts app/layout.tsx app/c
     git commit -m "feat: wati+cloud template cards, catalog/coupons/self-serve, kb languages, insights, pwa"
     git push
3) Verify with tools/USER_CHECKLIST.md sections:
   "After the laptop heal (931-950)", "WATI templates (951-970)",
   "Saved catalog + coupons + self-serve (971-990)",
   "Cloud API templates + KB languages + insights (991-1010)".
NEXT
else
  echo "RUNNER STOPPED on an error — do NOT commit/restart yet. Share the output above."
fi