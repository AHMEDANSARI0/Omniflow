import React from "react";

interface ResponseDelayProps {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export default function ResponseDelayInput({ value, onChange, disabled = false }: ResponseDelayProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value);
    if (!isNaN(val) && val >= 0 && val <= 3600) {
      onChange(val);
    }
  };

  const handleBlur = () => {
    onChange(0);
  };

  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  const displayValue = value >= 60
    ? minutes + " min" + (seconds > 0 ? " " + seconds + "s" : "")
    : value + " sec";

  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", marginBottom: 6, fontWeight: 600, fontSize: 14, color: "#1a1a1a" }}>
        WhatsApp Response Delay
        <span style={{ fontWeight: 400, color: "#666", marginLeft: 8, fontSize: 12 }}>
          (seconds per client)
        </span>
      </label>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="number"
          min={0}
          max={3600}
          value={value}
          onChange={handleChange}
          onBlur={handleBlur}
          disabled={disabled}
          placeholder="0"
          style={{
            width: 120,
            padding: "8px 12px",
            border: "1px solid #d1d5db",
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 500,
            backgroundColor: disabled ? "#f3f4f6" : "#fff",
          }}
        />

        <span style={{ fontSize: 13, color: "#666" }}>
          = {displayValue}
        </span>
      </div>

      <div style={{ marginTop: 6 }}>
        <input
          type="range"
          min={0}
          max={3600}
          value={value}
          onChange={(e) => {
            const val = parseInt(e.target.value);
            if (!isNaN(val)) onChange(val);
          }}
          disabled={disabled}
          style={{ width: "100%", cursor: disabled ? "not-allowed" : "pointer" }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 11, color: "#999" }}>
          <span>Instant</span>
          <span>30 min max</span>
        </div>
      </div>

      {value > 0 && (
        <div style={{ marginTop: 8, padding: "8px 12px", backgroundColor: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 6, fontSize: 12, color: "#92400e" }}>
          <strong style={{ display: "block", marginBottom: 2 }}>What happens:</strong>
          Bot will wait {displayValue} before replying to WhatsApp messages.
        </div>
      )}
    </div>
  );
}