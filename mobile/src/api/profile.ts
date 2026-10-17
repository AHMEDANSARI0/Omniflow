/**
 * §278 P3 business profile (Settings). The CP stores the profile as a
 * free-form JSONB document (portal_profile.py): GET returns it, PUT merges
 * our edits. The mobile app curates a small, useful field set and always
 * merges into the existing document so website-owned fields survive.
 */

import { z } from "zod";
import { api } from "@/api/client";

const str = (fallback = "") =>
  z
    .string()
    .nullish()
    .transform((v) => (typeof v === "string" ? v : fallback))
    .catch(fallback);

/** The fields the mobile Settings screen edits. */
export const editableProfileSchema = z.object({
  business_name: str(),
  tagline: str(),
  phone: str(),
  address: str(),
  city: str(),
});
export type EditableProfile = z.infer<typeof editableProfileSchema>;

export const profileEnvelopeSchema = z.object({
  profile: z.record(z.string(), z.unknown()).catch({}),
  updated_at: str(),
});
export type ProfileEnvelope = z.infer<typeof profileEnvelopeSchema>;

export async function fetchProfile(): Promise<ProfileEnvelope> {
  const data = await api.get<unknown>("/api/v1/portal/profile");
  return profileEnvelopeSchema.parse(data ?? {});
}

export function editableFromEnvelope(
  envelope: ProfileEnvelope,
): EditableProfile {
  return editableProfileSchema.parse(envelope.profile);
}

export async function saveProfile(
  current: ProfileEnvelope,
  edits: EditableProfile,
): Promise<string> {
  // Merge over the full document: keys owned by the website stay intact.
  const merged: Record<string, unknown> = { ...current.profile, ...edits };
  const data = await api.put<unknown>("/api/v1/portal/profile", {
    profile: merged,
  });
  const obj = (data ?? {}) as Record<string, unknown>;
  return typeof obj.updated_at === "string" ? obj.updated_at : "";
}
