import { redirect } from "next/navigation";

/**
 * The AI Brain controls (autonomy + tone) now live on Configure AI
 * (/dashboard/bot) so the assistant has a single setup surface.
 */
export default function AiBrainPage() {
  redirect("/dashboard/bot");
}
