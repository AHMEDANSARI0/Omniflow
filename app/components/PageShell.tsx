import type { ReactNode } from "react";

import Navbar from "./Navbar";
import Footer from "./Footer";
import { getSectionContent } from "../../lib/content";
import {
  FOOTER_DEFAULTS,
  type FooterContent,
} from "../../lib/content-defaults";

/**
 * Shared shell for every marketing page: navbar, main, footer. Inner
 * pages stay consistent by construction — they only supply content.
 */
export default async function PageShell({
  children,
  footer,
}: {
  children: ReactNode;
  footer?: FooterContent;
}) {
  const footerContent = footer ?? (await getSectionContent("footer", FOOTER_DEFAULTS));
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:text-brand focus:shadow-card"
      >
        Skip to content
      </a>
      <Navbar />
      <main id="main">{children}</main>
      <Footer content={footerContent} />
    </>
  );
}
