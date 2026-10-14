import type { CSSProperties } from "react";
import BotMotion from "./BotMotion";
import BotVisual from "./BotVisual";
import type { BotChannel } from "./botChannels";
import s from "./OmniFlowBot.module.css";

export type OmniFlowBotCopy = {
  greeting: string;
  intro: string;
  channels: string;
  soon: string;
  connected: string;
  soonLabel: string;
  display: string;
};

/**
 * OmniFlowBot (§247-§249, 3D render in §250): the hero robot experience.
 * This container owns the speech bubble and the channel nodes; the robot
 * itself is BotVisual (layered 3D render), the only client code is BotMotion (cursor
 * tracking + cursor light, offscreen pause, tap reaction). The intro
 * (greeting, intro line, both channel arcs, closing line, gestures) is a
 * CSS timeline that runs without
 * JavaScript; motion is transform/opacity only. Server component, no
 * dependencies, theme tokens only (see the module).
 */
export default function OmniFlowBot({
  label,
  copy,
  primary = [],
  secondary = [],
  more = 0,
  intro = true,
  interactive = true,
  socialBubbles = true,
  cursorTracking = true,
  animated = true,
}: {
  /** Accessible name of the whole visual. */
  label: string;
  copy: OmniFlowBotCopy;
  /** Offered channels, right arc. */
  primary?: BotChannel[];
  /** Upcoming or extra channels, left arc (Soon badge while "soon"). */
  secondary?: BotChannel[];
  /** Count of other offered channels, shown as a "+N" node. */
  more?: number;
  /** false = skip the intro performance, start in the resting pose. */
  intro?: boolean;
  /** false = no touch reaction. */
  interactive?: boolean;
  socialBubbles?: boolean;
  cursorTracking?: boolean;
  /** false = the calm final pose only (same as reduced motion). */
  animated?: boolean;
}) {
  const right = socialBubbles ? primary.slice(0, RIGHT_SPOTS.length) : [];
  const left = socialBubbles ? secondary.slice(0, LEFT_SPOTS.length) : [];
  const extra = socialBubbles && more > 0 ? more : 0;
  const nodes: Node[] = [
    ...right.map((channel, i) => ({ channel, spot: RIGHT_SPOTS[i], delay: RIGHT_AT + i * STEP })),
    ...(extra ? [{ spot: MORE_SPOT, delay: RIGHT_AT + right.length * STEP }] : []),
    ...left.map((channel, i) => ({ channel, spot: LEFT_SPOTS[i], delay: LEFT_AT + i * STEP })),
  ];
  const spoken = [copy.greeting, copy.intro, copy.channels, left.length ? copy.soon : "", copy.connected].filter(Boolean);
  return (
    <BotMotion
      className={s.root}
      track={cursorTracking && animated}
      tap={interactive && animated}
      waveClass={s.waving}
      data-static={animated ? undefined : ""}
      data-nointro={intro ? undefined : ""}
      role="img"
      aria-label={[label, ...spoken].map(sentence).join(" ")}
    >
      {nodes.length ? (
        <svg className={s.links} viewBox="0 0 100 100" preserveAspectRatio="none">
          {nodes.map((node, i) => (
            <line
              key={i}
              x1="50"
              y1="50"
              x2={node.spot[0]}
              y2={node.spot[1]}
              className={node.channel?.soon ? s.soonLink : undefined}
              style={timing(node.delay - 0.1)}
            />
          ))}
        </svg>
      ) : null}

      <div className={s.speech}>
        <p className={`${s.line} ${s.line1}`}>{copy.greeting}</p>
        <p className={`${s.line} ${s.line2}`}>{copy.intro}</p>
        <p className={`${s.line} ${s.line3}`}>{copy.channels}</p>
        {left.length ? <p className={`${s.line} ${s.line4}`}>{copy.soon}</p> : null}
        <p className={`${s.line} ${s.line5}`}>{copy.connected}</p>
      </div>

      <BotVisual display={copy.display} />

      {nodes.map((node, i) => (
        <span
          key={node.channel?.id ?? "more"}
          className={s.node}
          style={{ ...timing(node.delay), left: `${node.spot[0]}%`, top: `${node.spot[1]}%`, ...bob(i), color: node.channel?.accent }}
        >
          {node.channel ? (
            <span className={`${s.bubble} ${node.channel.soon ? s.soonBubble : ""}`}>
              <svg viewBox={node.channel.viewBox}>
                <path d={node.channel.path} fill="currentColor" />
              </svg>
            </span>
          ) : (
            <span className={`${s.bubble} ${s.more}`}>+{extra}</span>
          )}
          {node.channel?.soon ? <span className={s.badge}>{copy.soonLabel}</span> : null}
        </span>
      ))}
    </BotMotion>
  );
}

type Spot = readonly [x: number, y: number];
type Node = { channel?: BotChannel; spot: Spot; delay: number };

/** Node centres (% of the visual): offered channels right, the rest left. */
const RIGHT_SPOTS: readonly Spot[] = [
  [86, 30],
  [92, 47],
  [91, 64],
  [84, 80],
];
const MORE_SPOT: Spot = [93, 92];
const LEFT_SPOTS: readonly Spot[] = [
  [14, 30],
  [8, 47],
  [9, 64],
  [16, 80],
];
/** Intro seconds when each arc starts; the nodes ping again each 12s loop (matches the CSS timeline). */
const RIGHT_AT = 5;
const LEFT_AT = 7;
const STEP = 0.3;

/** Ends a phrase with punctuation so the accessible name reads as sentences. */
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

const timing = (seconds: number) => ({ "--d": `${seconds.toFixed(2)}s` }) as CSSProperties;
const bob = (index: number) => ({ "--bob": `${(index * -1.1).toFixed(1)}s` }) as CSSProperties;
