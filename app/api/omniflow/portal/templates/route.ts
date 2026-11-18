import {
  listTemplates,
  requirePortalAccessToken,
} from "../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../lib/omniflow/request-security";

const FALLBACK_PACKS = [
  {
    key: "ecommerce",
    label: "E-commerce store",
    description: "COD orders, shipping questions, returns and order alerts for an online shop.",
    persona: {
      agent_name: "Sara",
      tone: "friendly",
      greeting: "Assalam-o-Alaikum! Welcome to our store. Ask about any product, price, or order delivery status.",
      fallback: "Let me connect you with our order support team right away.",
    },
    kb: [
      { title: "Delivery Time", category: "Shipping", keywords: "delivery, shipping", content: "Standard delivery takes 2 to 4 working days across Pakistan.", lang: "en" },
      { title: "Return & Exchange", category: "Policy", keywords: "return, exchange", content: "Unused items can be exchanged within 7 days of delivery.", lang: "en" },
    ],
    keywords: [
      { keyword: "refund, return, damaged", note: "Flags return or damaged parcel requests" },
      { keyword: "urgent, late, cancel", note: "Alerts support when an order is delayed" },
    ],
    saved_replies: [
      { shortcut: "/shipping", body: "Standard delivery is 2–4 working days. Share your order number for tracking." },
      { shortcut: "/cod", body: "Cash on Delivery is available nationwide. Please confirm your full address and phone number." },
    ],
    journey: ["New Inquiry", "Product Interested", "Order Placed", "Delivered"],
  },
  {
    key: "salon",
    label: "Salon / beauty",
    description: "Appointment booking, price lists and walk-in management for salons.",
    persona: {
      agent_name: "Zoya",
      tone: "friendly",
      greeting: "Hello! Welcome to our salon booking desk. Would you like to check service rates or book an appointment?",
      fallback: "Our receptionist will confirm your slot shortly.",
    },
    kb: [
      { title: "Appointment Booking", category: "Booking", keywords: "book, slot, timing", content: "Share your preferred date, time, and service to reserve a slot.", lang: "en" },
    ],
    keywords: [{ keyword: "bridal, package, urgent", note: "High-value bridal or urgent booking inquiry" }],
    saved_replies: [{ shortcut: "/book", body: "Please share your name, preferred service, and time slot to confirm your appointment." }],
    journey: ["Inquiry", "Slot Requested", "Confirmed", "Completed"],
  },
  {
    key: "clinic",
    label: "Clinic / doctor",
    description: "Appointment slots, timings and fee questions for clinics and doctors.",
    persona: {
      agent_name: "Sehat Desk",
      tone: "professional",
      greeting: "Assalam-o-Alaikum! Welcome to the clinic appointment desk. How can we assist you today?",
      fallback: "Our clinic coordinator will review your message and reply shortly.",
    },
    kb: [
      { title: "Consultation Timings", category: "Hours", keywords: "timing, doctor, fee", content: "Consultations are available Monday to Saturday. Share patient name to book a token.", lang: "en" },
    ],
    keywords: [{ keyword: "emergency, severe, report", note: "Priority medical inquiry" }],
    saved_replies: [{ shortcut: "/token", body: "Please share the patient's full name and contact number to issue an appointment token." }],
    journey: ["Inquiry", "Appointment Booked", "Visited", "Follow-up"],
  },
  {
    key: "restaurant",
    label: "Restaurant / cafe",
    description: "Menu shares, delivery orders and table requests for food businesses.",
    persona: {
      agent_name: "Order Desk",
      tone: "friendly",
      greeting: "Welcome! Craving something delicious? Ask for today's menu, deals, or place a delivery order.",
      fallback: "Our order manager is checking your request right now.",
    },
    kb: [
      { title: "Home Delivery", category: "Delivery", keywords: "menu, deal, delivery", content: "Hot delivery within 35–45 minutes in our service zones.", lang: "en" },
    ],
    keywords: [{ keyword: "cold, late, missing", note: "Food quality or late delivery alert" }],
    saved_replies: [{ shortcut: "/menu", body: "Here are our bestselling deals! Tell us what you'd like to order along with your location." }],
    journey: ["Menu Sent", "Order Taking", "Kitchen Prep", "Delivered"],
  },
  {
    key: "realestate",
    label: "Real estate",
    description: "Plot and property inquiries, site visits and buyer follow-up.",
    persona: {
      agent_name: "Property Advisor",
      tone: "professional",
      greeting: "Assalam-o-Alaikum! Looking to buy, sell, or rent property? Tell us your preferred location and budget.",
      fallback: "Our senior property consultant will contact you shortly.",
    },
    kb: [
      { title: "Site Visits", category: "Visits", keywords: "visit, location, plot, price", content: "Site visits can be scheduled 7 days a week with our advisor team.", lang: "en" },
    ],
    keywords: [{ keyword: "investor, cash, booking", note: "High-intent property lead" }],
    saved_replies: [{ shortcut: "/visit", body: "Let us know which day and time works best for your site visit." }],
    journey: ["New Lead", "Requirement Shared", "Site Visit", "Negotiation"],
  },
  {
    key: "education",
    label: "Education / coaching",
    description: "Admissions, fee structures and class schedules for schools and academies.",
    persona: {
      agent_name: "Admissions Desk",
      tone: "professional",
      greeting: "Welcome to our Admissions & Student Support Desk! Ask about courses, fee structures, or batch timings.",
      fallback: "Our admissions counselor will get back to you shortly.",
    },
    kb: [
      { title: "Admissions & Batches", category: "Admissions", keywords: "admission, fee, course, timing", content: "New batches start every month. Share the course name for complete details.", lang: "en" },
    ],
    keywords: [{ keyword: "scholarship, discount, admission", note: "Enrollment inquiry" }],
    saved_replies: [{ shortcut: "/fee", body: "Please share the course or grade level you are inquiring about so we can send the fee structure." }],
    journey: ["Inquiry", "Counseling", "Demo Class", "Enrolled"],
  },
];

export async function GET() {
  try {
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      const result = await listTemplates(accessToken);
      if (result && Array.isArray(result.packs) && result.packs.length > 0) {
        return safeJson(result, 200);
      }
    }
  } catch {
    // use fallback packs below
  }

  return safeJson({ packs: FALLBACK_PACKS, applied: "" }, 200);
}
