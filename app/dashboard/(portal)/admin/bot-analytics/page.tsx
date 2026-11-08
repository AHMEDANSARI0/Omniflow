import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import BotAnalyticsClient, { type AnalyticsData } from "./BotAnalyticsClient";

export default async function BotAnalyticsPage() {
  const session = (await cookies()).get("session");
  if (!session?.value) {
    redirect("/login");
  }

  const now = new Date().toISOString();
  const analytics: AnalyticsData = {
    total_clients: 2,
    total_messages: 150,
    avg_response_delay: 120,
    avg_response_time: 3.5,
    overall_satisfaction: 85.5,
    clients: [
      {
        client_id: "1",
        client_name: "Production Test WhatsApp",
        total_messages: 100,
        avg_response_delay: 100,
        avg_response_time: 3.2,
        satisfaction_score: 88,
        recent_messages: [
          {
            id: "msg-1",
            direction: "in",
            body: "Hello, I need help with my order",
            created_at: now,
          },
          {
            id: "msg-2",
            direction: "out",
            body: "Sure! Let me check your order status.",
            created_at: now,
          },
        ],
      },
      {
        client_id: "4",
        client_name: "Isolation Test WhatsApp",
        total_messages: 50,
        avg_response_delay: 150,
        avg_response_time: 4,
        satisfaction_score: 80,
        recent_messages: [
          {
            id: "msg-3",
            direction: "in",
            body: "Test message",
            created_at: now,
          },
        ],
      },
    ],
    recent_activity: [
      {
        client_id: "1",
        client_name: "Production Test WhatsApp",
        direction: "in",
        body: "Hello, I need help with my order",
        created_at: now,
      },
      {
        client_id: "4",
        client_name: "Isolation Test WhatsApp",
        direction: "out",
        body: "Test response",
        created_at: now,
      },
    ],
    updated_at: now,
  };

  return <BotAnalyticsClient analytics={analytics} isLoading={false} />;
}
