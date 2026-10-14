"""The OmniFlowBot intro timeline (12s loop) -> CSS keyframes (step 3).

Poses are written in seconds; this script turns them into the generated
keyframes block of app/components/OmniFlowBot/OmniFlowBot.module.css
(between the two "motion.py" marker comments), so the timeline stays
readable and in one place. Run after editing a pose:
    python3 tools/bot-render/motion.py

Arms: (seconds, shoulder, elbow, wrist, k). Angles in CSS degrees
(negative = the viewer's right arm out / up, positive = the left arm);
k < 1 foreshortens the forearm, i.e. the hand comes toward the viewer
(the wrist undoes the squash, so the hand keeps its shape). A pose that
lies on the way between its neighbours is passed through without stopping
(per-segment cubic-bezier from monotone slopes); turning points and holds
ease in and out. Hands rest and gesture relaxed, palms to the body, like a
person's; the open waving hand (palm to the viewer) unfolds from the wrist
over the relaxed one only for the wave, once the forearm is up.
"""
import os
import re

LOOP = 12.0
CSS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "app", "components", "OmniFlowBot", "OmniFlowBot.module.css")
REST = (0, 0, 0, 1)

# viewer's right arm: a natural hello wave, explaining hands, presents the
# channels to the viewer (a beat per bubble), welcome at the end
ARM_R = [
    (0.2, 3, 4, 0, 1),  # anticipation
    (0.42, -4, -30, -18, 0.62),  # the elbow leads, the wrist turns the hand up: it rises toward the viewer, not out to the side
    (0.66, -10, -80, -55, 0.42),
    (0.8, -24, -100, -25, 0.6),
    (0.94, -40, -115, -6, 0.85),
    (1.2, -60, -110, 6, 1),  # wave: forearm up, palm to the viewer, wrist wags
    (1.45, -58, -112, 12, 1),
    (1.7, -61, -104, -10, 1),
    (1.95, -59, -112, 12, 1),
    (2.2, -60, -105, -8, 1),
    (2.4, -58, -108, 4, 1),
    (2.62, -40, -115, -6, 0.85),  # lowers the way it came up (palm closes while the hand is still up), then explains
    (2.76, -24, -100, -25, 0.6),
    (2.9, -10, -80, -55, 0.42),
    (3.14, -4, -30, -18, 0.62),
    (3.45, -12, 20, -6, 0.85),  # explain: the hand comes toward the viewer on the beats
    (3.8, -14, 28, -10, 0.82),
    (4.15, -12, 18, -4, 0.85),
    (4.5, -15, 30, -10, 0.82),
    (4.85, -2, 4, 0, 1),
    (5.15, -30, 40, -10, 0.85),  # channels: presents them to the viewer, a beat per bubble
    (5.45, -33, 46, -12, 0.83),
    (5.75, -30, 40, -8, 0.85),
    (6.05, -33, 46, -12, 0.83),
    (6.35, -30, 40, -10, 0.85),
    (6.8, -2, 2, 0, 1),
    (6.95, *REST),
    (7.6, 2, -4, 0, 1),
    (8.6, *REST),
    (8.9, 2, -2, 0, 1),
    (9.3, -36, 44, -12, 0.84),  # connected: both arms open a little toward the viewer
    (9.6, -33, 40, -9, 0.86),
    (10.6, -35, 43, -11, 0.84),
    (11.3, -4, 4, 0, 1),
    (11.6, *REST),
]
# viewer's left arm: answers the wave, explains a beat later (asymmetric),
# presents the Soon channels, welcome at the end
ARM_L = [
    (1.0, 3, -5, 2, 1),
    (2.4, 2, -4, 0, 1),
    (2.75, *REST),
    (3.2, 12, -18, 6, 0.86),
    (3.7, 15, -28, 10, 0.82),
    (4.1, 12, -18, 5, 0.86),
    (4.5, 14, -26, 9, 0.83),
    (4.85, 2, -4, 0, 1),
    (5.6, -2, 4, 0, 1),
    (6.6, *REST),
    (6.85, -2, 2, 0, 1),
    (7.15, 30, -40, 10, 0.85),
    (7.45, 33, -46, 12, 0.83),
    (7.75, 30, -40, 8, 0.85),
    (8.05, 33, -46, 12, 0.83),
    (8.5, 2, -2, 0, 1),
    (8.75, *REST),
    (9.0, -2, 2, 0, 1),
    (9.4, 36, -44, 12, 0.84),
    (9.7, 33, -40, 9, 0.86),
    (10.7, 35, -43, 11, 0.84),
    (11.35, 4, -4, 0, 1),
    (11.65, *REST),
]
# the waving hand's open palm over the relaxed one: (opens at, closes at); each change takes FADE seconds,
# while the arm is moving - it opens once the forearm is nearly up and closes before it comes down
PALM = {"r": [(0.84, 2.84)]}
FADE = 0.1
# speech lines: (in from, in at, out from, out at)
SAY = [(0.05, 0.35, 2.4, 2.7), (2.7, 3.0, 4.6, 4.9), (4.9, 5.2, 6.6, 6.9), (6.9, 7.2, 8.6, 8.9), (8.9, 9.2, 11.65, 11.95)]
# head (neck pivot): (seconds, x %, y %, deg) - it talks to the viewer
HEAD = [
    (0.6, 0, 0, 0), (0.95, 0, -0.4, 5), (1.4, 0, 0, 3), (1.9, 0, 0, 5), (2.4, 0, 0, 2), (2.8, 0, 0, 0),
    (3.2, 0, 0.5, -1), (3.5, 0, -0.2, -1.5), (4.1, 0, 0.4, -2), (4.4, 0, 0, -1), (4.8, 0, 0, 0),
    (5.3, 0.4, 0, 2.5), (6.6, 0.3, 0, 2), (6.95, 0, 0, 0),
    (7.3, -0.4, 0, -2.5), (8.6, -0.3, 0, -2), (8.9, 0, 0, 0),
    (9.3, 0, 0.8, 0), (9.6, 0, -0.3, 0), (9.9, 0, 0, 0), (10.8, 0, 0, 1.5), (11.6, 0, 0, 0),
]
# eyes + smile (canvas units): a glance at each arc, then back to the viewer
GLANCE = [(0.9, 1.2, 0), (2.4, 1.2, 0), (2.8, 0, 0), (5.1, 2, 0.4), (5.6, 2, 0.4), (6.0, 0, 0),
          (7.1, -2, 0.4), (7.6, -2, 0.4), (8.0, 0, 0)]
# body (from the feet): (seconds, deg, y %)
LEAN = [(0.9, -0.8, 0), (2.4, -0.6, 0), (2.9, 0, 0), (3.4, 0, -0.3), (4.6, 0, 0), (5.4, 0.6, 0), (6.6, 0.5, 0),
        (7.0, 0, 0), (7.4, -0.6, 0), (8.6, -0.5, 0), (8.95, 0, 0), (9.5, 0, -0.5), (10.3, 0, 0)]
SMILE = [(0.4, 1, 1), (0.8, 1.18, 1.25), (2.2, 1.12, 1.15), (2.7, 1, 1), (8.9, 1, 1), (9.2, 1.18, 1.25), (10.6, 1.12, 1.15), (11.4, 1, 1)]


def pct(t):
    return "%g%%" % round(t / LOOP * 100, 2)


def num(v):
    return "%g" % (round(v, 3) + 0)


def slopes(ts, vs):
    """Monotone (Fritsch-Butland) slopes: 0 at turning points and holds, so nothing overshoots."""
    d = [(v1 - v0) / (t1 - t0) for t0, t1, v0, v1 in zip(ts, ts[1:], vs, vs[1:])]
    m = [0.0] * len(vs)
    for i in range(1, len(vs) - 1):
        if d[i - 1] * d[i] > 0:
            h0, h1 = ts[i] - ts[i - 1], ts[i + 1] - ts[i]
            w0, w1 = 2 * h1 + h0, h1 + 2 * h0
            m[i] = (w0 + w1) / (w0 / d[i - 1] + w1 / d[i])
    return d, m


def timings(ts, vs):
    """{segment start: cubic-bezier} for segments that pass through a pose (CSS eases each segment on its own)."""
    d, m = slopes(ts, vs)
    out = {}
    for i, di in enumerate(d):
        if di and (m[i] or m[i + 1]):
            a, b = m[i] / di, m[i + 1] / di
            out[ts[i]] = "cubic-bezier(0.333, %s, 0.667, %s)" % (num(a / 3), num(1 - b / 3))
    return out


def keyframes(name, frames, prop="transform", comment=None, timing=None):
    """frames: [(seconds, value)], 0 and 100% padded with the rest value; equal neighbours merge.
    prop=None: values are whole declarations. timing: {segment start: timing function}."""
    rest = "none" if prop == "transform" else "1"
    frames = sorted(frames)
    if not frames or frames[0][0] > 0:
        frames = [(0, rest)] + frames
    if frames[-1][0] < LOOP:
        frames = frames + [(LOOP, frames[-1][1])]
    groups = []
    for t, v in frames:
        if groups and groups[-1][1] == v:
            groups[-1][0].append(t)
        else:
            groups.append(([t], v))
    out = ["/* %s */\n" % comment] if comment else []
    out.append("@keyframes %s {\n" % name)
    for ts, v in groups:
        stops = sorted({ts[0], ts[-1]})
        decl = "    %s: %s;\n" % (prop, v) if prop else "".join("    %s;\n" % x for x in v.split("; "))
        if timing and ts[-1] in timing:
            decl += "    animation-timing-function: %s;\n" % timing[ts[-1]]
        out.append(",\n".join("  " + pct(t) for t in stops) + " {\n" + decl + "  }\n")
    return "".join(out) + "}\n"


def rot(d):
    return "rotate(%sdeg)" % num(d)


def arm(side, poses, comment):
    poses = [(0, *REST)] + poses + [(LOOP, *REST)]
    upper = [(t, rot(s) if s else "none") for t, s, f, h, k in poses]
    fore = [(t, "none" if (f, k) == (0, 1) else "%s scale(1, %s)" % (rot(f), num(k))) for t, s, f, h, k in poses]
    hand = [(t, "none" if (h, k) == (0, 1) else "scale(1, %s) %s" % (num(1 / k), rot(h))) for t, s, f, h, k in poses]
    ts = [p[0] for p in poses]
    elbow = timings(ts, [p[2] for p in poses])
    return (keyframes("bot-arm-" + side, upper, comment=comment, timing=timings(ts, [p[1] for p in poses])) + "\n"
            + keyframes("bot-fore-" + side, fore, timing=elbow) + "\n" + keyframes("bot-hand-" + side, hand, timing=elbow))


def palm(side):
    shut, open_ = "opacity: 0; transform: scale(0.85)", "opacity: 1; transform: none"
    opened, grip = [(0, shut)], [(0, "1")]
    for a, c in PALM[side]:
        opened += [(a, shut), (a + FADE, open_), (c, open_), (c + FADE, shut)]
        # the relaxed hand goes once the palm covers it, and is back before the palm has folded away
        grip += [(a + FADE / 2, "1"), (a + FADE, "0"), (c, "0"), (c + FADE / 2, "1")]
    return (keyframes("bot-palm-" + side, opened, None, "the waving hand's open palm unfolds from the wrist for the wave") + "\n"
            + keyframes("bot-grip-" + side, grip, "opacity"))


def say(i, a, b, c, d):
    t = "translateY(%dpx)"
    body = ["@keyframes bot-say-%d {\n" % i]
    body.append("  0%%,\n  %s {\n    opacity: 0;\n    transform: %s;\n  }\n" % (pct(a), t % 6) if a else "  0% {\n    opacity: 0;\n    transform: translateY(6px);\n  }\n")
    body.append("  %s,\n  %s {\n    opacity: 1;\n    transform: none;\n  }\n" % (pct(b), pct(c)))
    body.append("  %s,\n  100%% {\n    opacity: 0;\n    transform: %s;\n  }\n}\n" % (pct(d), t % -6))
    return "".join(body)


def build():
    parts = [say(i + 1, *s) for i, s in enumerate(SAY)]
    parts.append(arm("r", ARM_R, "viewer's right arm: front wave, open hands, presents the channels, welcome"))
    parts.append(arm("l", ARM_L, "viewer's left arm: answers the wave, explains a beat later, presents the Soon channels, welcome"))
    parts += [palm(side) for side in PALM]
    parts.append(keyframes("bot-head", [(t, "none" if (x, y, d) == (0, 0, 0) else "translate(%s%%, %s%%) %s" % (num(x), num(y), rot(d)))
                                        for t, x, y, d in HEAD], comment="the head talks to the viewer: tilt for hello, nods on the beats, a turn to each arc"))
    parts.append(keyframes("bot-glance", [(t, "none" if (x, y) == (0, 0) else "translate(%spx, %spx)" % (num(x), num(y))) for t, x, y in GLANCE],
                           comment="eyes + smile glance at each arc, then back to the viewer (canvas units)"))
    parts.append(keyframes("bot-lean", [(t, "none" if (d, y) == (0, 0) else ("translateY(%s%%)" % num(y) if not d else rot(d))) for t, d, y in LEAN]))
    parts.append(keyframes("bot-smile", [(t, "none" if (x, y) == (1, 1) else "scale(%s, %s)" % (num(x), num(y))) for t, x, y in SMILE]))
    return "\n".join(parts)


BEGIN = "/* motion.py: generated intro keyframes - edit tools/bot-render/motion.py, not here */\n"
END = "/* motion.py: end */\n"

if __name__ == "__main__":
    css = open(CSS, encoding="utf8").read()
    assert css.count(BEGIN) == 1 and css.count(END) == 1, "marker comments missing"
    new = re.sub(re.escape(BEGIN) + ".*?" + re.escape(END), lambda m: BEGIN + "\n" + build() + "\n" + END, css, flags=re.S)
    open(CSS, "w", encoding="utf8").write(new)
    print("keyframes written:", len(re.findall(r"@keyframes", build())))
