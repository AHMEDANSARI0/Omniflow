import type { Metadata } from "next";
import { Inter, Sora } from "next/font/google";
import "./globals.css";
import { getSiteSettings } from "../lib/settings";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const sora = Sora({
  variable: "--font-sora",
  subsets: ["latin"],
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const s = await getSiteSettings();

  let metadataBase: URL | undefined;
  try {
    metadataBase = new URL(s.site_url);
  } catch {
    metadataBase = undefined;
  }

  return {
    metadataBase,
    title: {
      default: s.meta_title,
      template: "%s — OmniFlow",
    },
    description: s.meta_description,
    keywords: s.keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
    openGraph: {
      type: "website",
      siteName: "OmniFlow",
      title: s.og_title,
      description: s.og_description,
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title: s.og_title,
      description: s.og_description,
    },
    robots: {
      index: true,
      follow: true,
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className={`${inter.variable} ${sora.variable}`}>
        {children}
      </body>
    </html>
  );
}