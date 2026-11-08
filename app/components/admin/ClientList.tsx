import { motion, AnimatePresence } from "motion/react";
import React, { useState } from "react";

interface ClientItem {
  id: string;
  client_id: string;
  name: string;
  platform: string;
  status: string;
}

interface ClientListProps {
  clients: ClientItem[];
  onEdit: (client: ClientItem) => void;
  onDelete: (clientId: string) => void;
  isLoading?: boolean;
}

const PLATFORM_COLORS: Record<string, string> = {
  whatsapp: "bg-green-500",
  "whatsapp-business": "bg-green-600",
  telegram: "bg-blue-500",
  instagram: "bg-pink-500",
};

export default function ClientList({ clients, onEdit, onDelete, isLoading }: ClientListProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingClient, setEditingClient] = useState<ClientItem | null>(null);

  const handleDelete = (clientId: string) => {
    if (confirm("Delete client #" + clientId + "? This cannot be undone.")) {
      setDeletingId(clientId);
      onDelete(clientId);
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-ink">Clients ({clients.length})</h3>
          <span className="text-[11px] text-ink-3">Manage your connected accounts</span>
        </div>
        <button
          onClick={() => {
            setEditingClient(null);
            setShowForm(true);
          }}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        >
          + Add Client
        </button>
      </div>

      {/* Client List */}
      <div className="rounded-xl border border-line bg-white shadow-card divide-y divide-line">
        <AnimatePresence mode="popLayout">
          {clients.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="px-4 py-8 text-center"
            >
              <p className="text-sm text-ink-3">No clients added yet</p>
              <button
                onClick={() => setShowForm(true)}
                className="mt-2 text-sm text-brand hover:underline"
              >
                Add your first client
              </button>
            </motion.div>
          ) : (
            clients.map((client) => (
              <motion.div
                key={client.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="px-4 py-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Platform Icon */}
                    <div className={`w-8 h-8 rounded-full ${PLATFORM_COLORS[client.platform] || "bg-gray-500"} flex items-center justify-center text-white text-xs font-medium`}>
                      {client.platform === "whatsapp" && "WA"}
                      {client.platform === "whatsapp-business" && "WB"}
                      {client.platform === "telegram" && "TG"}
                      {client.platform === "instagram" && "IG"}
                    </div>

                    {/* Client Info */}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink truncate">{client.name}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-ink-3">ID: {client.client_id}</span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-soft text-ink-3">
                          {client.platform}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${client.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}
                    >
                      {client.status}
                    </span>
                    <button
                      onClick={() => setEditingClient(client)}
                      className="p-1.5 rounded-lg border border-line text-ink-3 hover:bg-soft hover:border-brand transition-colors"
                      title="Edit"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    {deletingId === client.id ? (
                      <span className="text-xs text-red-500 animate-pulse">Deleting...</span>
                    ) : (
                      <button
                        onClick={() => handleDelete(client.client_id)}
                        className="p-1.5 rounded-lg border border-line text-ink-3 hover:bg-red-50 hover:border-red-300 hover:text-red-600 transition-colors"
                        title="Delete"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>
            ))
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
