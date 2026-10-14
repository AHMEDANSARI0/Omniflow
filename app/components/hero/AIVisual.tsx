import Image from "next/image";
import type { ReactNode } from "react";
import type { AIVisualAsset } from "../../../lib/marketing/site";

/**
 * Reserved slot for an AI visual (future 3D bot). The box keeps its
 * aspect ratio whatever is inside, so swapping the placeholder for a
 * real asset never shifts the layout.
 *
 * - asset = null      -> `fallback` (lightweight CSS placeholder)
 * - asset.kind image  -> optimized next/image (PNG/WebP/AVIF/SVG)
 * - asset.kind video  -> muted inline loop
 * The slot holds the visual only (§247: the hero bot draws its own nodes).
 */
export default function AIVisual({
  asset,
  fallback,
  priority = false,
  className = "",
}: {
  asset: AIVisualAsset | null;
  fallback: ReactNode;
  priority?: boolean;
  className?: string;
}) {
  let core: ReactNode = fallback;
  if (asset?.kind === "image") {
    core = (
      <Image
        src={asset.src}
        alt={asset.alt}
        width={asset.width}
        height={asset.height}
        priority={priority}
        sizes="(min-width: 1024px) 540px, 90vw"
        className="h-full w-full object-contain"
      />
    );
  } else if (asset?.kind === "video") {
    core = (
      <video
        className="h-full w-full object-contain"
        src={asset.src}
        poster={asset.poster}
        aria-label={asset.label}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
      />
    );
  }

  return (
    <div className={`relative mx-auto aspect-square w-full ${className}`}>
      <div className="absolute inset-[14%] flex items-center justify-center">{core}</div>
    </div>
  );
}
