import { SITE_ROUTES } from "./site";

export type NavItem = { label: string; href: string };

/** Primary navigation — keep it short; the navbar renders this list. */
export const NAV_ITEMS: NavItem[] = [
  { label: "Platform", href: "/features" },
  { label: "Solutions", href: "/use-cases" },
  { label: "Integrations", href: "/integrations" },
  { label: "How it works", href: SITE_ROUTES.howItWorks },
  { label: "Pricing", href: "/pricing" },
  { label: "Resources", href: "/blog" },
];

export const NAV_ACTIONS = {
  login: { label: "Log in", href: SITE_ROUTES.login },
  primary: { label: "Start Building", href: SITE_ROUTES.start },
  howItWorks: { label: "See How It Works", href: SITE_ROUTES.howItWorks },
} as const;

export type FooterColumn = { title: string; links: NavItem[] };

/** Footer link groups. Only real routes and real anchors. */
export const FOOTER_COLUMNS: FooterColumn[] = [
  {
    title: "Product",
    links: [
      { label: "Platform", href: "/features" },
      { label: "How it works", href: SITE_ROUTES.howItWorks },
      { label: "Automation templates", href: SITE_ROUTES.templates },
      { label: "Pricing", href: "/pricing" },
    ],
  },
  {
    title: "Solutions",
    links: [
      { label: "E-commerce", href: "/use-cases#use-case-1" },
      { label: "Service businesses", href: "/use-cases#use-case-2" },
      { label: "Real estate", href: "/use-cases#use-case-3" },
      { label: "Support teams", href: "/use-cases#use-case-5" },
    ],
  },
  {
    title: "Integrations",
    links: [
      { label: "WhatsApp", href: "/integrations#whatsapp" },
      { label: "Instagram", href: "/integrations#instagram" },
      { label: "Telegram", href: "/integrations#telegram" },
      { label: "All integrations", href: "/integrations" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Blog", href: "/blog" },
      { label: "FAQ", href: "/faq" },
      { label: "Security", href: "/security" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
      { label: "Log in", href: SITE_ROUTES.login },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

/** Line under the footer columns. */
export const FOOTER_TAGLINE =
  "The intelligent automation layer between a business and its customers.";
