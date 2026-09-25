#!/bin/sh
# Rebuilds the /tmp/p13 sandbox from the persisted test rig.
# Usage: sh tools/cp-testrig/rebuild.sh   (from the website repo root)
set -e
cd "$(dirname "$0")/../.."
rm -rf /tmp/p13
mkdir -p /tmp/p13/OmniFlow-Control-Plane /tmp/p13/Omniflow

# Website: the last state pushed from the laptop (through Phase 35).
git archive origin/main | tar -x -C /tmp/p13/Omniflow

# Control Plane: the conversations-region reconstruction (base through Phase 35).
cp tools/cp-testrig/portal_conversations.py \
   tools/cp-testrig/portal_db.py \
   tools/cp-testrig/portal_auth.py \
   tools/cp-testrig/test_*.py /tmp/p13/OmniFlow-Control-Plane/
cp tools/cp-testrig/cp_gitignore /tmp/p13/OmniFlow-Control-Plane/.gitignore

# The website archive already carries every phase pushed from the laptop and
# the rig portal_conversations.py is baked through Phase 46, so no patchers
# run here. Future batches: apply their patchers manually after this script.

# Python test deps (sandbox wipes them on every rebuild).
pip install --break-system-packages --quiet flask psycopg2-binary 2>/dev/null ||   pip install --quiet flask psycopg2-binary

# Website build deps.
cd /tmp/p13/Omniflow
npm ci --silent
npm i --no-save esbuild@0.25.10 --silent
echo "SANDBOX READY"
