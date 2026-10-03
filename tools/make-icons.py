"""Generate every icon Daybook ships, from one description of the mark.

    python tools/make-icons.py

Zero dependencies: draws at 4x with boolean coverage, box-downsamples for
anti-aliasing, then writes the PNG by hand with zlib. No image library to
install and nothing that ever reaches the device.

The mark is three ascending bars over a baseline — a week of readings.
Colours follow the app's own tokens so the home screen icon and the app
agree: accent blue ground, paper marks.

Outputs
-------
icon-192, icon-512      manifest `purpose: "any"`; Android installs from these
icon-maskable-512       drawn inset, so Android's mask cannot crop the mark
icon-180                <link rel="apple-touch-icon">; iOS downscales it
favicon-32, favicon-16  browser tab
icon-monochrome         Android 13 themed icon: silhouette on transparency,
                        which the launcher tints itself, so it must carry no
                        colour of its own
"""

import os
import struct
import zlib

ACCENT = (0x2E, 0x5E, 0x86)   # --accent
PAPER  = (0xF1, 0xF3, 0xF1)   # --paper
SS = 4                        # supersample factor


def rounded(px, py, x, y, w, h, r):
    if px < x or py < y or px >= x + w or py >= y + h:
        return False
    r = min(r, w / 2, h / 2)
    if r <= 0:
        return True
    cx = min(max(px, x + r), x + w - r)
    cy = min(max(py, y + r), y + h - r)
    dx, dy = px - cx, py - cy
    return dx * dx + dy * dy <= r * r


def render(size, maskable=False, monochrome=False):
    """Return RGBA bytes for one icon.

    `maskable` pulls the mark inside Android's safe circle and squares the
    ground. `monochrome` drops the ground entirely and draws the mark in
    opaque white on transparency, because the launcher supplies the colour.
    """
    S = size * SS
    inset = 0.19 if (maskable or monochrome) else 0.0
    scale = 1.0 - 2 * inset

    def U(v):
        return (inset + v * scale) * S

    corner = 0.0 if maskable else 0.223 * S
    unit = U(0.11) - U(0.0)

    shapes = [(U(0.26), U(0.699), U(0.48) - U(0.0), U(0.029), (U(0.029) - U(0.0)) / 2)]
    for bx, top in ((0.279, 0.539), (0.445, 0.439), (0.611, 0.339)):
        shapes.append((U(bx), U(top), unit, U(0.699) - U(top), unit / 2))

    out = bytearray(size * size * 4)
    total = SS * SS
    for oy in range(size):
        for ox in range(size):
            ground = 0
            mark = 0
            for sy in range(SS):
                py = oy * SS + sy + 0.5
                for sx in range(SS):
                    px = ox * SS + sx + 0.5
                    on_mark = any(rounded(px, py, *s) for s in shapes)
                    if on_mark:
                        mark += 1
                    if monochrome:
                        continue
                    if maskable or rounded(px, py, 0, 0, S, S, corner):
                        ground += 1

            i = (oy * size + ox) * 4
            if monochrome:
                # Silhouette only. Colour comes from the launcher's theme.
                if not mark:
                    continue
                a = mark / total
                out[i] = out[i + 1] = out[i + 2] = 255
                out[i + 3] = round(a * 255)
                continue

            if not ground:
                continue
            f = mark / ground
            col = tuple(round(ACCENT[c] * (1 - f) + PAPER[c] * f) for c in range(3))
            out[i], out[i + 1], out[i + 2] = col
            out[i + 3] = round(ground / total * 255)
    return out


def write_png(path, size, pixels):
    raw = b"".join(
        b"\x00" + bytes(pixels[y * size * 4:(y + 1) * size * 4]) for y in range(size)
    )

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Daybook">
  <rect width="512" height="512" rx="114" fill="#2E5E86"/>
  <g fill="#F1F3F1">
    <rect x="133" y="358" width="246" height="15" rx="7.5"/>
    <rect x="143" y="276" width="56" height="66" rx="28"/>
    <rect x="228" y="225" width="56" height="117" rx="28"/>
    <rect x="313" y="174" width="56" height="168" rx="28"/>
  </g>
</svg>
"""

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    icons = os.path.join(os.path.dirname(here), "icons")
    os.makedirs(icons, exist_ok=True)

    with open(os.path.join(icons, "icon.svg"), "w", encoding="utf-8", newline="\n") as f:
        f.write(SVG)
    print("wrote icon.svg")

    jobs = [
        ("icon-192.png", 192, {}),
        ("icon-512.png", 512, {}),
        ("icon-180.png", 180, {}),
        ("favicon-32.png", 32, {}),
        ("favicon-16.png", 16, {}),
        ("icon-maskable-512.png", 512, {"maskable": True}),
        ("icon-monochrome.png", 512, {"monochrome": True}),
    ]
    for name, size, kw in jobs:
        n = write_png(os.path.join(icons, name), size, render(size, **kw))
        print("wrote %-24s %5d bytes" % (name, n))
