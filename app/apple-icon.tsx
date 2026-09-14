import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#07111f",
          color: "#38bdf8",
          fontSize: 78,
          fontWeight: 700,
          letterSpacing: -3,
        }}
      >
        OF
      </div>
    ),
    size
  );
}
