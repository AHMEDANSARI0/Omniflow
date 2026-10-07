"""The OmniFlowBot intro timeline (12s loop) -> CSS keyframes (step 3).

Poses are written in seconds; this script turns them into the generated
keyframes block of app/components/OmniFlowBot/OmniFlowBot.module.css
(between the two "motion.py" marker comments), so the timeline stays
readable and in one place. Run after editing a pose:
    python3 tools/bot-render/motion.py

Arms: (seconds, shoulder, elbow, wrist, k). Angles in CSS degrees
(negative = the viewer's right arm out / up, positive = the left arm);
k < 1 foreshortens the forearm, i.e. the hand comes toward the viewer
(the wrist undoes the squash, so the hand keeps its shape). Palms: the
open hand (palm to the viewer) fades in over the relaxed one.
"""
import os
import re

LOOP = 12.0
CSS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "app", "components", "OmniFlowBot", "OmniFlowBot.module.css")
REST = (0, 0, 0, 1)

# viewer's right arm: front wave, open hands while explaining, presents the
# channels to the viewer (palm out, beats on each bubble), welcome at the end
ARM_R = [
    (0.3, 3, 4, 0, 1),  # anticipation
    (0.95, -62, -108, -4, 1),
    (1.15, -58, -112, 12, 1),  # wave: forearm up, palm to the viewer, wrist wags
    (1.45, -61, -104, -10, 1),
    (1.75, -59, -112, 12, 1),
    (2.05, -60, -105, -8, 1),
    (2.3, -56, -108, 4, 1),
    (2.65, -8, -14, 0, 1),
    (2.85, *REST),
    (3.05, -12, 20, -6, 0.85),  # explain: open hand toward the viewer, on the beats
    (3.5, -14, 28, -10, 0.82),
    (3.9, -12, 18, -4, 0.85),
    (4.3, -15, 30, -10, 0.82),
    (4.75, -2, 4, 0, 1),
    (4.85, 2, -2, 0, 1),
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
    (9.3, -36, 44, -12, 0.84),  # connected: both hands open to the viewer
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
# open palm over the relaxed hand: (opens from, open at, closes from, closed at)
PALM = {"r": (0.55, 0.8, 11.25, 11.5), "l": (2.9, 3.15, 11.3, 11.55)}
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
    return "%g" % round(v, 3)


def keyframes(name, frames, prop="transform", comment=None):
    """frames: [(seconds, value)], 0 and 100% padded with the rest value; equal neighbours merge."""
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
        out.append(",\n".join("  " + pct(t) for t in stops) + " {\n    %s: %s;\n  }\n" % (prop, v))
    return "".join(out) + "}\n"


def rot(d):
    return "rotate(%sdeg)" % num(d)


def arm(side, poses, comment):
    poses = [(0, *REST)] + poses + [(LOOP, *REST)]
    upper = [(t, rot(s) if s else "none") for t, s, f, h, k in poses]
    fore = [(t, "none" if (f, k) == (0, 1) else "%s scale(1, %s)" % (rot(f), num(k))) for t, s, f, h, k in poses]
    hand = [(t, "none" if (h, k) == (0, 1) else "scale(1, %s) %s" % (num(1 / k), rot(h))) for t, s, f, h, k in poses]
    return (keyframes("bot-arm-" + side, upper, comment=comment) + "\n" + keyframes("bot-fore-" + side, fore) + "\n"
            + keyframes("bot-hand-" + side, hand))


def palm(side):
    a, b, c, d = PALM[side]
    opened = keyframes("bot-palm-" + side, [(0, "0"), (a, "0"), (b, "1"), (c, "1"), (d, "0")], "opacity")
    # the relaxed hand goes a moment after the palm covers it, and comes back before it leaves
    grip = keyframes("bot-grip-" + side, [(0, "1"), (a + 0.1, "1"), (b + 0.05, "0"), (c - 0.05, "0"), (d - 0.1, "1")], "opacity")
    return opened + "\n" + grip


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
    parts.append(palm("r"))
    parts.append(palm("l"))
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
