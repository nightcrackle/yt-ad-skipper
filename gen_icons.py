from PIL import Image, ImageDraw

def make_icon(size, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # red rounded-square background (YouTube-ish red)
    margin = max(1, size // 16)
    d.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=size // 4,
        fill=(204, 0, 0, 255),
    )

    # white "skip" glyph: two triangles + a bar, like a media skip-forward icon
    cy = size / 2
    tri_h = size * 0.34
    tri_w = size * 0.22
    gap = size * 0.06
    start_x = size * 0.27

    def triangle(x0):
        return [
            (x0, cy - tri_h / 2),
            (x0, cy + tri_h / 2),
            (x0 + tri_w, cy),
        ]

    d.polygon(triangle(start_x), fill=(255, 255, 255, 255))
    d.polygon(triangle(start_x + tri_w + gap), fill=(255, 255, 255, 255))

    bar_x = start_x + 2 * tri_w + 2 * gap
    bar_w = size * 0.07
    d.rounded_rectangle(
        [bar_x, cy - tri_h / 2, bar_x + bar_w, cy + tri_h / 2],
        radius=bar_w / 3,
        fill=(255, 255, 255, 255),
    )

    img.save(path)

for s in (16, 48, 128):
    make_icon(s, f"icons/icon{s}.png")

print("done")
