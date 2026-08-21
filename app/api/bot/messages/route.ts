import { NextResponse } from "next/server";
import { authenticateApiKey } from "../../../../lib/bot-api";
import { createServiceClient } from "../../../../lib/supabase/service";

const VALID_ROLES = ["customer", "bot", "agent"] as const;

interface MessagePayload {
  customer_identifier?: unknown;
  customer_name?: unknown;
  channel?: unknown;
  role?: unknown;
  text?: unknown;
}

/**
 * POST /api/bot/messages
 * Auth: Authorization: Bearer ofk_...
 * Body: { customer_identifier, customer_name?, channel?, role, text }
 * The bot pushes every message here; conversations appear in the
 * client's OmniFlow dashboard.
 */
export async function POST(request: Request) {
  const userId = await authenticateApiKey(request);
  if (!userId) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }

    let payload: MessagePayload;
  try {
    // Read as text and strip BOM/whitespace — tolerant of Windows-encoded clients
    const raw = (await request.text()).replace(/^\uFEFF/, "").trim();
    payload = JSON.parse(raw) as MessagePayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const customerIdentifier = String(payload.customer_identifier ?? "").trim();
  const customerName = String(payload.customer_name ?? "").trim();
  const channel = String(payload.channel ?? "whatsapp").trim().toLowerCase();
  const role = String(payload.role ?? "").trim().toLowerCase();
  const text = String(payload.text ?? "").trim();

  if (!customerIdentifier) {
    return NextResponse.json(
      { error: "customer_identifier is required" },
      { status: 400 }
    );
  }
  if (!VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
    return NextResponse.json(
      { error: "role must be one of: customer, bot, agent" },
      { status: 400 }
    );
  }
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Find or create the conversation
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", userId)
    .eq("customer_identifier", customerIdentifier)
    .eq("channel", channel)
    .single();

  let conversationId = existing?.id as string | undefined;

  if (!conversationId) {
    const { data: created, error: createError } = await supabase
      .from("conversations")
      .insert({
        user_id: userId,
        customer_identifier: customerIdentifier,
        customer_name: customerName || customerIdentifier,
        channel,
      })
      .select("id")
      .single();

    if (createError || !created) {
      return NextResponse.json(
        { error: "Failed to create conversation" },
        { status: 500 }
      );
    }
    conversationId = created.id as string;
  }

  // Insert the message
  const { error: messageError } = await supabase
    .from("conversation_messages")
    .insert({
      conversation_id: conversationId,
      role,
      text,
    });

  if (messageError) {
    return NextResponse.json(
      { error: "Failed to save message" },
      { status: 500 }
    );
  }

  // Update conversation summary
  await supabase
    .from("conversations")
    .update({
      last_message: text.slice(0, 200),
      last_message_at: new Date().toISOString(),
      ...(customerName ? { customer_name: customerName } : {}),
    })
    .eq("id", conversationId);

  return NextResponse.json({ ok: true, conversation_id: conversationId });
}