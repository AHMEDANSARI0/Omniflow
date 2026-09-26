#!/bin/sh
# Repopulates the /tmp/smoke971 era-snapshot the rig pins read from.
# The pins assert "the deployed file contains X" - the deployed era is
# the current workspace tree, so every snapshot copy is simply the
# current source file. Run from the website repo root after a sandbox
# wipe:   sh tools/cp-testrig/smoke971.sh
set -e
cd "$(dirname "$0")/../.."
S=/tmp/smoke971
W=app/dashboard/\(portal\)
rm -rf "$S"
mkdir -p "$S"

# Control Plane modules (era = omniflow-backend-patch).
for f in app.py connector_api.py portal_changes.py portal_checkout.py \
         portal_cod.py portal_coupons.py portal_events.py portal_intents.py \
         portal_kb.py portal_llm.py portal_payments.py portal_ratelimit.py; do
  cp "omniflow-backend-patch/$f" "$S/$f"
done

# Dashboard pages + cards (era = current workspace tree).
cp app/dashboard/components/DashSidebar.tsx            "$S/sidebar.tsx"
cp app/dashboard/components/CommandPalette.tsx         "$S/palette.tsx"
cp app/dashboard/components/RecoveryCard.tsx           "$S/recovery_card.tsx"
cp "$W/page.tsx"                                       "$S/overview_page.tsx"
cp "$W/settings/page.tsx"                              "$S/settings_page.tsx"
cp "$W/courier/page.tsx"                               "$S/courier_page.tsx"
cp "$W/media/page.tsx"                                 "$S/media_page.tsx"
cp "$W/broadcasts/page.tsx"                            "$S/broadcasts_page.tsx"
cp "$W/cod/page.tsx"                                   "$S/cod_page.tsx"
cp "$W/cod/RiskCard.tsx"                               "$S/risk_card.tsx"
cp "$W/cod/AddressCard.tsx"                            "$S/address_card.tsx"
cp "$W/broadcasts/CopyGenCard.tsx"                     "$S/copygen_card.tsx"
cp "$W/settings/NegotiationCard.tsx"                   "$S/negotiation_card.tsx"
cp "$W/settings/PerfCard.tsx"                          "$S/perf_card.tsx"
cp "$W/customers/profile/CustomerMemoryCard.tsx"       "$S/memory_card.tsx"
cp "$W/customers/profile/CustomerJourneyCard.tsx"      "$S/journey_card.tsx"
cp "$W/customers/profile/ProfileClient.tsx"            "$S/profile_client.tsx"

# BFF route snapshots (the rig's bff_<name>.ts pins).
A=app/api/omniflow/portal
cp "$A/perf/route.ts"                    "$S/bff_perf.ts"
cp "$A/media/route.ts"                   "$S/bff_media.ts"
cp "$A/media/delete/route.ts"            "$S/bff_media_delete.ts"
cp "$A/media/send/route.ts"              "$S/bff_media_send.ts"
cp "$A/media/transcribe/route.ts"        "$S/bff_media_transcribe.ts"
cp "$A/memory/route.ts"                  "$S/bff_memory.ts"
cp "$A/memory/[id]/route.ts"             "$S/bff_id_memory_id.ts"
cp "$A/journey/route.ts"                 "$S/bff_journey.ts"
cp "$A/journey/stages/route.ts"          "$S/bff_journey_stages.ts"
cp "$A/journey/stages/[id]/route.ts"     "$S/bff_id_stage_id.ts"
cp "$A/explain/route.ts"                 "$S/bff_explain.ts"
cp "$A/media/[id]/download/route.ts"     "$S/bff_media_download.ts"
cp "$A/recovery/route.ts"                "$S/bff_recovery.ts"
cp "$A/recovery/followup/route.ts"       "$S/bff_recovery_followup.ts"
cp "$A/recovery/dismiss/route.ts"        "$S/bff_recovery_dismiss.ts"
cp "$A/recovery/settings/route.ts"       "$S/bff_recovery_settings.ts"
cp "$A/negotiation/bounds/route.ts"      "$S/bff_negotiation_bounds.ts"
cp "$A/negotiation/decide/route.ts"      "$S/bff_negotiation_decide.ts"
cp "$A/copygen/broadcast/route.ts"       "$S/bff_copygen_broadcast.ts"
cp "$A/risk/score/route.ts"              "$S/bff_risk_score.ts"
cp "$A/risk/settings/route.ts"           "$S/bff_risk_settings.ts"
cp "$A/risk/tasks/route.ts"              "$S/bff_risk_tasks.ts"
cp "$A/address/normalize/route.ts"       "$S/bff_address_normalize.ts"
cp "$A/courier/settings/route.ts"        "$S/bff_courier_settings.ts"
cp "$A/courier/test/route.ts"            "$S/bff_courier_test.ts"
cp "$A/courier/book/route.ts"            "$S/bff_courier_book.ts"
cp "$A/courier/bookings/route.ts"        "$S/bff_courier_bookings.ts"
cp "$A/courier/track/route.ts"           "$S/bff_courier_track.ts"

echo "smoke971 repopulated: $(ls "$S" | wc -l) files"
