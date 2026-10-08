import { SOCIAL_CHANNEL_IDS, type SocialChannelId } from "./portal";

/** §255: where the platforms send the merchant back after OAuth. */
export const SOCIAL_CALLBACK_PATH = "/api/omniflow/portal/channels/social/callback";

export function isSocialChannel(value: string): value is SocialChannelId {
  return (SOCIAL_CHANNEL_IDS as readonly string[]).includes(value);
}

/** The public origin the browser used (proxies set x-forwarded-*). */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host")?.split(",", 1)[0].trim() || request.headers.get("host") || url.host;
  const proto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0].trim() || url.protocol.replace(/:$/, "");
  return proto + "://" + host;
}
