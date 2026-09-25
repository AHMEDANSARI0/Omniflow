import type { MetadataRoute } from "next";
import { getSiteSettings } from "../lib/settings";
import { listPosts } from "../lib/blog";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const settings = await getSiteSettings();
  const base = settings.site_url.replace(/\/$/, "");
  const routes = [
    "",
    "/about",
    "/features",
    "/use-cases",
    "/integrations",
    "/pricing",
    "/security",
    "/contact",
    "/faq",
    "/blog",
    "/privacy",
    "/terms",
  ].map((path) => ({
    url: base + path,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: path === "" ? 1 : 0.7,
  }));

  let posts: MetadataRoute.Sitemap = [];
  try {
    const items = await listPosts();
    posts = items
      .filter((post) => post.published_at)
      .map((post) => ({
        url: base + "/blog/" + post.slug,
        lastModified: new Date(post.published_at as string),
        changeFrequency: "monthly" as const,
        priority: 0.6,
      }));
  } catch {
    posts = [];
  }

  return [...routes, ...posts];
}
