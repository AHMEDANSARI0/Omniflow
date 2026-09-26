"""Structured request observability for the portal extension app.

Installs two tiny hooks on the aux Flask app:

* ``before_request`` stamps a short trace id and a start time on ``g``;
* ``after_request`` echoes the trace id back as ``X-OF-Trace-Id`` and emits
  ONE single-line JSON log for slow requests (>= ``OF_SLOW_LOG_MS``,
  default 400) with trace_id / method / path / duration / status.

The Vercel BFF reaches the Control Plane over the WAN, so a slow dashboard
click must be attributable from the CP log alone — one grep, one line per
slow request. Tenant ids stay inside the route-level logs; this layer only
measures. Everything is stdlib; no new infrastructure.
"""

import logging
import os
import time
import uuid

from flask import g, request

logger = logging.getLogger("omniflow.obs")

#: Requests slower than this many milliseconds get a structured log line.
SLOW_MS = int(os.environ.get("OF_SLOW_LOG_MS", "400") or 400)


def install_obs(app):
    """Attach the trace/slow-log hooks to ``app`` (idempotent-ish: safe to
    call once per app at import time, which is how app.py uses it)."""

    @app.before_request
    def _obs_begin():
        g.of_t0 = time.time()
        g.of_rid = uuid.uuid4().hex[:12]

    @app.after_request
    def _obs_end(response):
        started = getattr(g, "of_t0", None)
        duration_ms = int((time.time() - started) * 1000) if started else -1
        trace_id = getattr(g, "of_rid", "-")
        try:
            response.headers["X-OF-Trace-Id"] = trace_id
        except Exception:
            pass
        if duration_ms >= SLOW_MS:
            logger.info(
                '{"trace_id":"%s","method":"%s","path":"%s",'
                '"duration_ms":%d,"status":%s}',
                trace_id,
                request.method,
                request.path,
                duration_ms,
                response.status_code,
            )
        return response
