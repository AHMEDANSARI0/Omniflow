"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../../../../lib/supabase/server";
import type { LeadStatus } from "./types";

async function requireAdmin(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  return profile?.role === "admin" ? user.id : null;
}

export async function updateLeadStatus(
  id: string,
  status: LeadStatus
): Promise<{ success: boolean }> {
  const adminId = await requireAdmin();
  if (!adminId) return { success: false };

  const supabase = await createClient();
  const { error } = await supabase.from("leads").update({ status }).eq("id", id);
  if (error) return { success: false };

  revalidatePath("/admin/leads");
  return { success: true };
}

export async function deleteLead(id: string): Promise<{ success: boolean }> {
  const adminId = await requireAdmin();
  if (!adminId) return { success: false };

  const supabase = await createClient();
  const { error } = await supabase.from("leads").delete().eq("id", id);
  if (error) return { success: false };

  revalidatePath("/admin/leads");
  return { success: true };
}

export interface InviteResult {
  success: boolean;
  message: string;
  email?: string;
  tempPassword?: string;
}

export async function inviteLead(
  _leadId: string,
  _email: string
): Promise<InviteResult> {
  const adminId = await requireAdmin();
  if (!adminId) {
    return { success: false, message: "Not authorized." };
  }

  // §276 — Supabase Auth is retired. Client portal accounts are provisioned by
  // the Control Plane (Neon), not the website database, so a website-side
  // invite can no longer create a login. The signature is kept so existing
  // callers compile and degrade gracefully until the flow is re-pointed at the
  // Control Plane.
  return {
    success: false,
    message:
      "Invites are not available right now. Client portal accounts are managed from the Control Plane.",
  };
}