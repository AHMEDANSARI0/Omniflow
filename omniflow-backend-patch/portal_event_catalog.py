"""Event catalog (§225): one typed list of the platform's business events.

Why
---
``portal_action_log`` already is the platform's event stream AND its
transactional outbox: every business change writes its log row on the
same cursor (same transaction) as the change itself, so an event exists
exactly when the change committed - nothing to dual-write, no extra
queue. Consumers read that stream with their own cursor:

* workflows  -> ``portal_workflows.trigger_log_events`` (``last_log_id``)
* webhooks   -> ``portal_webhooks.deliver_pending_webhooks``
  (per-endpoint ``last_log_id`` since §225, retries + dead letters)

What was missing was a single, typed NAME list: webhooks hardcoded two
events, workflows kept their own strings. This module is that list.
Every entry below is written by real code today (verified by the rig's
AST scan) - no aspirational events.

Rules
-----
* ``category`` is what a webhook subscribes to (``X-Omniflow-Event``);
  the exact event name travels as ``action`` in the payload.
* Adding an event = one entry here. Consumers derive from this module.
"""

from typing import Any, Dict, List

#: category key -> owner-facing label (webhook subscription groups)
CATEGORIES: Dict[str, str] = {
    "cod": "COD confirmations",
    "broadcast": "Broadcasts",
    "payments": "Payments",
    "orders": "Orders & checkout",
    "shipping": "Shipping",
    "pipeline": "Pipeline",
    "approvals": "Approvals",
    "handoffs": "Handoffs",
    "feedback": "Customer feedback",
    "compliance": "Opt-outs",
    "risk": "Fraud & risk",
}

#: event name (portal_action_log.action) -> metadata
EVENTS: Dict[str, Dict[str, str]] = {
    "cod.confirmed": {
        "category": "cod", "label": "COD order confirmed",
        "description": "The customer confirmed a cash-on-delivery order."},
    "cod.declined": {
        "category": "cod", "label": "COD order declined",
        "description": "The customer declined a cash-on-delivery order."},
    "broadcast.sent": {
        "category": "broadcast", "label": "Broadcast sent",
        "description": "A broadcast finished sending."},
    "payment.gateway_paid": {
        "category": "payments", "label": "Payment received",
        "description": "A gateway payment landed on a checkout link."},
    "checkout.created": {
        "category": "orders", "label": "Checkout link created",
        "description": "A checkout link was created for a customer."},
    "checkout.paid": {
        "category": "orders", "label": "Order marked paid",
        "description": "An owner marked a checkout link as paid."},
    "checkout.cancelled": {
        "category": "orders", "label": "Order cancelled",
        "description": "A checkout link was cancelled."},
    "checkout.shipped": {
        "category": "orders", "label": "Order shipped",
        "description": "A checkout link was marked shipped."},
    "checkout.delivered": {
        "category": "orders", "label": "Order delivered",
        "description": "A checkout link was marked delivered."},
    "checkout.returned": {
        "category": "orders", "label": "Order returned",
        "description": "A checkout link was marked returned."},
    "courier.book": {
        "category": "shipping", "label": "Parcel booked",
        "description": "A parcel was booked with a courier."},
    "courier.book.confirm": {
        "category": "shipping", "label": "Draft booking confirmed",
        "description": "A draft courier booking was confirmed."},
    "pipeline.stage_changed": {
        "category": "pipeline", "label": "Pipeline stage changed",
        "description": "A contact moved to another pipeline stage."},
    "approval.created": {
        "category": "approvals", "label": "Approval requested",
        "description": "An AI action is waiting for an owner decision."},
    "approval.approved": {
        "category": "approvals", "label": "Approval approved",
        "description": "An owner approved a pending action."},
    "approval.rejected": {
        "category": "approvals", "label": "Approval rejected",
        "description": "An owner rejected a pending action."},
    "escalation.opened": {
        "category": "handoffs", "label": "Handoff opened",
        "description": "A chat was handed to the team."},
    "escalation.resolved": {
        "category": "handoffs", "label": "Handoff resolved",
        "description": "A handed-off chat was resolved."},
    "csat.received": {
        "category": "feedback", "label": "CSAT score received",
        "description": "A customer answered the satisfaction question."},
    "compliance.optout": {
        "category": "compliance", "label": "Customer opted out",
        "description": "A customer asked to stop receiving messages."},
    "fraud.flagged": {
        "category": "risk", "label": "Order flagged as risky",
        "description": "The fraud check flagged an order."},
}


def known(name: str) -> bool:
    return str(name or "") in EVENTS


def category_of(name: str) -> str:
    return (EVENTS.get(str(name or "")) or {}).get("category", "")


def actions_for(categories: List[str]) -> List[str]:
    """Event names covered by a webhook subscription (``all`` = every)."""
    wanted = set(categories or [])
    every = "all" in wanted
    return sorted(name for name, spec in EVENTS.items()
                  if every or spec["category"] in wanted)


def _workflow_triggers() -> Dict[str, List[str]]:
    """event name -> workflow trigger keys that fire on it (fail-soft)."""
    found: Dict[str, List[str]] = {}
    try:
        import portal_workflows

        for key, spec in portal_workflows.TRIGGERS.items():
            for action in spec.get("actions") or []:
                found.setdefault(action, []).append(key)
    except Exception:
        return {}
    return found


def public_catalog() -> Dict[str, Any]:
    triggers = _workflow_triggers()
    events = [{
        "type": name,
        "label": spec["label"],
        "description": spec["description"],
        "category": spec["category"],
        "categoryLabel": CATEGORIES.get(spec["category"], spec["category"]),
        "workflowTriggers": triggers.get(name, []),
    } for name, spec in sorted(EVENTS.items())]
    counts: Dict[str, int] = {}
    for item in events:
        counts[item["category"]] = counts.get(item["category"], 0) + 1
    return {
        "events": events,
        "categories": [{"key": key, "label": label,
                        "events": counts.get(key, 0)}
                       for key, label in CATEGORIES.items()],
    }
