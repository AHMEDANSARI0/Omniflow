import type { CSSProperties, ReactNode } from "react";
import s from "./OmniFlowBot.module.css";

/**
 * BotVisual (§250): the OmniFlow robot itself - a pre-rendered 3D robot
 * (glossy white shell, black visor and joints) split into WebP layers that
 * share one canvas (public/bot/, ~99 KB together; made by
 * tools/bot-render/key.py + split.py): body, head, and per arm an upper
 * arm, a forearm and a hand, so shoulders, elbows and wrists bend like a
 * person's. Each hand also has an open version (palm to the viewer, from a
 * second render) that fades in for the front wave and the gestures toward
 * the viewer. Kept in its own file so the robot
 * can be swapped without touching the container, the motion island or
 * the hero.
 * - layers sit at their own depth and shift with the cursor (parallax),
 *   so the model reads as 3D while the render stays pixel-sharp; the head
 *   pivots at the neck, each arm is a shoulder > elbow > wrist chain, and
 *   the whole robot leans (cursor + intro body language) from its feet
 * - each layer carries a light film masked to its own shape: a soft
 *   highlight + shade that slides with the cursor (transform only), so
 *   the cursor acts as a moving light source on white and black parts
 * - everything that glows is live and uses theme tokens: LED ring eyes,
 *   smile, ear lights and the "OmniFlow" chest meter in the real chest
 *   panel of the render
 * Server component; positions below are % of the shared canvas.
 */
export default function BotVisual({ display }: { display: string }) {
  return (
    <div className={s.figure}>
      <Platform />
      <div className={s.follow}>
        <div className={s.lean}>
          <Depth z={0}>
            <div className={`${s.part} ${s.breathe}`}>
              <Layer src={LAYERS.body} />
              <Overlay>
                <ChestMeter display={display} />
              </Overlay>
            </div>
          </Depth>
          <Depth z={0.8}>
            <Arm {...ARMS.left} />
          </Depth>
          <Depth z={0.8}>
            <div className={s.tap}>
              <Arm {...ARMS.right} />
            </div>
          </Depth>
          <div className={s.head}>
            <div className={s.nod}>
              <Depth z={1.4}>
                <Layer src={LAYERS.head} />
              </Depth>
              <Depth z={1.6}>
                <Overlay>
                  <Face />
                </Overlay>
              </Depth>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Layer files (one canvas, 560x846) - swap the robot here. */
const LAYERS = {
  body: "/bot/omniflow-bot-body.webp",
  head: "/bot/omniflow-bot-head.webp",
};
/** Open palms: own small box (left, top, width, height in % of the canvas; the open thumbs reach past it). */
const ARMS = {
  left: {
    joints: [s.armL, s.foreL, s.handL],
    layers: ["/bot/omniflow-bot-upper-l.webp", "/bot/omniflow-bot-fore-l.webp", "/bot/omniflow-bot-hand-l.webp"],
    palm: { src: "/bot/omniflow-bot-palm-l.webp", size: { width: 157, height: 176 }, box: [-10.16, 61.64, 27.95, 20.86], grip: s.gripL, open: s.palmL },
  },
  right: {
    joints: [s.armR, s.foreR, s.handR],
    layers: ["/bot/omniflow-bot-upper-r.webp", "/bot/omniflow-bot-fore-r.webp", "/bot/omniflow-bot-hand-r.webp"],
    palm: { src: "/bot/omniflow-bot-palm-r.webp", size: { width: 157, height: 175 }, box: [82.42, 61.71, 27.95, 20.73], grip: s.gripR, open: s.palmR },
  },
};
const SIZE = { width: 560, height: 846 };
type Size = typeof SIZE;
type Palm = (typeof ARMS)["left"]["palm"];

/** A render layer + its cursor light, masked to the layer's own shape. */
function Layer({ src, size = SIZE }: { src: string; size?: Size }) {
  const mask = `url(${src})`;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- pre-sized layer; the mask must reuse this exact URL */}
      <img src={src} alt="" width={size.width} height={size.height} decoding="async" draggable={false} className={s.img} />
      <span className={s.light} style={{ maskImage: mask, WebkitMaskImage: mask } as CSSProperties}>
        <span className={s.lightSpot} />
      </span>
    </>
  );
}

/** An arm as a joint chain: shoulder > elbow > wrist, each segment nested in its parent. */
function Arm({ joints, layers, palm }: { joints: string[]; layers: string[]; palm: Palm }) {
  return joints.reduceRight<ReactNode>(
    (inner, joint, i) => (
      <div className={`${s.part} ${joint}`}>
        {inner ? <Layer src={layers[i]} /> : <Hand src={layers[i]} palm={palm} />}
        {inner}
      </div>
    ),
    null,
  );
}

/** The relaxed hand and the open palm on one wrist; the intro crossfades them. */
function Hand({ src, palm }: { src: string; palm: Palm }) {
  const [left, top, width, height] = palm.box;
  return (
    <>
      <div className={`${s.part} ${palm.grip}`}>
        <Layer src={src} />
      </div>
      <div className={`${s.palm} ${palm.open}`} style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}>
        <Layer src={palm.src} size={palm.size} />
      </div>
    </>
  );
}

/** One depth plane of the model: z scales its cursor parallax. */
function Depth({ z, children }: { z: number; children: ReactNode }) {
  return (
    <div className={s.depth} style={{ "--z": z } as CSSProperties}>
      {children}
    </div>
  );
}

/** Live SVG drawn in canvas units: 100 wide, 151 high (560x846). */
function Overlay({ children }: { children: ReactNode }) {
  return (
    <svg className={s.overlay} viewBox="0 0 100 151" aria-hidden focusable="false">
      {children}
    </svg>
  );
}

/** LED ring eyes, smile and ear lights on the black visor; eyes + smile turn together like a face. */
function Face() {
  return (
    <>
      {[22.7, 77.4].map((cx) => (
        <ellipse key={cx} cx={cx} cy="29.8" rx="1.3" ry="6.6" className={s.ear} />
      ))}
      <g className={s.faceTurn}>
        <g className={s.glance}>
          <g className={s.blink}>
            <g className={s.look}>
              {[40.4, 60].map((cx) => (
                <g key={cx}>
                  <circle cx={cx} cy="28.4" r="4.4" className={s.eyeGlow} />
                  <circle cx={cx} cy="28.4" r="4.4" className={s.eyeRing} />
                  <circle cx={cx} cy="28.4" r="4.4" className={s.eyeDots} />
                </g>
              ))}
            </g>
          </g>
          <g className={s.smile}>
            <path d={SMILE} className={s.smileGlow} />
            <path d={SMILE} className={s.smileLine} />
          </g>
        </g>
      </g>
    </>
  );
}

const SMILE = "M45.6 36.6 Q50.2 39.8 54.8 36.6";

/** "OmniFlow" digital meter inside the render's chest panel. */
function ChestMeter({ display }: { display: string }) {
  // the meter is a fixed panel: long or wide text is squeezed to fit it
  const fit = { textLength: Math.min(15.4, display.length * 2.1), lengthAdjust: "spacingAndGlyphs" as const };
  return (
    <g className={s.display}>
      <text x="49.9" y="68.2" textAnchor="middle" className={s.displayGlow} {...fit}>
        {display}
      </text>
      <text x="49.9" y="68.2" textAnchor="middle" className={s.displayText} {...fit}>
        {display}
      </text>
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={i} x={44.6 + i * 2.3} y="70.6" width="1.5" height="1.1" rx="0.3" className={s.bar} />
      ))}
      <rect x="40.4" y="59" width="19" height="13.8" rx="2.4" className={s.scanlines} />
    </g>
  );
}

/** The light surface the robot stands on (no image, theme tokens). */
function Platform() {
  const stop = (offset: number, token: string, opacity = 1) => (
    <stop offset={offset} style={{ stopColor: `var(--${token})`, stopOpacity: opacity }} />
  );
  return (
    <>
      <svg className={s.platform} viewBox="0 0 200 48" aria-hidden focusable="false">
        <defs>
          <radialGradient id="ofbot-halo" cx="0.5" cy="0.5" r="0.5">
            {stop(0, "bot-accent", 0.22)}
            {stop(1, "bot-accent", 0)}
          </radialGradient>
          <linearGradient id="ofbot-disc" x1="0" y1="0" x2="0" y2="1">
            {stop(0, "bot-shell")}
            {stop(1, "bot-shade")}
          </linearGradient>
          <linearGradient id="ofbot-rim" x1="0" y1="0" x2="1" y2="0">
            {stop(0, "bot-edge")}
            {stop(0.5, "bot-shade")}
            {stop(1, "bot-edge")}
          </linearGradient>
          <radialGradient id="ofbot-floor-shadow" cx="0.5" cy="0.5" r="0.5">
            {stop(0, "bot-ink", 0.3)}
            {stop(1, "bot-ink", 0)}
          </radialGradient>
          <pattern id="ofbot-scanlines" width="1" height="0.7" patternUnits="userSpaceOnUse">
            <rect width="1" height="0.25" style={{ fill: "var(--bot-ink)", opacity: 0.35 }} />
          </pattern>
        </defs>
        <ellipse cx="100" cy="25" rx="98" ry="22" style={{ fill: "var(--bot-halo)" }} />
        <ellipse cx="100" cy="24" rx="82" ry="13" style={{ fill: "var(--bot-rim)" }} />
        <ellipse cx="100" cy="19" rx="82" ry="13" className={s.disc} />
        <ellipse cx="100" cy="19" rx="63" ry="9.5" className={s.discRing} />
        <ellipse cx="100" cy="17" rx="44" ry="6" style={{ fill: "var(--bot-floor-shadow)" }} />
      </svg>
      <svg className={`${s.platform} ${s.pulse}`} viewBox="0 0 200 48" aria-hidden focusable="false">
        <ellipse cx="100" cy="19" rx="63" ry="9.5" className={s.discRing} />
      </svg>
    </>
  );
}
