# Control Plane test rig

The agent sandbox cannot clone the private OmniFlow-Control-Plane repo, so
this directory keeps a faithful conversations-only reconstruction of
`portal_conversations.py` (regions verbatim from the shipped patchers) plus
the DB/auth modules from `omniflow-backend-patch/` and the Flask test suites.

`sh tools/cp-testrig/rebuild.sh` recreates `/tmp/p13`: the website at
origin/main, this Control Plane base, the Phase 36-42 patchers applied on
top, and npm dependencies. Run the suites from
`/tmp/p13/OmniFlow-Control-Plane` with `OMNIFLOW_SERVICE_KEY=x`.
