import {
  deleteConfigSnapshot,
  getConfigSnapshot,
} from "../../../../../../lib/omniflow/portal";
import { safeJson } from "../../../../../../lib/omniflow/request-security";
import {
  serviceResponse,
  withPortalToken,
} from "../../../../../../lib/omniflow/voice-vision-bff";

type Context = { params: Promise<{ id: string }> };

async function snapshotId(context: Context): Promise<number | null> {
  const id = Number((await context.params).id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const BAD_ID = { error: { code: "bad_request", message: "Invalid snapshot id." } };

export async function GET(_request: Request, context: Context) {
  const id = await snapshotId(context);
  if (id === null) return safeJson(BAD_ID, 400);
  return withPortalToken(async (accessToken) =>
    serviceResponse(await getConfigSnapshot(accessToken, id))
  );
}

export async function DELETE(request: Request, context: Context) {
  const id = await snapshotId(context);
  if (id === null) return safeJson(BAD_ID, 400);
  return withPortalToken(
    async (accessToken) => serviceResponse(await deleteConfigSnapshot(accessToken, id)),
    request
  );
}
