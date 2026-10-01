/** Shared by the conversation media card and the chat-bubble previews
 * (§214 / §215): customer files from the media store. */
export interface InboundMediaItem {
  id: number;
  /** Message the file arrived with (null when it cannot be matched). */
  message_id: number | null;
  kind: string;
  mime: string;
  size_bytes: number;
  status: string;
  note: string;
  channel: string;
  has_copy: boolean;
  can_open: boolean;
  can_refresh: boolean;
  created_at: string | null;
}

/** Fired after a file is deleted so the chat bubbles reload their files. */
export const MEDIA_CHANGED_EVENT = "omniflow:inbound-media-changed";

export const KIND_LABELS: Record<string, string> = {
  image: "Image",
  audio: "Voice note",
  video: "Video",
  file: "File",
};

export const NOTE_LABELS: Record<string, string> = {
  copies_off: "Copies are off",
  too_large: "Too large to keep",
  unsupported: "Format not kept",
  download_failed: "Could not be saved",
  no_source: "No file received",
  retention: "Removed after the keep period",
  quota: "Removed to stay within storage",
};

export function sizeLabel(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export function contentUrl(id: number): string {
  return "/api/omniflow/portal/inbound-media/" + id + "/content";
}

export function mediaListUrl(conversationId: number | string): string {
  return "/api/omniflow/portal/conversations/" + conversationId + "/media";
}

/** Fetch a conversation's files; null on any failure. */
export async function fetchConversationMedia(
  conversationId: number | string
): Promise<InboundMediaItem[] | null> {
  try {
    const response = await fetch(mediaListUrl(conversationId), { cache: "no-store" });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as {
      media?: InboundMediaItem[];
    } | null;
    return payload && Array.isArray(payload.media) ? payload.media : null;
  } catch {
    return null;
  }
}

/** Files grouped by message id, each group in attachment order. */
export function groupByMessage(
  items: InboundMediaItem[]
): Record<number, InboundMediaItem[]> {
  const groups: Record<number, InboundMediaItem[]> = {};
  for (const item of items) {
    if (!item.message_id) continue;
    (groups[item.message_id] ??= []).push(item);
  }
  for (const key of Object.keys(groups)) {
    groups[Number(key)].sort((a, b) => a.id - b.id);
  }
  return groups;
}

/** Ask the server for a (fresh) provider link; returns the url or an error. */
export async function fetchMediaLink(
  id: number
): Promise<{ url: string } | { error: string }> {
  try {
    const response = await fetch("/api/omniflow/portal/inbound-media/" + id + "/link", {
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as {
      url?: string;
      error?: { message?: string };
    } | null;
    if (response.ok && payload && typeof payload.url === "string") {
      return { url: payload.url };
    }
    return { error: payload?.error?.message || "This file is no longer available." };
  } catch {
    return { error: "Could not reach the server - try again." };
  }
}
