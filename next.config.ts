import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  compress: true,
  serverExternalPackages: [
    "@whiskeysockets/baileys",
    "qrcode",
    "pino",
    "jimp",
    "sharp",
    "pg",
  ],
  // Dev-only: lets hosted preview sandboxes load dev assets (no effect in production builds).
  allowedDevOrigins: ["*.e2b.app"],
  images: {
    formats: ["image/avif", "image/webp"],
  },
};

export default nextConfig;
