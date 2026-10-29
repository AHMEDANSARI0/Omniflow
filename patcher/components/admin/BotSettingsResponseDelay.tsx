/**
 * BotSettingsResponseDelay — WhatsApp Response Delay Input Component
 * Import this into your admin bot settings page.
 *
 * Usage:
 *   import BotSettingsResponseDelay from "@/components/admin/BotSettingsResponseDelay";
 *
 *   // In your settings form:
 *   <BotSettingsResponseDelay
 *     value={botSettings?.responseDelaySeconds ?? 0}
 *     onChange={(val) => setBotSettings({ ...botSettings, responseDelaySeconds: val })}
 *   />
 */

import React from "react";

interface Props {
  value: number;
  onChange: (value: number) => void;
}

export default function BotSettingsResponseDelay({ value, onChange }: Props) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", marginBottom: 4, fontWeight: 500, fontSize: 14 }}>
        WhatsApp Response Delay (seconds per client)
      </label>
      <input
        type="number"
        min={0}
        max={3600}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value) || 0)}
        placeholder="0 for instant, 120 for 2 min delay"
        style={{
          width: "100%",
          padding: 8,
          border: "1px solid",
          borderColor: "#ccc",
          borderRadius: 4,
          fontSize: 14,
        }}
      />
      <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
        Set 0 for instant reply, or up to 3600 seconds (1 hour) max.
        This delay applies before the bot sends a WhatsApp message reply.
      </div>
    </div>
  );
}
