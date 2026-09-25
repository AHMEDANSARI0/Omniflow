export type LeadStatus = "new" | "contacted" | "closed";

export interface Lead {
  id: string;
  name: string;
  email: string;
  company: string | null;
  status: LeadStatus;
  created_at: string;
}