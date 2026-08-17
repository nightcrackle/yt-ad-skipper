"""
Generates the extension's toolbar icons (16/48/128px) from a single source
image: icons/icon-source.png.

The source is padded to a square canvas first (so a non-square source isn't
stretched/distorted), then downsampled with high-quality resampling for
each target size. Re-run this after replacing icon-source.png with new
artwork:

    python3 gen_icons.py
"""

from pathlib import Path
from PIL import Image

ICON_DIR = Path(__file__).parent / "icons"
SOURCE = ICON_DIR / "icon-source.png"
SIZES = (16, 48, 128)


def pad_to_square(img):
    """Pad an image to a square canvas, centered, without distorting it."""
    w, h = img.size
    if w == h:
        return img

    side = max(w, h)
    img = img.convert("RGBA")

    # Sample the source's own corner pixel so the padding matches its
    # existing background instead of introducing a seam.
    fill = img.getpixel((0, 0))

    canvas = Image.new("RGBA", (side, side), fill)
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return canvas


def make_icons():
    if not SOURCE.exists():
        raise SystemExit(f"Missing source image: {SOURCE}")

    source = Image.open(SOURCE)
    squared = pad_to_square(source)

    for size in SIZES:
        resized = squared.resize((size, size), Image.LANCZOS)
        out_path = ICON_DIR / f"icon{size}.png"
        resized.save(out_path)
        print(f"wrote {out_path} ({size}x{size})")


if __name__ == "__main__":
    make_icons()
