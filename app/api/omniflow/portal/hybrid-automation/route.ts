import { authorizePortalOperation } from "../../../../../lib/omniflow/authz";
import {
  executeHybridWhatsAppPipeline,
  getTenantHybridConfig,
  saveTenantHybridConfig,
  type BasicBusinessConfig,
  type HybridDeterministicRule,
} from "../../../../../lib/omniflow/hybrid-whatsapp-engine";
import {
  noStoreHeaders,
  safeJson,
  sameOrigin,
} from "../../../../../lib/omniflow/request-security";

export async function GET() {
  const auth = await authorizePortalOperation({
    feature: "basic.hybrid_ai",
    permission: "read",
  });
  if (!auth.ok) return auth.response;

  const data = await getTenantHybridConfig(auth.principal.clientId);
  return safeJson(data, 200);
}

export async function PUT(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const auth = await authorizePortalOperation({
    feature: "basic.hybrid_ai",
    permission: "update",
  });
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => ({}))) as {
    businessConfig?: Partial<BasicBusinessConfig>;
    rules?: HybridDeterministicRule[];
  };

  const updated = await saveTenantHybridConfig(auth.principal.clientId, {
    businessConfig: body.businessConfig,
    rules: body.rules,
  });

  return safeJson({ ok: true, ...updated }, 200);
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return safeJson(
      { error: { code: "forbidden", message: "Request origin was rejected." } },
      403
    );
  }

  const auth = await authorizePortalOperation({
    feature: "basic.hybrid_ai",
    permission: "execute",
    connector: "whatsapp",
  });
  if (!auth.ok) return auth.response;

  const body = (await request.json().catch(() => ({}))) as {
    messageId?: string;
    contactId?: string;
    contactName?: string;
    text?: string;
    isFirstMessage?: boolean;
  };

  const text = (body.text || "").trim();
  if (!text) {
    return safeJson(
      { error: { code: "bad_request", message: "Message text is required." } },
      400
    );
  }

  const result = await executeHybridWhatsAppPipeline({
    clientId: auth.principal.clientId,
    messageId: body.messageId || "msg_" + Date.now(),
    contactId: body.contactId || "+923001234567",
    contactName: body.contactName || "Customer",
    text,
    isFirstMessage: Boolean(body.isFirstMessage),
  });

  return safeJson(result, result.ok ? 200 : 403);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}
