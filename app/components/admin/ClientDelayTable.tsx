import { motion } from "motion/react";

interface ClientDelay {
  client_id: string;
  responseDelaySeconds: number;
  name?: string;
}

interface ClientDelayTableProps {
  clients: ClientDelay[];
  onUpdate?: (clientId: string, delay: number) => void;
}

const CLIENT_NAMES: Record<string, string> = {
  "1": "Production Test WhatsApp",
  "4": "Isolation Test WhatsApp",
};

export default function ClientDelayTable({ clients, onUpdate }: ClientDelayTableProps) {
  const handleChange = (clientId, value) => {
    const delay = Math.max(0, Math.min(3600, parseInt(value) || 0));
    onUpdate?.(clientId, delay);
  };

  return (
    <div className="rounded-xl border border-line bg-white shadow-card overflow-hidden">
      <div className="px-4 py-3 border-b border-line bg-soft">
        <h3 className="text-sm font-medium text-ink">Client Response Delays</h3>
      </div>
      <div className="divide-y divide-line">
        {clients.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-ink-3">No clients configured yet</p>
          </div>
        ) : (
          clients.map((client) => (
            <motion.div
              key={client.client_id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              className="px-4 py-3"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {CLIENT_NAMES[client.client_id] || `Client #${client.client_id}`}
                  </p>
                  <p className="text-[11px] text-ink-3">
                    Client ID: {client.client_id}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <input
                      type="number"
                      min={0}
                      max={3600}
                      value={client.responseDelaySeconds}
                      onChange={(e) => handleChange(client.client_id, e.target.value)}
                      className="w-24 rounded-lg border border-line bg-white px-2 py-1 text-sm text-ink text-center focus:border-brand outline-none"
                      placeholder="0"
                    />
                    <span className="absolute -top-2 -right-1 text-[10px] text-ink-3">sec</span>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${client.responseDelaySeconds === 0 ? "bg-emerald-100 text-emerald-700" : client.responseDelaySeconds <= 60 ? "bg-blue-100 text-blue-700" : client.responseDelaySeconds <= 300 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"}`}
                  >
                    {client.responseDelaySeconds === 0
                      ? "Instant"
                      : client.responseDelaySeconds <= 60
                      ? "Fast"
                      : client.responseDelaySeconds <= 300
                      ? "Medium"
                      : "Slow"}
                  </span>
                </div>
              </div>
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}
