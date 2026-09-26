"""Vertical template packs + one-click blueprint apply (V2 B15).

The packs are DATA (six starter verticals: ecommerce, salon, clinic,
restaurant, real estate, education). Applying a pack seeds the
workspace with a matching assistant persona, starter knowledge-base
entries, customer-facing saved replies, keyword alert rules and
journey stages - everything idempotent (existing titles, shortcuts,
stages and keywords are never duplicated) and reversible by simply
deleting the created rows through their own pages.

Owner-only, human-only (API keys get 403): a template shapes the
whole tenant, so it is an owner decision by definition.
"""
import logging
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

from portal_auth import (
    PortalAuthUnavailable,
    authenticate_portal_request,
)
import portal_db
import portal_kb
import portal_listen

bp = Blueprint("portal_templates", __name__,
               url_prefix="/api/v1/portal")
logger = logging.getLogger(__name__)

SETTINGS_TABLE = "portal_templates_applied"

# ---------------------------------------------------------------------------
# The packs (pure data - add a vertical = add an entry here)
# ---------------------------------------------------------------------------

VERTICAL_PACKS: Dict[str, Dict[str, Any]] = {
    "ecommerce": {
        "label": "E-commerce store",
        "description": "COD orders, shipping questions, returns and "
                       "order alerts for an online shop.",
        "persona": {
            "agent_name": "Store Assistant",
            "tone": "friendly",
            "greeting": "Assalam-o-Alaikum! Welcome! Bataiye aap ko kya "
                        "dhoondna he - hum foran madad karte hain.",
            "fallback": "Shukriya! Aap ka sawal note kar liya he - team "
                        "confirm kar ke foran jawab degi.",
        },
        "kb": [
            {"title": "Delivery time", "category": "shipping",
             "keywords": "delivery, shipping, kab milega, kitne din, "
                         "delivery time",
             "content": "Karachi me 1-2 din, baqi shehron me 2-4 din. "
                        "Order confirm hote hi tracking number WhatsApp "
                        "par mil jata he. English: orders arrive in 2-4 "
                        "days nationwide.",
             "lang": "roman"},
            {"title": "Return and exchange", "category": "policy",
             "keywords": "return, exchange, wapsi, refund, kharab",
             "content": "Delivery ke 7 din andar return ya exchange "
                        " Mumkin he - product unused ho. Hum courier se "
                        "pick-up karwa dete hain. English: 7-day returns "
                        "on unused items, free pickup.",
             "lang": "roman"},
            {"title": "Payment methods", "category": "payments",
             "keywords": "payment, COD, cash on delivery, advance, "
                         "jazzcash, easypaisa",
             "content": "COD (delivery par cash), JazzCash aur "
                        "Easypaisa - teeno accept karte hain. COD par "
                        "koi extra charges nahi. English: COD, JazzCash "
                        "and Easypaisa accepted.",
             "lang": "roman"},
        ],
        "keywords": [
            {"keyword": "order", "note": "Customer wants to place an order"},
            {"keyword": "refund", "note": "Refund or return request - "
                                          "answer fast"},
        ],
        "saved_replies": [
            {"shortcut": "/cod", "body": "Ji haan, COD available he - "
                                         "delivery par cash pay karein."},
            {"shortcut": "/timing", "body": "Hum roz subah 10 se raat 10 "
                                            "tak online hote hain."},
            {"shortcut": "/track", "body": "Aap ka order book ho gaya he! "
                                           "Tracking number abhi milta "
                                           "he, wo yahan share kar dete "
                                           "hain."},
        ],
        "journey": ["New", "Engaged", "Customer"],
    },
    "salon": {
        "label": "Salon / beauty",
        "description": "Appointment booking, price lists and walk-in "
                       "management for salons.",
        "persona": {
            "agent_name": "Salon Assistant",
            "tone": "friendly",
            "greeting": "Assalam-o-Alaikum! Appointment book karne ke "
                        "liye date aur service bata dein.",
            "fallback": "Ji, hum ne aap ka message note kar liya he - "
                        "slots check kar ke foran confirm karenge.",
        },
        "kb": [
            {"title": "Booking an appointment", "category": "booking",
             "keywords": "appointment, booking, book, slot, waqt",
             "content": "Appointment WhatsApp par confirm hota he - "
                        "service aur date batayein. Same-day slots subject "
                        "to availability. English: bookings confirmed on "
                        "WhatsApp, same-day slots when free.",
             "lang": "roman"},
            {"title": "Prices", "category": "pricing",
             "keywords": "price, rate, charges, kitne, fees",
             "content": "Price list service ke hisab se alag he - ''/prices'' "
                        "bhejein ya service ka naam likhein, foran rate "
                        "bataya jayega. English: share a service name and "
                        "we reply with the exact rate.",
             "lang": "roman"},
            {"title": "Location and timings", "category": "general",
             "keywords": "location, address, kahan, timings, khulne",
             "content": "Subah 11 se raat 9 tak khule hain. Location pin "
                        "WhatsApp par bhej di jati he - bas ''location'' "
                        "likhein. English: open 11am-9pm, pin shared on "
                        "request.",
             "lang": "roman"},
        ],
        "keywords": [
            {"keyword": "booking", "note": "Appointment request"},
            {"keyword": "rate", "note": "Price question - reply with the "
                                        "rate list"},
        ],
        "saved_replies": [
            {"shortcut": "/book", "body": "Ji! Kaunsi service aur kis din "
                                          "ke liye booking karni he?"},
            {"shortcut": "/prices", "body": "Facial 3000, haircut 1500, "
                                            "manicure 2000 - poori list "
                                            "bhej doon?"},
            {"shortcut": "/location", "body": "Hum [area] me hain - location "
                                              "ka pin bhej dete hain."},
        ],
        "journey": ["New", "Booked", "Regular"],
    },
    "clinic": {
        "label": "Clinic / doctor",
        "description": "Appointment slots, timings and fee questions for "
                       "clinics and doctors.",
        "persona": {
            "agent_name": "Clinic Assistant",
            "tone": "professional",
            "greeting": "Assalam-o-Alaikum. Appointment ke liye Mariz ka "
                        "naam aur pasandeeda waqt batayein.",
            "fallback": "Aap ka message record ho gaya he. Staff jald az "
                        "jald rabta karegi. Emergency me foran call karein.",
        },
        "kb": [
            {"title": "Appointment process", "category": "booking",
             "keywords": "appointment, booking, checkup, milna, waqt",
             "content": "Appointment phone/WhatsApp par confirm hota he - "
                        "Mariz ka naam, umar aur masla likhein. Slot "
                        "confirmation usi din mil jati he. English: share "
                        "name, age and concern; we confirm the slot.",
             "lang": "roman"},
            {"title": "Timings and off days", "category": "general",
             "keywords": "timing, khulne, kab, off, Sunday",
             "content": "Clinic Sham 5 se Raat 10 tak, Juma band. Emergency "
                        "ke liye number par call karein. English: 5pm-10pm "
                        "weekdays, Friday closed.",
             "lang": "roman"},
            {"title": "Consultation fee", "category": "pricing",
             "keywords": "fee, fees, paise, charges, kitna",
             "content": "Consultation fee [amount] he, follow-up 7 din "
                        "andar muft. English: consultation [amount], free "
                        "follow-up within 7 days.",
             "lang": "roman"},
        ],
        "keywords": [
            {"keyword": "appointment", "note": "Appointment request"},
            {"keyword": "emergency", "note": "Urgent - flag for staff "
                                             "immediately"},
        ],
        "saved_replies": [
            {"shortcut": "/appointment", "body": "Appointment ke liye Mariz "
                                                 "ka naam, umar aur masla "
                                                 "bhej dein."},
            {"shortcut": "/timings", "body": "Clinic Sham 5 se Raat 10 tak "
                                             "khuli he (Juma band)."},
            {"shortcut": "/fees", "body": "Consultation fee [amount] he - "
                                          "follow-up 7 din andar muft."},
        ],
        "journey": ["Inquiry", "Appointment", "Patient"],
    },
    "restaurant": {
        "label": "Restaurant / cafe",
        "description": "Menu shares, delivery orders and table requests "
                       "for food businesses.",
        "persona": {
            "agent_name": "Restaurant Assistant",
            "tone": "friendly",
            "greeting": "Assalam-o-Alaikum! Aaj kya khayenge? Menu aur "
                        "deals ke liye ''menu'' likhein.",
            "fallback": "Shukriya! Order note kar liya he - team confirm "
                        "kar ke foran bata gi.",
        },
        "kb": [
            {"title": "Menu and deals", "category": "menu",
             "keywords": "menu, khana, deal, price, kitne ka",
             "content": "Aaj ke deals WhatsApp par share kiye jate hain - "
                        "''menu'' likhein aur poori list foran mil jayegi. "
                        "English: type ''menu'' any time for the latest "
                        "list.",
             "lang": "roman"},
            {"title": "Delivery areas and time", "category": "delivery",
             "keywords": "delivery, home delivery, ghar, kitni der, area",
             "content": "Delivery 30-45 min me, shehr ke andar. Order "
                        "confirm hote hi rider assign ho jata he. English: "
                        "city-wide delivery in 30-45 minutes.",
             "lang": "roman"},
            {"title": "Table reservation", "category": "booking",
             "keywords": "table, reservation, booking, jagah, seat",
             "content": "Table booking ke liye logon ki tadaad aur waqt "
                        "batayein - hum reserve kar dete hain. English: "
                        "share headcount and time to reserve a table.",
             "lang": "roman"},
        ],
        "keywords": [
            {"keyword": "menu", "note": "Send the menu card"},
            {"keyword": "order", "note": "Delivery/takeaway order"},
        ],
        "saved_replies": [
            {"shortcut": "/menu", "body": "Aaj ka menu: Karahi, Biryani, "
                                          "BBQ platter - poori list prices "
                                          "ke saath bhej doon?"},
            {"shortcut": "/deal", "body": "Aaj ka deal: 2 deals Rs 1500 - "
                                          "order confirm kar dein?"},
            {"shortcut": "/address", "body": "Hum [area] me hain - pin "
                                             "location bhej dete hain."},
        ],
        "journey": ["New", "Ordered", "Regular"],
    },
    "real_estate": {
        "label": "Real estate",
        "description": "Plot and property inquiries, site visits and "
                       "buyer follow-up.",
        "persona": {
            "agent_name": "Property Assistant",
            "tone": "professional",
            "greeting": "Assalam-o-Alaikum! Kis area ya budget me property "
                        "dhoond rahe hain?",
            "fallback": "Ji, aap ki requirement note kar li gayi he - "
                        "options check kar ke aaj hi update dunga.",
        },
        "kb": [
            {"title": "Available listings", "category": "listings",
             "keywords": "plot, file, house, flat, listing, available",
             "content": "Current listings area aur budget ke hisab se "
                        "bheji jati hain - apna area aur range likhein. "
                        "English: share your area and budget for matching "
                        "options.",
             "lang": "roman"},
            {"title": "Site visit booking", "category": "booking",
             "keywords": "visit, site, dekhna, tour, kabja",
             "content": "Site visit roz subah 10 se sham 6 tak hoti he - "
                        "din bata dein, hum schedule kar dete hain. "
                        "English: site visits daily 10am-6pm by schedule.",
             "lang": "roman"},
            {"title": "Payment plan", "category": "payments",
             "keywords": "installment, payment plan, qist, advance, booking "
                         "amount",
             "content": "Installment plans available hain - booking amount "
                        "aur monthly qist file ke hisab se. English: "
                        "installment plans vary per file; ask for the "
                        "sheet.",
             "lang": "roman"},
        ],
        "keywords": [
            {"keyword": "plot", "note": "Property inquiry - send listings"},
            {"keyword": "visit", "note": "Site visit request"},
        ],
        "saved_replies": [
            {"shortcut": "/listings", "body": "Apna area aur budget bata "
                                              "dein, matching options bhej "
                                              "ta hoon."},
            {"shortcut": "/visit", "body": "Site visit ke liye din aur waqt "
                                           "batayein - schedule kar deta "
                                           "hoon."},
            {"shortcut": "/plan", "body": "Installment plan ki sheet bhej "
                                          "deti hoon - booking amount se "
                                          "shuru hota he."},
        ],
        "journey": ["Lead", "Site visit", "Buyer"],
    },
    "education": {
        "label": "Education / coaching",
        "description": "Admissions, fee structures and class schedules for "
                       "schools and academies.",
        "persona": {
            "agent_name": "Admissions Assistant",
            "tone": "professional",
            "greeting": "Assalam-o-Alaikum! Kis class me admission leni he? "
                        "Details bhej dete hain.",
            "fallback": "Ji, aap ka sawal note ho gaya he - administration "
                        "jawab degi. Shukriya!",
        },
        "kb": [
            {"title": "Admission process", "category": "admissions",
             "keywords": "admission, dakhla, enroll, form, apply",
             "content": "Admission ke liye form, B-Form aur 2 photos chahiye. "
                        "Test/Interview agle din hota he. English: form + "
                        "B-Form + 2 photos; test and interview next day.",
             "lang": "roman"},
            {"title": "Fee structure", "category": "pricing",
             "keywords": "fee, fees, kharcha, installment, kitni",
             "content": "Class ke hisab se fees alag he - class ka naam "
                        "likhein, structure foran mil jayega. English: "
                        "share the class name for the exact fee sheet.",
             "lang": "roman"},
            {"title": "Class timings", "category": "general",
             "keywords": "timing, class, kab, schedule, shift",
             "content": "Subah shift 8-12, sham shift 3-7. Batch ke hisab "
                        "se timing confirm hoti he. English: morning 8-12, "
                        "evening 3-7 shifts.",
             "lang": "roman"},
        ],
        "keywords": [
            {"keyword": "admission", "note": "Admission inquiry"},
            {"keyword": "fees", "note": "Fee structure request"},
        ],
        "saved_replies": [
            {"shortcut": "/admission", "body": "Admission ke liye form + "
                                               "B-Form + 2 photos chahiye - "
                                               "details bhej doon?"},
            {"shortcut": "/fees", "body": "Class bata dein, fee structure "
                                          "foran bhej dete hain."},
            {"shortcut": "/schedule", "body": "Subah shift 8-12, sham shift "
                                              "3-7 - batch ke hisab se "
                                              "timing confirm hoti he."},
        ],
        "journey": ["Inquiry", "Applied", "Enrolled"],
    },
}

PACK_LIMIT = 100  # hard safety: never seed more than this per category


def _principal_or_error():
    try:
        principal = authenticate_portal_request()
    except PortalAuthUnavailable as error:
        return None, (jsonify({"error": {"code": "portal_unavailable",
                                         "message": "Try again shortly."}}),
                      503)
    if principal is None:
        return None, (jsonify({"error": {"code": "unauthorized",
                                         "message": "Sign in required."}}),
                      401)
    if principal.get("via_api_key"):
        return None, (jsonify({"error": {"code": "forbidden",
                                         "message": "Owner sign-in"
                                                    " required."}}),
                      403)
    return principal, None


_DDL_READY = False

_DDL = """
CREATE TABLE IF NOT EXISTS portal_templates_applied (
  client_id BIGINT PRIMARY KEY,
  vertical TEXT NOT NULL DEFAULT '',
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def _ensure_ddl(cur) -> None:
    global _DDL_READY
    if _DDL_READY:
        return
    cur.execute(_DDL)
    _DDL_READY = True


def _load_applied(cur, client_id: int) -> Dict[str, Any]:
    cur.execute(
        "SELECT vertical, applied_at FROM "
        + portal_db._q(SETTINGS_TABLE) +
        " WHERE client_id = %s LIMIT 1",
        (client_id,),
    )
    rows = portal_db.rows(cur)
    if not rows:
        return {"vertical": "", "applied_at": ""}
    return {"vertical": str(rows[0].get("vertical") or ""),
            "applied_at": str(rows[0].get("applied_at") or "")}


@bp.get("/templates")
def list_templates():
    """All packs with their full contents (small enough to ship in one
    response - the wizard previews client-side) + which one applied."""
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            applied = _load_applied(cur, int(principal["client_id"]))
        conn.commit()
    finally:
        conn.close()
    packs = []
    for key, pack in VERTICAL_PACKS.items():
        packs.append({
            "key": key,
            "label": pack["label"],
            "description": pack["description"],
            "persona": pack["persona"],
            "kb": pack["kb"],
            "keywords": pack["keywords"],
            "saved_replies": pack["saved_replies"],
            "journey": pack["journey"],
        })
    return jsonify({"packs": packs, "applied": applied["vertical"],
                    "applied_at": applied["applied_at"]}), 200


def _apply_pack(cur, client_id: int, key: str,
                overwrite_persona: bool) -> Dict[str, Any]:
    """Idempotent seeding - one transaction, counts of what changed."""
    pack = VERTICAL_PACKS[key]
    created = {"kb": 0, "keywords": 0, "saved_replies": 0,
               "journey": 0, "persona": 0}

    # 1) persona - only seeds an empty desk, never overwrites a live one
    cur.execute(
        "SELECT agent_name, greeting, fallback FROM "
        + portal_db._q(portal_db.BOT_TABLE) +
        " WHERE client_id = %s LIMIT 1",
        (client_id,),
    )
    bot_rows = portal_db.rows(cur)
    persona = pack["persona"]
    if not bot_rows:
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_db.BOT_TABLE) +
            " (client_id, agent_name, tone, greeting, fallback)"
            " VALUES (%s, %s, %s, %s, %s)"
            " ON CONFLICT (client_id) DO UPDATE SET agent_name ="
            " EXCLUDED.agent_name, tone = EXCLUDED.tone,"
            " greeting = EXCLUDED.greeting, fallback = EXCLUDED.fallback,"
            " updated_at = NOW()",
            (client_id, persona["agent_name"], persona["tone"],
             persona["greeting"], persona["fallback"]),
        )
        created["persona"] = 1
    elif overwrite_persona:
        cur.execute(
            "UPDATE " + portal_db._q(portal_db.BOT_TABLE) +
            " SET agent_name = %s, tone = %s, greeting = %s,"
            " fallback = %s, updated_at = NOW() WHERE client_id = %s",
            (persona["agent_name"], persona["tone"],
             persona["greeting"], persona["fallback"], client_id),
        )
        created["persona"] = 1

    # 2) KB entries - skip titles that already exist
    cur.execute(
        "SELECT title FROM " + portal_db._q(portal_kb.KB_TABLE) +
        " WHERE client_id = %s",
        (client_id,),
    )
    existing_titles = {str(r.get("title") or "") for r in
                       portal_db.rows(cur)[:PACK_LIMIT]}
    for entry in pack["kb"][:PACK_LIMIT]:
        if entry["title"] in existing_titles:
            continue
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_kb.KB_TABLE) +
            " (client_id, title, category, keywords, content,"
            " is_active, lang) VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (client_id, entry["title"], entry["category"],
             entry["keywords"], entry["content"], True,
             entry.get("lang", "en")),
        )
        created["kb"] += 1

    # 3) saved replies - skip existing shortcuts
    cur.execute(
        "SELECT shortcut FROM "
        + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
        " WHERE client_id = %s",
        (client_id,),
    )
    existing_shortcuts = {str(r.get("shortcut") or "") for r in
                          portal_db.rows(cur)[:PACK_LIMIT]}
    for reply in pack["saved_replies"][:PACK_LIMIT]:
        if reply["shortcut"] in existing_shortcuts:
            continue
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_db.SAVED_REPLIES_TABLE) +
            " (client_id, shortcut, body, created_at)"
            " VALUES (%s, %s, %s, NOW())",
            (client_id, reply["shortcut"], reply["body"]),
        )
        created["saved_replies"] += 1

    # 4) keyword alert rules - upsert like portal_listen does
    for rule in pack["keywords"][:PACK_LIMIT]:
        cur.execute(
            "INSERT INTO " + portal_db._q(portal_listen.RULES_TABLE) +
            " (client_id, keyword, note) VALUES (%s, %s, %s)"
            " ON CONFLICT (client_id, keyword) DO NOTHING",
            (client_id, rule["keyword"], rule["note"]),
        )
        created["keywords"] += 1

    # 5) journey stages - seed only missing names
    for position, name in enumerate(pack["journey"][:PACK_LIMIT]):
        cur.execute(
            "INSERT INTO " + portal_db._q("portal_journey_stages") +
            " (client_id, name, position, is_active)"
            " VALUES (%s, %s, %s, TRUE)"
            " ON CONFLICT (client_id, name) DO NOTHING",
            (client_id, name, position),
        )
        created["journey"] += 1
    return created


@bp.post("/templates/apply")
def apply_template():
    principal, auth_error = _principal_or_error()
    if auth_error:
        return auth_error
    payload = request.get_json(silent=True) or {}
    key = str(payload.get("vertical") or "").strip().lower()
    if key not in VERTICAL_PACKS:
        return jsonify({"error": {"code": "bad_request",
                                  "message": "vertical must be one of: "
                                             + ", ".join(
                                                 sorted(VERTICAL_PACKS))
                                             + "."}}), 400
    overwrite_persona = bool(payload.get("overwrite_persona"))
    client_id = int(principal["client_id"])
    conn = portal_db._conn()
    try:
        with conn.cursor() as cur:
            _ensure_ddl(cur)
            created = _apply_pack(cur, client_id, key, overwrite_persona)
            cur.execute(
                "INSERT INTO " + portal_db._q(SETTINGS_TABLE) +
                " (client_id, vertical, applied_at)"
                " VALUES (%s, %s, NOW())"
                " ON CONFLICT (client_id) DO UPDATE SET"
                " vertical = EXCLUDED.vertical,"
                " applied_at = EXCLUDED.applied_at",
                (client_id, key),
            )
            portal_db.log_action(
                cur, client_id, "template.applied", "human",
                None, None,
                "Template " + key + " applied (kb " + str(created["kb"])
                + ", replies " + str(created["saved_replies"])
                + ", keywords " + str(created["keywords"])
                + ", stages " + str(created["journey"]) + ")",
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "vertical": key, "created": created}), 200
