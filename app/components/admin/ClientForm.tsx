import { motion } from "motion/react";

interface ClientFormProps {
  client?: {
    client_id: string;
    name: string;
    platform: string;
    status: string;
  } | null;
  onSave: (data: {
    client_id: string;
    name: string;
    platform: string;
    status: string;
  }) => void;
  onCancel: () => void;
  isLoading?: boolean;
}

const PLATFORMS = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "whatsapp-business", label: "WhatsApp Business" },
  { value: "telegram", label: "Telegram" },
  { value: "instagram", label: "Instagram" },
];

export default function ClientForm({ client, onSave, onCancel, isLoading }: ClientFormProps) {
  const isEditing = !!client;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-line bg-white shadow-card p-6"
    >
      <h3 className="text-base font-medium text-ink mb-4">
        {isEditing ? "Edit Client" : "Add New Client"}
      </h3>

      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-ink-3 mb-1.5">
            Client ID *
          </label>
          <input
            type="text"
            value={client?.client_id || ""}
            onChange={(e) => {
              const value = e.target.value.trim();
              const id = value || `client-${Date.now()}`;
              onSave({
                client_id: id,
                name: value || "",
                platform: "whatsapp",
                status: "active",
              });
            }}
            placeholder="e.g., client-001"
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand outline-none"
            disabled={isEditing}
          />
          {isEditing && (
            <p className="mt-1 text-[11px] text-ink-3">
              Client ID cannot be changed after creation
            </p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-ink-3 mb-1.5">
            Name *
          </label>
          <input
            type="text"
            value={client?.name || ""}
            onChange={(e) => {}}
            placeholder="e.g., Production WhatsApp"
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand outline-none"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-ink-3 mb-1.5">
            Platform
          </label>
          <select
            value={client?.platform || "whatsapp"}
            onChange={(e) => {}}
            className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:border-brand outline-none appearance-none"
          >
            {PLATFORMS.map((p) => (
              <option key={p.value} value={p.value} className="bg-white">
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-ink-3 mb-1.5">
            Status
          </label>
          <div className="flex gap-3">
            {["active", "inactive"].map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => {
                  const statusStr = status === "active" ? "active" : "inactive";
                  onSave({
                    client_id: client?.client_id || `client-${Date.now()}`,
                    name: client?.name || "",
                    platform: client?.platform || "whatsapp",
                    status: statusStr,
                  });
                }}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${client?.status === status ? "border-brand bg-brand/10 text-brand" : "border-line bg-white text-ink hover:border-line-2"}`}
              >
                {status === "active" ? "Active" : "Inactive"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-line bg-white px-4 py-2 text-sm text-ink hover:bg-soft transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            onSave({
              client_id: client?.client_id || `client-${Date.now()}`,
              name: client?.name || "",
              platform: client?.platform || "whatsapp",
              status: client?.status || "active",
            });
          }}
          disabled={isLoading}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? "Saving..." : isEditing ? "Update" : "Create"}
        </button>
      </div>
    </motion.div>
  );
}
