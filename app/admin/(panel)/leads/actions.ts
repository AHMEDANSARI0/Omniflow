"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "../../../../lib/supabase/server";
import { createServiceClient } from "../../../../lib/supabase/service";
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
  leadId: string,
  email: string
): Promise<InviteResult> {
  const adminId = await requireAdmin();
  if (!adminId) {
    return { success: false, message: "Not authorized." };
  }

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail) {
    return { success: false, message: "Lead has no email." };
  }

  const tempPassword = `Om${randomBytes(8).toString("hex")}!`;

  const service = createServiceClient();
  const { error: createError } = await service.auth.admin.createUser({
    email: cleanEmail,
    password: tempPassword,
    email_confirm: true,
  });

  if (createError) {
    const alreadyExists =
      createError.message.toLowerCase().includes("already") ||
      createError.code === "email_exists";
    return {
      success: false,
      message: alreadyExists
        ? "This email already has an account."
        : "Failed to create account. Try again.",
    };
  }

  // Mark the lead as contacted
  const supabase = await createClient();
  await supabase
    .from("leads")
    .update({ status: "contacted" })
    .eq("id", leadId);

  revalidatePath("/admin/leads");

  return {
    success: true,
    message: "Client account created. Share these credentials securely:",
    email: cleanEmail,
    tempPassword,
  };
}