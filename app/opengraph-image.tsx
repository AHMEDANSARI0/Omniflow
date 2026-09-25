import { ImageResponse } from "next/og";

export const alt = "OmniFlow - AI Customer Conversation Automation";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          backgroundColor: "#07111f",
          color: "#ffffff",
        }}
      >
        <div style={{ display: "flex", fontSize: 32, color: "#38bdf8" }}>
          OmniFlow
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 64,
            fontWeight: 700,
            marginTop: 24,
            lineHeight: 1.15,
          }}
        >
          Every customer conversation, on autopilot
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 30,
            color: "#94a3b8",
            marginTop: 28,
          }}
        >
          WhatsApp inbox, lead qualification and follow-ups in one layer
        </div>
      </div>
    ),
    size
  );
}
