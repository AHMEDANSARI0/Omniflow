import type { MetadataRoute } from "next";
import { getSiteSettings } from "../lib/settings";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const settings = await getSiteSettings();
  const base = settings.site_url.replace(/\/$/, "");
  return [
    {
      url: base + "/",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
