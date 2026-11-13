"""Builds the textures the logo morph on the landing page reads.

Run from anywhere:  python3 site/tools/make_morph.py
Needs numpy, scipy and Pillow. The output is committed, so the site build does
not run this.

Why distance fields rather than vector paths. The four marks share no point
structure: a swirl, three parallelograms, two blobs. Interpolating paths needs a
point-to-point correspondence that does not exist. A signed distance field needs
none. Blend two fields and the zero line between them is a plausible shape that
slides from one outline to the other, whatever the outlines were.

Each mark yields two images. The field is a grey PNG, 128 meaning "on the edge",
brighter inside. The colour is the mark with its own colours spread outward past
the edge, so a pixel that is outside the old shape and inside the new one still
has a colour to take.
"""
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage

MARKS = Path(__file__).resolve().parents[1] / "landing" / "marks"
OUT = Path(__file__).resolve().parents[1] / "landing" / "morph"
FILES = ["mark1-blue-2002.png", "mark2-sheets-2003.png", "mark3-orange-green-4x.png", "mark4-orange-2012.png"]

# Pixels of distance the 8-bit field can express either side of the edge. Larger
# reaches further but quantises coarser: 40 gives steps of about a third of a pixel.
REACH = 40.0
# Anything this far from pure white counts as ink. The 2002 mark's cream is only
# about 17 levels off white, and it is part of the mark.
INK = 8

OUT.mkdir(exist_ok=True)
for n, name in enumerate(FILES):
    rgb = np.asarray(Image.open(MARKS / name).convert("RGB")).astype(np.float32)
    inside = (255.0 - rgb).max(axis=2) > INK
    # Distance to the nearest edge, positive inside and negative outside. The half
    # pixel puts the zero line on the edge between pixels rather than on a pixel.
    d_in = ndimage.distance_transform_edt(inside)
    d_out = ndimage.distance_transform_edt(~inside)
    sdf = np.where(inside, d_in - 0.5, -(d_out - 0.5))
    field = np.clip(128 + sdf / REACH * 127, 0, 255).astype(np.uint8)
    Image.fromarray(field, "L").save(OUT / f"sdf{n}.png", optimize=True)

    _, (iy, ix) = ndimage.distance_transform_edt(~inside, return_indices=True)
    spread = rgb[iy, ix]
    # Nearest-pixel spreading leaves streaks along the edge wherever the colour
    # changes, and the morph shows them as hatching. Blur the spread colour and
    # keep the mark's own pixels untouched underneath.
    blurred = np.stack([ndimage.gaussian_filter(spread[..., c], 7) for c in range(3)], axis=2)
    spread = np.where(inside[..., None], rgb, blurred).astype(np.uint8)
    Image.fromarray(spread, "RGB").save(OUT / f"col{n}.png", optimize=True)
    print(name, "inside", int(inside.sum()), "px")
