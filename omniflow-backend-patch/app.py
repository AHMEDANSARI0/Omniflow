"""Gunicorn + Vercel entry point for the OmniFlow Control Plane API v1."""

import os
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
SRC_DIR = PROJECT_ROOT / "src"

if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

# Refuse plaintext PostgreSQL transport even if a provider URL omits sslmode.
os.environ.setdefault("PGSSLMODE", "require")

from flask import Flask  # noqa: E402
from werkzeug.exceptions import MethodNotAllowed, NotFound  # noqa: E402
from werkzeug.routing import RequestRedirect  # noqa: E402

from control_plane.http_api import create_control_plane_api  # noqa: E402
from auth_password_reset import bp as auth_password_reset_bp  # noqa: E402
from admin_users import bp as admin_users_bp  # noqa: E402
from portal_channels import bp as portal_channels_bp  # noqa: E402
from portal_bot import bp as portal_bot_bp  # noqa: E402
from portal_profile import bp as portal_profile_bp  # noqa: E402
from portal_apikeys import bp as portal_apikeys_bp  # noqa: E402
from portal_conversations import bp as portal_conversations_bp  # noqa: E402
from portal_growth import bp as portal_growth_bp  # noqa: E402
from portal_cod import bp as portal_cod_bp  # noqa: E402
from portal_segments import bp as portal_segments_bp  # noqa: E402
from portal_pipeline import bp as portal_pipeline_bp  # noqa: E402
from portal_insights import bp as portal_insights_bp  # noqa: E402
from portal_contacts import bp as portal_contacts_bp  # noqa: E402
from portal_fraud import bp as portal_fraud_bp  # noqa: E402
from portal_compliance import bp as portal_compliance_bp  # noqa: E402
from portal_negotiation import bp as portal_negotiation_bp  # noqa: E402
from portal_checkout import bp as portal_checkout_bp  # noqa: E402
from portal_digest import bp as portal_digest_bp  # noqa: E402
from portal_listen import bp as portal_listen_bp  # noqa: E402
from portal_routing import bp as portal_routing_bp  # noqa: E402
from portal_reco import bp as portal_reco_bp  # noqa: E402
from portal_churn import bp as portal_churn_bp  # noqa: E402
from portal_winback import bp as portal_winback_bp  # noqa: E402
from portal_revenue import bp as portal_revenue_bp  # noqa: E402
from portal_payments import bp as portal_payments_bp  # noqa: E402
from portal_analytics import bp as portal_analytics_bp  # noqa: E402
from portal_datasafety import bp as portal_datasafety_bp  # noqa: E402
from portal_interactive import bp as portal_interactive_bp  # noqa: E402
from portal_wati import bp as portal_wati_bp  # noqa: E402
from portal_catalog import bp as portal_catalog_bp  # noqa: E402
from portal_changes import bp as portal_changes_bp  # noqa: E402
from portal_coupons import bp as portal_coupons_bp  # noqa: E402
from portal_cloud import bp as portal_cloud_bp  # noqa: E402
from portal_cloud import connector_bp as portal_cloud_connector_bp  # noqa: E402
from portal_instagram import (  # noqa: E402
    bp as portal_instagram_bp,
    public_bp as portal_instagram_public_bp,
    connector_bp as portal_instagram_connector_bp,
)
from portal_events import bp as portal_events_bp  # noqa: E402
from portal_rollups import bp as portal_rollups_bp  # noqa: E402
from portal_alerts import bp as portal_alerts_bp  # noqa: E402
from portal_brain import bp as portal_brain_bp  # noqa: E402
from portal_agents import bp as portal_agents_bp  # noqa: E402
from portal_workflows import bp as portal_workflows_bp  # noqa: E402
from portal_identity import bp as portal_identity_bp  # noqa: E402
from portal_knowledge import bp as portal_knowledge_bp  # noqa: E402
from portal_kb_semantic import bp as portal_kb_semantic_bp  # noqa: E402
from portal_media_ai import bp as portal_media_ai_bp  # noqa: E402
from portal_inbound_media import bp as portal_inbound_media_bp  # noqa: E402
from portal_notify import bp as portal_notify_bp  # noqa: E402
from portal_escalation import bp as portal_escalation_bp  # noqa: E402
from portal_ai_usage import bp as portal_ai_usage_bp  # noqa: E402
from portal_ai_audit import bp as portal_ai_audit_bp  # noqa: E402
from portal_ai_quality import bp as portal_ai_quality_bp  # noqa: E402
from portal_bi import bp as portal_bi_bp  # noqa: E402
from admin_ai import bp as admin_ai_bp  # noqa: E402
from portal_memory import bp as portal_memory_bp  # noqa: E402
from portal_recovery import bp as portal_recovery_bp  # noqa: E402
from portal_risk import bp as portal_risk_bp  # noqa: E402
from portal_courier import bp as portal_courier_bp  # noqa: E402
from portal_media import bp as portal_media_bp, connector_bp as portal_media_connector_bp  # noqa: E402
from portal_perf import bp as portal_perf_bp  # noqa: E402
from portal_templates import bp as portal_templates_bp  # noqa: E402
from portal_plans import bp as portal_plans_bp  # noqa: E402
from portal_brands import bp as portal_brands_bp  # noqa: E402
from admin_providers import bp as admin_providers_bp  # noqa: E402
from portal_voice import bp as portal_voice_bp, public_bp as portal_voice_public_bp  # noqa: E402
from portal_brands import store_bp as portal_brands_store_bp  # noqa: E402
from portal_video import bp as portal_video_bp  # noqa: E402
from portal_approvals import bp as portal_approvals_bp  # noqa: E402
from portal_intelligence import bp as portal_intelligence_bp  # noqa: E402
from portal_actions import bp as portal_actions_bp  # noqa: E402
from portal_snapshots import bp as portal_snapshots_bp  # noqa: E402
from portal_site_analyzer import bp as portal_site_analyzer_bp  # noqa: E402
from portal_assistant import bp as portal_assistant_bp  # noqa: E402
from portal_sandbox import bp as portal_sandbox_bp  # noqa: E402
from portal_workflow_gen import bp as portal_workflow_gen_bp  # noqa: E402
from portal_rule_conflicts import bp as portal_rule_conflicts_bp  # noqa: E402
from portal_nl_analytics import bp as portal_nl_analytics_bp  # noqa: E402
from portal_ab_tests import bp as portal_ab_tests_bp  # noqa: E402
from portal_ai_report import bp as portal_ai_report_bp  # noqa: E402
from portal_handoff_brief import bp as portal_handoff_brief_bp  # noqa: E402
from portal_sales import bp as portal_sales_bp  # noqa: E402
from portal_retention import bp as portal_retention_bp  # noqa: E402
from portal_ai_automation import bp as portal_ai_automation_bp  # noqa: E402
from portal_ai_traces import bp as portal_ai_traces_bp  # noqa: E402
from portal_proactive import bp as portal_proactive_bp  # noqa: E402
from portal_email_channel import bp as portal_email_channel_bp  # noqa: E402
from portal_sms import bp as portal_sms_bp, public_bp as portal_sms_public_bp  # noqa: E402
from portal_social import (  # noqa: E402  (§255 social channels)
    bp as portal_social_bp,
    public_bp as portal_social_public_bp,
    connector_bp as portal_social_connector_bp,
)
from portal_model_router import bp as admin_model_router_bp  # noqa: E402
from portal_policy import bp as portal_policy_bp  # noqa: E402
from portal_obs import install_obs as _install_obs  # noqa: E402
from portal_restock import bp as portal_restock_bp  # noqa: E402
from portal_value import bp as portal_value_bp  # noqa: E402
from portal_checkout import public_bp as portal_checkout_public_bp  # noqa: E402
from portal_payments import public_bp as portal_payments_public_bp  # noqa: E402
from portal_setup import bp as portal_setup_bp  # noqa: E402
from portal_webhooks import bp as portal_webhooks_bp  # noqa: E402
from portal_sequences import bp as portal_sequences_bp  # noqa: E402
from connector_api import bp as connector_api_bp  # noqa: E402
from portal_auth import bind_root_application  # noqa: E402


# --- Extension endpoints (password reset + admin + portal + connector) ------
# create_control_plane_api() returns the ControlPlaneAPI WSGI wrapper, which
# does not expose the Flask instance, so the extensions live in their own
# small Flask app and requests are dispatched by explicit URL prefixes.
aux_app = Flask("omniflow_extensions")
aux_app.register_blueprint(auth_password_reset_bp)
aux_app.register_blueprint(admin_users_bp)
aux_app.register_blueprint(portal_channels_bp)
aux_app.register_blueprint(portal_bot_bp)
aux_app.register_blueprint(portal_profile_bp)
aux_app.register_blueprint(portal_apikeys_bp)
aux_app.register_blueprint(portal_conversations_bp)
aux_app.register_blueprint(portal_growth_bp)
aux_app.register_blueprint(portal_cod_bp)
aux_app.register_blueprint(portal_segments_bp)
aux_app.register_blueprint(portal_pipeline_bp)
aux_app.register_blueprint(portal_insights_bp)
aux_app.register_blueprint(portal_contacts_bp)
aux_app.register_blueprint(portal_fraud_bp)
aux_app.register_blueprint(portal_compliance_bp)
aux_app.register_blueprint(portal_negotiation_bp)
aux_app.register_blueprint(portal_checkout_bp)
aux_app.register_blueprint(portal_digest_bp)
aux_app.register_blueprint(portal_listen_bp)
aux_app.register_blueprint(portal_routing_bp)
aux_app.register_blueprint(portal_reco_bp)
aux_app.register_blueprint(portal_churn_bp)
aux_app.register_blueprint(portal_winback_bp)
aux_app.register_blueprint(portal_revenue_bp)
aux_app.register_blueprint(portal_payments_bp)
aux_app.register_blueprint(portal_analytics_bp)
aux_app.register_blueprint(portal_datasafety_bp)
aux_app.register_blueprint(portal_interactive_bp)
aux_app.register_blueprint(portal_wati_bp)
aux_app.register_blueprint(portal_catalog_bp)
aux_app.register_blueprint(portal_changes_bp)
aux_app.register_blueprint(portal_coupons_bp)
aux_app.register_blueprint(portal_cloud_bp)
aux_app.register_blueprint(portal_cloud_connector_bp)
aux_app.register_blueprint(portal_instagram_bp)
aux_app.register_blueprint(portal_instagram_public_bp)
aux_app.register_blueprint(portal_instagram_connector_bp)
aux_app.register_blueprint(portal_events_bp)
aux_app.register_blueprint(portal_rollups_bp)
aux_app.register_blueprint(portal_alerts_bp)
aux_app.register_blueprint(portal_brain_bp)
aux_app.register_blueprint(portal_agents_bp)
aux_app.register_blueprint(portal_workflows_bp)
aux_app.register_blueprint(portal_identity_bp)
aux_app.register_blueprint(portal_knowledge_bp)
aux_app.register_blueprint(portal_kb_semantic_bp)
aux_app.register_blueprint(portal_media_ai_bp)
aux_app.register_blueprint(portal_inbound_media_bp)
aux_app.register_blueprint(portal_notify_bp)
aux_app.register_blueprint(portal_escalation_bp)
aux_app.register_blueprint(portal_ai_usage_bp)
aux_app.register_blueprint(portal_ai_audit_bp)
aux_app.register_blueprint(portal_ai_quality_bp)
aux_app.register_blueprint(portal_bi_bp)
aux_app.register_blueprint(admin_ai_bp)
aux_app.register_blueprint(portal_memory_bp)
aux_app.register_blueprint(portal_recovery_bp)
aux_app.register_blueprint(portal_risk_bp)
aux_app.register_blueprint(portal_courier_bp)
aux_app.register_blueprint(portal_media_bp)
aux_app.register_blueprint(portal_media_connector_bp)
aux_app.register_blueprint(portal_perf_bp)
aux_app.register_blueprint(portal_templates_bp)
aux_app.register_blueprint(portal_plans_bp)
aux_app.register_blueprint(portal_brands_bp)
aux_app.register_blueprint(portal_approvals_bp)
aux_app.register_blueprint(portal_intelligence_bp)
aux_app.register_blueprint(portal_actions_bp)
aux_app.register_blueprint(portal_snapshots_bp)
aux_app.register_blueprint(portal_site_analyzer_bp)
aux_app.register_blueprint(portal_assistant_bp)
aux_app.register_blueprint(portal_sandbox_bp)
aux_app.register_blueprint(portal_workflow_gen_bp)
aux_app.register_blueprint(portal_rule_conflicts_bp)
aux_app.register_blueprint(portal_nl_analytics_bp)
aux_app.register_blueprint(portal_ab_tests_bp)
aux_app.register_blueprint(portal_ai_report_bp)
aux_app.register_blueprint(portal_handoff_brief_bp)
aux_app.register_blueprint(portal_sales_bp)
aux_app.register_blueprint(portal_retention_bp)
aux_app.register_blueprint(portal_ai_automation_bp)
aux_app.register_blueprint(portal_ai_traces_bp)
aux_app.register_blueprint(portal_proactive_bp)
aux_app.register_blueprint(portal_email_channel_bp)
aux_app.register_blueprint(portal_sms_bp)
aux_app.register_blueprint(portal_sms_public_bp)
aux_app.register_blueprint(portal_social_bp)
aux_app.register_blueprint(portal_social_public_bp)
aux_app.register_blueprint(portal_social_connector_bp)
aux_app.register_blueprint(admin_model_router_bp)
aux_app.register_blueprint(portal_policy_bp)
aux_app.register_blueprint(admin_providers_bp)
aux_app.register_blueprint(portal_voice_bp)
aux_app.register_blueprint(portal_voice_public_bp)
aux_app.register_blueprint(portal_brands_store_bp)
aux_app.register_blueprint(portal_video_bp)
_install_obs(aux_app)
aux_app.register_blueprint(portal_payments_public_bp)
aux_app.register_blueprint(portal_restock_bp)
aux_app.register_blueprint(portal_value_bp)
aux_app.register_blueprint(portal_checkout_public_bp)
aux_app.register_blueprint(portal_setup_bp)
aux_app.register_blueprint(portal_webhooks_bp)
aux_app.register_blueprint(portal_sequences_bp)
aux_app.register_blueprint(connector_api_bp)

_EXTENSION_PREFIXES = (
    "/api/v1/auth/forgot-password",
    "/api/v1/auth/reset-password",
    "/api/v1/admin/users",
    "/api/v1/admin/reset-codes",
    "/api/v1/portal/",
    "/api/v1/connector/",
)

# Every route the extension blueprints define, resolved from the aux URL
# map itself. The prefix tuple above is the fast path; this is the safety
# net so a registered blueprint (public checkout / store / voice webhooks,
# admin providers / email test / weekly report / AI control) can never sit
# unreachable behind the primary API's 404.
_AUX_URLS = aux_app.url_map.bind("omniflow-extensions")


def _aux_serves(path: str, method: str) -> bool:
    """True when aux_app should answer this request."""
    if path.startswith(_EXTENSION_PREFIXES):
        return True
    try:
        _AUX_URLS.match(path, method=(method or "GET").upper())
    except NotFound:
        return False
    except (MethodNotAllowed, RequestRedirect):
        return True
    except Exception:  # pragma: no cover - dispatch itself must never fail
        return False
    return True


class _CompositeWsgi:
    """Dispatches extension paths to aux_app, everything else to the API."""

    def __init__(self, primary, aux):
        self._primary = primary
        self._aux = aux

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        if _aux_serves(path, environ.get("REQUEST_METHOD", "GET")):
            return self._aux(environ, start_response)
        return self._primary(environ, start_response)


application = _CompositeWsgi(create_control_plane_api(), aux_app)

# Portal extensions validate customer Bearer tokens by asking the MAIN app
# itself (in-process GET /api/v1/auth/me) — bind the composite root here.
bind_root_application(application)

# Vercel discovers the entry point through a top-level ``app`` variable.
# Keep ``application`` for the existing Gunicorn entry point.
app = application
