"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "../../../../lib/supabase/server";
import type { LeadStatus } from "./types";

export async function updateLeadStatus(
  id: string,
  status: LeadStatus
): Promise<{ success: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false };

  const { error } = await supabase.from("leads").update({ status }).eq("id", id);
  if (error) return { success: false };

  revalidatePath("/admin/leads");
  return { success: true };
}

export async function deleteLead(id: string): Promise<{ success: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false };

  const { error } = await supabase.from("leads").delete().eq("id", id);
  if (error) return { success: false };

  revalidatePath("/admin/leads");
  return { success: true };
}