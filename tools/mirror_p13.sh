#!/bin/sh
# /tmp/p13/Omniflow = deployed-era mirror of the workspace tree (the pins
# read deployed files from here). Full copy, minus heavy/dev dirs.
# Lives IN the repo so sandbox rebuilds cannot wipe it.
set -e
rm -rf /tmp/p13/Omniflow
mkdir -p /tmp/p13/Omniflow
cd /home/user/Omniflow
tar cf - --exclude=node_modules --exclude=.git --exclude=.next \
    --exclude=__pycache__ --exclude=.venv . | (cd /tmp/p13/Omniflow && tar xf -)
echo "p13 mirrored: $(find /tmp/p13/Omniflow -type f | wc -l) files"
mkdir -p /tmp/p13/OmniFlow-Control-Plane
cp -a /home/user/Omniflow/omniflow-backend-patch/. /tmp/p13/OmniFlow-Control-Plane/
echo "cp mirrored: $(find /tmp/p13/OmniFlow-Control-Plane -type f | wc -l) files"
printf '# patcher backups stay out of git\n*.pre_*.bak\n__pycache__/\n' > /tmp/p13/OmniFlow-Control-Plane/.gitignore
mkdir -p /tmp/p13/src
cp -a /home/user/Omniflow/connector-bridge/. /tmp/p13/src/
