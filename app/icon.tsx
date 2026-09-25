import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
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
          borderRadius: 110,
          color: "#38bdf8",
          fontSize: 210,
          fontWeight: 700,
          letterSpacing: -8,
        }}
      >
        OF
      </div>
    ),
    size
  );
}
