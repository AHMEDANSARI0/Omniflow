"""Split the keyed robot into animation layers (step 2, after key.py).

Layers share one canvas (the robot's crop box), so in the page they all
sit at inset 0 and only move by transform:
  body  - torso, neck, legs, boots
  head  - helmet, visor, ear pods, antennae (cut at the neck)
  upper-l / upper-r - shoulder ball, upper arm and the whole elbow band
          (cut at the shoulder; below it the arms are already separated
          by background)
  fore-l / fore-r - forearm from the middle of the elbow band (the band
          stays on the upper arm as the socket, so a bent elbow never
          shows a gap) down to the wrist seam
  hand-l / hand-r - hand from the wrist seam (the forearm keeps the seam
          too, so a turned wrist stays closed)
  palm-r - the waving hand: taken from the wave render (key.py; the same
          robot with its arm up, palm to the camera, fingers together), cut
          at the wrist ring, turned and scaled onto this hand's wrist (cuff
          widths match, ring on ring), so it is exactly this robot's hand
          size; a small box of its own (printed in % of the canvas) inside
          the hand joint. Resting hands stay relaxed (palms to the body).
  Elbow / wrist cuts run across each segment's own axis.
Prints the pivots (shoulders, elbows, wrists) and the visor / chest-panel boxes in % of the canvas
for the component. Output: ../../public/bot/omniflow-bot-*.webp
"""
import json
import os

import numpy as np
from PIL import Image
from scipy import ndimage

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "bot")
WIDTH = 560  # 2x the largest rendered width (~280 css px)

rgba = np.asarray(Image.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "robot_rgba.png"))).copy()
rgba[:4, :, 3] = rgba[-4:, :, 3] = 0
rgba[:, :4, 3] = rgba[:, -4:, 3] = 0
alpha = rgba[..., 3]
solid = alpha > 8
H, W = alpha.shape

NECK_Y = 504
CUT_L, CUT_R = 566, 988  # torso edges at the shoulders
SHOULDER = (540, 690)

body_side = solid.copy()
body_side[:NECK_Y] = False
# a 10px band through each shoulder (it follows the armpit gap at its
# lower end); band pixels then go to whichever part is nearest
cut = body_side.copy()
cut[SHOULDER[0]:SHOULDER[1], CUT_L - 7:CUT_L + 3] = False
cut[SHOULDER[0]:SHOULDER[1], CUT_R - 1:CUT_R + 9] = False
lab, _ = ndimage.label(cut)
near = ndimage.distance_transform_edt(lab == 0, return_distances=False, return_indices=True)
lab = np.where(body_side, lab[near[0], near[1]], 0)
arm_l = lab == lab[850, 420]
arm_r = lab == lab[850, 1130]
assert arm_l.sum() < body_side.sum() * 0.2 and arm_r.sum() < body_side.sum() * 0.2, "arms not separated"
head = solid.copy()
head[NECK_Y:] = False
body = solid & ~head & ~arm_l & ~arm_r

def centroid(mask):
    ys, xs = np.where(mask)
    return float(xs.mean()), float(ys.mean())

dark = (rgba[..., 0] < 60) & solid
ball_l = centroid(np.pad(dark[560:690, 480:CUT_L], ((560, H - 690), (480, W - CUT_L))))
ball_r = centroid(np.pad(dark[560:690, CUT_R:1070], ((560, H - 690), (CUT_R, W - 1070))))

# elbow band centres (dark pixels of the band) and wrist seam centres
def dark_centre(x0, x1, y0, y1):
    yy, xx = np.where(dark[y0:y1, x0:x1])
    return float(xx.mean() + x0), float(yy.mean() + y0)

elbow_l, elbow_r = dark_centre(380, 520, 755, 835), dark_centre(1040, 1185, 755, 835)
WRIST_Y = 968
def row_centre(mask, y):
    xx = np.where(mask[y - 20])[0]
    return float(xx.mean()), float(y)

wrist_l, wrist_r = row_centre(arm_l, WRIST_Y), row_centre(arm_r, WRIST_Y)
gy, gx = np.mgrid[0:H, 0:W]

def along(a, b):
    """Signed distance past b along the a->b axis, per pixel."""
    ux, uy = b[0] - a[0], b[1] - a[1]
    n = (ux * ux + uy * uy) ** 0.5
    return ((gx - b[0]) * ux + (gy - b[1]) * uy) / n

BAND = 16  # upper arm keeps the band down to here (no forearm white)
def segments(arm, shoulder, elbow, wrist):
    past_elbow, past_wrist = along(shoulder, elbow), along(elbow, wrist)
    hand = arm & (past_wrist > -4) & (past_elbow > BAND)
    fore = arm & (past_elbow > -8) & (past_wrist <= 6)  # overlaps the hand by the seam
    upper = arm & (past_elbow <= BAND) & ~(fore & (past_elbow > BAND))
    assert not (upper & ~arm).any() and (upper | fore | hand).sum() == arm.sum(), "segments must cover the arm"
    return upper, fore, hand

upper_l, fore_l, hand_l = segments(arm_l, ball_l, elbow_l, wrist_l)
upper_r, fore_r, hand_r = segments(arm_r, ball_r, elbow_r, wrist_r)

# the waving hand (wave render, key.py): the raised forearm's axis from its cuff, the hand cut at the wrist ring
wave = np.asarray(Image.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "wave_rgba.png"))).copy()
wsolid = wave[..., 3] > 128
WAVE_CUFF = (500, 560)  # rows of the raised forearm's cuff, below the wrist ring
WAVE_HAND = (1060, 1420, 120)  # x0, x1, y0: the region around the raised hand


def run_at(mask, y, x):
    xs = np.where(mask[y])[0]
    runs = np.split(xs, np.where(np.diff(xs) > 1)[0] + 1)
    run = next(r for r in runs if r.min() <= x <= r.max())
    return float(run.min()), float(run.max())


def axis(mask, rows, x):
    """centre line of a cuff: points (x, y) per row, its unit direction (increasing y), its width across the axis."""
    pts = [((lambda l, r: ((l + r) / 2, y, r - l))(*run_at(mask, y, x))) for y in range(rows[0], rows[1], 2)]
    xs, ys, ws = (np.array(v) for v in zip(*pts))
    k = np.polyfit(ys, xs, 1)[0]
    u = np.array([k, 1.0]) / np.hypot(k, 1.0)
    return (xs.mean(), ys.mean()), u, float(np.median(ws)) * u[1]


def ring_top(img, centre, u, sign):
    """first dark pixel walking from the cuff centre along +-u: where the wrist ring starts."""
    for t in range(0, 200):
        x, y = centre[0] + sign * u[0] * t, centre[1] + sign * u[1] * t
        if img[int(round(y)), int(round(x)), 0] < 80:
            return np.array([x, y])
    raise AssertionError("no wrist ring")


m_centre, m_u, m_width = axis(arm_r, (WRIST_Y - 68, WRIST_Y - 12), int(wrist_r[0]))
w_centre, w_u, w_width = axis(wsolid, WAVE_CUFF, 1240)
m_ring, w_ring = ring_top(rgba, m_centre, m_u, 1), ring_top(wave, w_centre, w_u, -1)
turn = np.arctan2(m_u[1], m_u[0]) - np.arctan2(-w_u[1], -w_u[0])  # raised hand (fingers up) -> hanging (fingers down)
zoom = m_width / w_width
wy, wx = np.mgrid[0:wave.shape[0], 0:wave.shape[1]]
beyond = -((wx - w_ring[0]) * w_u[0] + (wy - w_ring[1]) * w_u[1])  # distance past the ring top, toward the fingers
region = np.zeros_like(wsolid)
region[WAVE_HAND[2]:, WAVE_HAND[0]:WAVE_HAND[1]] = True
wlab, _ = ndimage.label(wsolid & region & (beyond > -2))
hand_id = wlab[int(w_ring[1] - w_u[1] * 60), int(w_ring[0] - w_u[0] * 60)]
assert hand_id, "the waving hand was not found above its ring"
wave_hand = wave.copy()
wave_hand[..., 3] = np.where(wlab == hand_id, wave[..., 3], 0)

ys, xs = np.where(solid)
pad = 24
x0, y0, x1, y1 = xs.min() - pad, ys.min() - pad, xs.max() + pad, ys.max() + pad
cw, ch = x1 - x0, y1 - y0
scale = WIDTH / cw
size = (WIDTH, round(ch * scale))
os.makedirs(OUT, exist_ok=True)
total = 0
LAYERS = (("body", body), ("head", head), ("upper-l", upper_l), ("fore-l", fore_l), ("hand-l", hand_l),
          ("upper-r", upper_r), ("fore-r", fore_r), ("hand-r", hand_r))
for name, mask in LAYERS:
    layer = rgba.copy()
    layer[..., 3] = np.where(mask, alpha, 0)
    # grow the edge by 1px of colour under alpha 0 so resampling never pulls in black
    img = Image.fromarray(layer[y0:y1, x0:x1], "RGBA").resize(size, Image.LANCZOS)
    path = os.path.join(OUT, "omniflow-bot-%s.webp" % name)
    img.save(path, "WEBP", quality=82, method=6, alpha_quality=90)
    total += os.path.getsize(path)
    print(name, os.path.getsize(path), "bytes")

# waving hand -> canvas px: p = (m_ring + zoom * R(turn) (q - w_ring) - (x0, y0)) * scale
c, sn = np.cos(turn), np.sin(turn)
fwd = np.array([[c, -sn], [sn, c]]) * zoom * scale
ys_, xs_ = np.where(wave_hand[..., 3] > 0)
pts = (np.stack([xs_ - w_ring[0], ys_ - w_ring[1]]).T @ fwd.T) + (m_ring - (x0, y0)) * scale
bx0, by0 = np.floor(pts.min(0)) - 3
bx1, by1 = np.ceil(pts.max(0)) + 3
inv = np.linalg.inv(fwd)
# output pixel (u, v) -> wave pixel; PIL wants the inverse affine
off = w_ring - inv @ ((m_ring - (x0, y0)) * scale - (bx0, by0))
supersample = 4
big = Image.fromarray(wave_hand, "RGBA").transform((int(bx1 - bx0) * supersample, int(by1 - by0) * supersample), Image.AFFINE,
                                                   (*(inv[0] / supersample), off[0], *(inv[1] / supersample), off[1]), Image.BICUBIC)
img = big.resize((int(bx1 - bx0), int(by1 - by0)), Image.LANCZOS)
path = os.path.join(OUT, "omniflow-bot-palm-r.webp")
img.save(path, "WEBP", quality=82, method=6, alpha_quality=90)
total += os.path.getsize(path)
print("palm-r", os.path.getsize(path), "bytes", "turn %.1f deg, zoom %.3f" % (np.degrees(turn), zoom))
boxes = {"palm-r": {"size": list(img.size), "box": [round(bx0 / WIDTH * 100, 2), round(by0 / size[1] * 100, 2),
                                                    round((bx1 - bx0) / WIDTH * 100, 2), round((by1 - by0) / size[1] * 100, 2)]}}

pct = lambda x, y: [round(float(x - x0) / cw * 100, 2), round(float(y - y0) / ch * 100, 2)]
info = {
    "canvas": [int(cw), int(ch)], "size": [int(v) for v in size], "total_bytes": total,
    "neck": pct(775, NECK_Y), "shoulder_l": pct(*ball_l), "shoulder_r": pct(*ball_r),
    "elbow_l": pct(*elbow_l), "elbow_r": pct(*elbow_r), "wrist_l": pct(*wrist_l), "wrist_r": pct(*wrist_r),
    "visor": pct(570, 166) + pct(979, 452), "chest": pct(665, 589) + pct(879, 752),
    "ear_l": pct(485, 225) + pct(562, 405), "ear_r": pct(988, 225) + pct(1066, 405),
    "palms": boxes,
}
print(json.dumps(info))
