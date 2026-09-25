import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OmniFlow",
    short_name: "OmniFlow",
    description:
      "AI customer conversation automation - WhatsApp inbox, lead qualification and follow-ups.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#07111f",
    theme_color: "#07111f",
    categories: ["business", "productivity"],
    shortcuts: [
      { name: "Inbox", short_name: "Inbox", url: "/dashboard/conversations" },
      { name: "Broadcasts", short_name: "Broadcasts", url: "/dashboard/broadcasts" },
      { name: "COD confirmations", short_name: "COD", url: "/dashboard/cod" },
      { name: "Customers", short_name: "Customers", url: "/dashboard/customers" },
    ],
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png" },
      { src: "/icon", sizes: "192x192", type: "image/png" },
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon", sizes: "192x192", type: "image/png", purpose: "maskable" },
    ],
  };
}
