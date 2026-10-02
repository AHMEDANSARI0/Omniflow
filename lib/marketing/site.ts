/**
 * Marketing-site constants (§216 redesign). One place for behaviour
 * knobs, shared routes and the AI-visual asset slots, so components
 * never repeat magic values.
 */

/** Scroll distance (px) after which the navbar compacts. */
export const NAVBAR_SCROLL_THRESHOLD = 40;

/** Routes every CTA points at. Change here, not in components. */
export const SITE_ROUTES = {
  start: "/dashboard/login",
  login: "/dashboard/login",
  howItWorks: "/#how-it-works",
  templates: "/#templates",
  integrations: "/integrations",
  contact: "/contact",
  pricing: "/pricing",
} as const;

/**
 * An AI visual that can be dropped into a reserved slot (hero, final
 * CTA). `null` renders the lightweight built-in placeholder.
 *
 * - image: transparent PNG / WebP / AVIF / SVG (served from /public or a
 *   remote host allowed in next.config)
 * - video: a short muted loop (WebM/MP4) for lightweight animated renders
 *
 * Lottie / WebGL bots: add the player when the asset exists and render
 * it through `<AIVisual>` children — nothing heavy ships before then.
 */
export type AIVisualAsset =
  | {
      kind: "image";
      src: string;
      alt: string;
      width: number;
      height: number;
    }
  | {
      kind: "video";
      src: string;
      poster?: string;
      label: string;
    };

/** Future 3D AI bot for the hero. Set this one value to swap it in. */
export const heroVisualAsset: AIVisualAsset | null = null;

/** Optional visual for the final call to action. */
export const finalCtaVisualAsset: AIVisualAsset | null = null;
