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
  palm-l / palm-r - the same hands open, palms to the camera (from the
          palms render, key.py), cut at the same seam; the open thumbs reach
          past the canvas, so each palm is a small box of its own (printed in
          % of the canvas) inside the hand joint
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

# open palms: same render with open hands (lines up 1:1, key.py)
palms = np.asarray(Image.open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "palms_rgba.png"))).copy()
palms[:4, :, 3] = palms[-4:, :, 3] = 0
palms[:, :4, 3] = palms[:, -4:, 3] = 0
plab, _ = ndimage.label((palms[..., 3] > 8) & (gy > WRIST_Y - 60))  # below here the arms stand free

def palm(elbow, wrist, side):
    zone = plab[1000:, :560] if side == "l" else plab[1000:, 990:]
    ids, counts = np.unique(zone[zone > 0], return_counts=True)
    mask = (plab == ids[np.argmax(counts)]) & (along(elbow, wrist) > -4)
    ys, xs = np.where(mask)
    return mask, (int(xs.min()) - 4, int(ys.min()) - 4, int(xs.max()) + 5, int(ys.max()) + 5)

palm_l, palm_r = palm(elbow_l, wrist_l, "l"), palm(elbow_r, wrist_r, "r")

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

boxes = {}
for name, (mask, (bx0, by0, bx1, by1)) in (("palm-l", palm_l), ("palm-r", palm_r)):
    layer = palms.copy()
    layer[..., 3] = np.where(mask, palms[..., 3], 0)
    img = Image.fromarray(layer[by0:by1, bx0:bx1], "RGBA").resize((round((bx1 - bx0) * scale), round((by1 - by0) * scale)), Image.LANCZOS)
    path = os.path.join(OUT, "omniflow-bot-%s.webp" % name)
    img.save(path, "WEBP", quality=82, method=6, alpha_quality=90)
    total += os.path.getsize(path)
    boxes[name] = {"size": list(img.size), "box": [round((bx0 - x0) / cw * 100, 2), round((by0 - y0) / ch * 100, 2),
                                                    round((bx1 - bx0) / cw * 100, 2), round((by1 - by0) / ch * 100, 2)]}
    print(name, os.path.getsize(path), "bytes")

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
