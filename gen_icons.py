"""
Generates the extension's toolbar icons (16/48/128px) from a single source
image: icons/icon-source.png.

icon-source.png is the original artwork as provided (opaque black
background). This script derives everything else from it:

  1. Removes the background, turning it transparent. The background is
     found via flood fill from the image borders (not a flat color-key)
     so that dark pixels *inside* the artwork (e.g. shading) that aren't
     connected to the border are left alone, and the cut edge is
     feathered based on each pixel's own distance from black rather than
     a hard threshold, to avoid a jagged cutout.
  2. Crops tightly to the artwork's bounding box and re-pads to a square
     canvas with a small margin, so the glyph fills as much of each
     icon's canvas as possible (important at 16px).
  3. For each target size, adds a soft light rim just outside the
     artwork's silhouette. This exists specifically for pinned-toolbar
     visibility: this artwork's face is a solid dark fill, which reads
     fine on Chrome's light theme but nearly disappears on its dark
     theme without a defined edge. The rim is white at partial opacity,
     so composited over a white/light toolbar it's indistinguishable
     from the background (no visible cost there) while on a dark toolbar
     it outlines the shape. It is not a full fix for every possible
     toolbar color, just a broadly-tested improvement for the light/dark
     cases Chrome actually ships.

Re-run after replacing icon-source.png with new artwork:

    python3 gen_icons.py

Requires Pillow and scipy (see requirements-dev.txt).
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

ICON_DIR = Path(__file__).parent / "icons"
SOURCE = ICON_DIR / "icon-source.png"
SIZES = (16, 48, 128)

# Background removal: pixels within BG_LOW of pure black are fully
# transparent; pixels beyond BG_HIGH are left fully opaque. In between,
# alpha is interpolated, which feathers the cut edge instead of leaving a
# hard-edged cutout. Only applied to the background region found by flood
# fill from the image border, so enclosed dark shading inside the artwork
# is never touched.
BG_LOW = 15.0
BG_HIGH = 150.0

# Fraction of the cropped artwork's larger dimension used as padding when
# re-squaring, so the glyph doesn't touch the icon's edge. Kept small on
# purpose: a pinned toolbar icon reads as "too small" fast, so this only
# reserves just enough room for the rim's own halo (added below) to not
# get clipped by the canvas edge, not real breathing space beyond that.
CROP_PADDING_FRACTION = 0.02

# Soft rim added just outside the silhouette (see module docstring). Width
# and blur scale with icon size so it reads consistently at every size
# instead of vanishing at 16px or overwhelming 128px.
RIM_COLOR = (255, 255, 255)
RIM_OPACITY = 170  # 0-255


def remove_background(img):
    """Flood-fill the border-connected black background to transparent,
    with a feathered edge. Returns a new RGBA image."""
    arr = np.array(img.convert("RGBA")).astype(np.float64)
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3]
    dist_from_black = np.sqrt((rgb**2).sum(axis=2))

    bg_like = dist_from_black < BG_HIGH
    labeled, _ = ndimage.label(bg_like, structure=np.ones((3, 3), dtype=int))
    border_labels = set(
        labeled[0, :].tolist()
        + labeled[-1, :].tolist()
        + labeled[:, 0].tolist()
        + labeled[:, -1].tolist()
    )
    border_labels.discard(0)
    border_mask = np.isin(labeled, list(border_labels))

    soft_alpha = np.clip((dist_from_black - BG_LOW) / (BG_HIGH - BG_LOW), 0, 1) * 255
    new_alpha = alpha.copy()
    new_alpha[border_mask] = np.minimum(alpha[border_mask], soft_alpha[border_mask])

    out = arr.copy()
    out[:, :, 3] = new_alpha
    return Image.fromarray(out.astype(np.uint8), "RGBA")


def crop_and_square(img, padding_fraction):
    """Tight-crop to the non-transparent bounding box, then pad to a
    square canvas with a small transparent margin."""
    alpha_mask = img.split()[3].point(lambda p: 255 if p > 10 else 0)
    bbox = alpha_mask.getbbox()
    if bbox is None:
        return img

    cropped = img.crop(bbox)
    w, h = cropped.size
    pad = round(max(w, h) * padding_fraction)
    side = max(w, h) + pad * 2

    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(cropped, ((side - w) // 2, (side - h) // 2), cropped)
    return canvas


def add_toolbar_rim(img, size):
    """Adds a soft light rim just outside the artwork's silhouette,
    scaled for the given icon size. See module docstring for why."""
    alpha = np.array(img.split()[3])
    shape_mask = alpha > 40

    dilate_px = max(1, round(size / 48))
    blur_radius = max(0.45, size / 96)

    dilated = ndimage.binary_dilation(shape_mask, iterations=dilate_px)
    ring = dilated & ~shape_mask
    ring_alpha = np.where(ring, RIM_OPACITY, 0).astype(np.float64)

    ring_alpha_img = Image.fromarray(ring_alpha.astype(np.uint8), "L")
    ring_alpha_img = ring_alpha_img.filter(ImageFilter.GaussianBlur(blur_radius))

    ring_layer = Image.new("RGBA", img.size, RIM_COLOR + (0,))
    ring_layer.putalpha(ring_alpha_img)

    return Image.alpha_composite(ring_layer, img)


def make_icons():
    if not SOURCE.exists():
        raise SystemExit(f"Missing source image: {SOURCE}")

    transparent = remove_background(Image.open(SOURCE))
    squared = crop_and_square(transparent, CROP_PADDING_FRACTION)

    for size in SIZES:
        resized = squared.resize((size, size), Image.LANCZOS)
        finished = add_toolbar_rim(resized, size)
        out_path = ICON_DIR / f"icon{size}.png"
        finished.save(out_path)
        print(f"wrote {out_path} ({size}x{size})")


if __name__ == "__main__":
    make_icons()
