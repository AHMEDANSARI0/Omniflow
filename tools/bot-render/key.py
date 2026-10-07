"""Key the magenta studio background out of the robot render (step 1).

The robot is neutral (white / grey / black), the background a flat
saturated colour K, so for a pixel P = a*F + (1-a)*K with grey F the
background share follows from the chroma: (1-a) = (P - P_g) / (K - K_g).
Pixels not connected to the background become fully opaque (glossy
white reflects a little magenta, which must not turn into holes), and
the colour is neutralised (no magenta tint left on the edges).
Writes robot_rgba.png and palms_rgba.png (full size, git-ignored) for
split.py.
"""
import os

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
# main render, and the same render with open palms facing the camera
# (1024 px, upscaled to the main render's size - it lines up 1:1)
RENDERS = (("omniflow-bot-render.webp", "robot_rgba.png"), ("omniflow-bot-render-palms.webp", "palms_rgba.png"))


def key(src, dst):
    im = Image.open(os.path.join(HERE, src)).convert("RGB")
    im = np.asarray(im.resize((1536, 1536), Image.LANCZOS) if im.size != (1536, 1536) else im).astype(np.float64)
    h, w, _ = im.shape
    corners = np.concatenate([im[:60, :60].reshape(-1, 3), im[:60, -60:].reshape(-1, 3), im[-60:, :60].reshape(-1, 3)])
    K = corners.mean(0)
    R, G, B = im[..., 0], im[..., 1], im[..., 2]
    # share of background from the two chroma axes (least squares)
    dr, db = K[0] - K[1], K[2] - K[1]
    bg = ((R - G) * dr + (B - G) * db) / (dr * dr + db * db)
    bg = np.clip(bg, 0, 1)
    alpha = 1 - bg

    # true background = big connected regions that are mostly background
    bgmask = bg > 0.5
    lab, n = ndimage.label(bgmask)
    sizes = ndimage.sum(np.ones_like(bg), lab, range(1, n + 1))
    big = np.zeros(n + 1, bool)
    big[1:] = sizes > 400
    background = big[lab]
    # inside the silhouette (farther than 2px from background) = opaque
    dist = ndimage.distance_transform_edt(~background)
    alpha = np.where(dist > 2.5, 1.0, np.where(background, np.minimum(alpha, 0.0 + alpha * (alpha > 0.08)), alpha))
    alpha[background & (bg > 0.92)] = 0
    # unmix the colour, then neutralise it (grey = the robot's only hues)
    a = np.maximum(alpha, 1e-3)[..., None]
    F = (im - (1 - a) * K) / a
    F = np.clip(F, 0, 255)
    grey = F[..., 0] * 0.3 + F[..., 1] * 0.59 + F[..., 2] * 0.11
    # interior: luminance of the observed pixel (tinted reflections keep their brightness)
    lum = R * 0.3 + G * 0.59 + B * 0.11
    grey = np.where(dist > 2.5, np.maximum(grey, lum), grey)
    out = np.dstack([grey, grey, grey, alpha * 255]).round().clip(0, 255).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(os.path.join(HERE, dst))
    ys, xs = np.where(alpha > 0.05)
    print(dst, "bbox", xs.min(), ys.min(), xs.max(), ys.max(), "K", K.round(1))


for src, dst in RENDERS:
    key(src, dst)
