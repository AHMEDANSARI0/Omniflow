import type { FooterContent } from "../../lib/content-defaults";
import { FOOTER_COLUMNS, FOOTER_TAGLINE } from "../../lib/marketing/navigation";
import Container from "./ui/Container";
import Logo from "./ui/Logo";

type IconProps = { className?: string };

function LinkedinIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M6.94 5.5a1.94 1.94 0 1 1-3.88 0 1.94 1.94 0 0 1 3.88 0ZM3.4 8.7h3.2V20H3.4V8.7Zm5.6 0h3.06v1.54h.05c.43-.8 1.47-1.66 3.03-1.66 3.24 0 3.84 2.13 3.84 4.9V20h-3.2v-5.5c0-1.31-.02-3-1.83-3-1.83 0-2.11 1.43-2.11 2.9V20H9V8.7Z" />
    </svg>
  );
}

function XIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M17.53 3h3.02l-6.6 7.55L21.7 21h-6.08l-4.77-6.23L5.4 21H2.37l7.06-8.07L2.3 3h6.23l4.31 5.7L17.53 3Zm-1.06 16.2h1.67L7.02 4.7H5.22l11.25 14.5Z" />
    </svg>
  );
}

function InstagramIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden className={className}>
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4.6" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.3" cy="6.7" r="1.05" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Site footer (§216). Brand, description and status pill are CMS-driven
 * (site_content.footer); link columns come from lib/marketing/navigation.
 */
export default function Footer({ content }: { content: FooterContent }) {
  const socials = [
    { label: "LinkedIn", href: content.linkedin_url || "#", Icon: LinkedinIcon },
    { label: "X (Twitter)", href: content.x_url || "#", Icon: XIcon },
    { label: "Instagram", href: content.instagram_url || "#", Icon: InstagramIcon },
  ].filter((item) => item.href && item.href !== "#");

  return (
    <footer className="border-t border-line bg-white">
      <Container wide className="py-14 lg:py-16">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_3fr] lg:gap-12">
          <div>
            <Logo />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-2">{content.description}</p>
            {content.status_label ? (
              <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-line bg-soft px-3 py-1.5 text-xs font-medium text-ink-2">
                <span aria-hidden className="of-pulse inline-block h-1.5 w-1.5 rounded-full bg-success" />
                {content.status_label}
              </p>
            ) : null}
            {socials.length > 0 ? (
              <div className="mt-5 flex items-center gap-2">
                {socials.map(({ label, href, Icon }) => (
                  <a
                    key={label}
                    href={href}
                    aria-label={label}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-line text-ink-2 transition-colors hover:border-brand/40 hover:text-brand"
                  >
                    <Icon className="h-4 w-4" />
                  </a>
                ))}
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 xl:grid-cols-6">
            {FOOTER_COLUMNS.map((column) => (
              <nav key={column.title} aria-label={column.title}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-3">{column.title}</p>
                <ul className="mt-4 space-y-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a href={link.href} className="rounded text-sm text-ink-2 transition-colors hover:text-brand">
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-line pt-6 sm:flex-row sm:items-center">
          <p className="text-xs text-ink-3">© {new Date().getFullYear()} OmniFlow. All rights reserved.</p>
          <p className="text-xs text-ink-3">{FOOTER_TAGLINE}</p>
        </div>
      </Container>
    </footer>
  );
}
