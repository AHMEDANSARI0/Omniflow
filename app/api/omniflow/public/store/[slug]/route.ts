import {
  getPublicStore,
} from "../../../../../../lib/omniflow/portal";
import {
  safeJson,
} from "../../../../../../lib/omniflow/request-security";


export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params;
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60);
  if (!clean) {
    return safeJson(
      { error: { code: "not_found", message: "Store not found." } },
      404
    );
  }
  const store = await getPublicStore(clean);
  if (store === null) {
    return safeJson(
      { error: { code: "not_found", message: "Store not found." } },
      404
    );
  }
  return safeJson(store, 200);
}
