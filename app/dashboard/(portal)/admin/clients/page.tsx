import { GetServerSideProps } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { motion } from "motion/react";
import React, { useState } from "react";
import ClientList from "@/components/admin/ClientList";
import ClientForm from "@/components/admin/ClientForm";

interface ClientRecord {
  id: string;
  client_id: string;
  name: string;
  platform: string;
  status: string;
}

interface PageProps {
  clients: ClientRecord[];
  isLoading: boolean;
}

export default function ClientsPage({ clients, isLoading }: PageProps) {
  const [localClients, setLocalClients] = useState(clients);
  const [showForm, setShowForm] = useState(false);
  const [editingClient, setEditingClient] = useState<ClientRecord | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async (data) => {
    setIsSaving(true);

    try {
      const response = await fetch("/api/v1/admin/clients", {
        method: editingClient ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (response.ok) {
        const result = await response.json();

        if (editingClient) {
          setLocalClients((prev) =>
            prev.map((c) => (c.id === editingClient.id ? result : c))
          );
        } else {
          setLocalClients((prev) => [...prev, result]);
        }

        setShowForm(false);
        setEditingClient(null);
      }
    } catch (error) {
      console.error("Failed to save client:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (clientId) => {
    try {
      const response = await fetch("/api/v1/admin/clients?client_id=" + clientId, {
        method: "DELETE",
      });

      if (response.ok) {
        setLocalClients((prev) => prev.filter((c) => c.client_id !== clientId));
      }
    } catch (error) {
      console.error("Failed to delete client:", error);
    }
  };

  const handleEdit = (client) => {
    setEditingClient(client);
    setShowForm(true);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-6"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink">Client Management</h1>
          <p className="text-sm text-ink-3">Manage WhatsApp accounts and connected platforms</p>
        </div>
      </div>

      {/* Client List */}
      <ClientList
        clients={localClients}
        onEdit={handleEdit}
        onDelete={handleDelete}
        isLoading={isLoading}
      />

      {/* Add/Edit Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-white rounded-2xl shadow-xl max-w-md w-full mx-4 overflow-hidden"
          >
            <div className="px-6 py-4 border-b border-line">
              <h2 className="text-base font-medium text-ink">
                {editingClient ? "Edit Client" : "Add New Client"}
              </h2>
              <button
                onClick={() => {
                  setShowForm(false);
                  setEditingClient(null);
                }}
                className="ml-auto text-ink-3 hover:text-ink"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="p-6">
              <ClientForm
                client={editingClient}
                onSave={handleSave}
                onCancel={() => {
                  setShowForm(false);
                  setEditingClient(null);
                }}
                isLoading={isSaving}
              />
            </div>
          </motion.div>
        </div>
      )}
    </motion.div>
  );
}

export const getServerSideProps: GetServerSideProps = async (context) => {
  const cookieStore = await cookies();
  const session = cookieStore.get("session");

  if (!session?.value) {
    return redirect("/login");
  }

  try {
    const response = await fetch("http://localhost:3000/api/v1/admin/clients", {
      headers: {
        Cookie: `session=${session.value}`,
      },
    });

    if (!response.ok) {
      return {
        props: {
          clients: [],
          isLoading: false,
        },
      };
    }

    const clients = await response.json() as ClientRecord[];
    return {
      props: {
        clients,
        isLoading: false,
      },
    };
  } catch (error) {
    console.error("Failed to fetch clients:", error);
    return {
      props: {
        clients: [],
        isLoading: false,
      },
    };
  }
};
