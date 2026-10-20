"""Generate the Squishless SVG logo files.

Run from the repo root:  python site/assets/img/src/make_svgs.py
Needs fontTools (+ brotli for woff2). Writes into site/assets/img/:
  mark.svg, favicon.svg, logo.svg (wordmark for light backgrounds),
  logo-dark.svg (wordmark for dark backgrounds)
The wordmark text is converted to outlines from DynaPuff (SIL OFL) so the SVG
renders identically everywhere, including inside <img>.
"""
import os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.dirname(HERE)
FONT = os.path.join(IMG, "..", "fonts", "dynapuff-latin-var.woff2")

RASPBERRY = "#ff3d6e"
PLUM = "#2a0716"
WINE = "#9c1043"  # the hill: dark enough to read on pink, light enough to hold on dark pages
BUTTER = "#ffcf4a"
INK_LIGHT = "#2b1620"
INK_DARK = "#fbeef2"

# Squircle body (64 x 64 artboard)
SQUIRCLE = "M32 2C54.5 2 62 9.5 62 32S54.5 62 32 62 2 54.5 2 32 9.5 2 32 2Z"
HILL = "M0 47C11 38 20 37.5 31 43.5S50 47 64 37V64H0Z"
SEAM = "M29 -2C38 10 25 20.5 31 32S38 54 29 66"


def mark_group(seam_width=5.0, sun=True, hill=True):
    parts = [f'<path d="{SQUIRCLE}" fill="{RASPBERRY}"/>']
    inner = []
    if sun:
        inner.append(f'<circle cx="45.5" cy="20" r="6.5" fill="{BUTTER}"/>')
    if hill:
        inner.append(f'<path d="{HILL}" fill="{WINE}"/>')
    inner.append(
        f'<path d="{SEAM}" fill="none" stroke="#fff" stroke-width="{seam_width}" '
        'stroke-linecap="round" stroke-linejoin="round"/>'
    )
    parts.append('<g clip-path="url(#sq-clip)">' + "".join(inner) + "</g>")
    return "".join(parts)


DEFS = f'<defs><clipPath id="sq-clip"><path d="{SQUIRCLE}"/></clipPath></defs>'


def write(name, content):
    with open(os.path.join(IMG, name), "w", encoding="utf-8", newline="\n") as f:
        f.write(content)
    print("wrote", name, len(content), "bytes")


def wordmark_path(text, weight=700, size=48):
    font = TTFont(FONT)
    font = instancer.instantiateVariableFont(font, {"wght": weight})
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upm = font["head"].unitsPerEm
    scale = size / upm
    hmtx = font["hmtx"]
    pen = SVGPathPen(gs, ntos=lambda v: ('%.2f' % v).rstrip('0').rstrip('.'))
    x = 0.0
    tracking = -0.01 * upm
    for ch in text:
        gname = cmap[ord(ch)]
        # flip y: font units are y-up, SVG is y-down; baseline at y = ascent
        tp = TransformPen(pen, (scale, 0, 0, -scale, x * scale, 0))
        gs[gname].draw(tp)
        x += hmtx[gname][0] + tracking
    width = (x - tracking) * scale
    return pen.getCommands(), width, font["OS/2"].sCapHeight * scale, -font["hhea"].descent * scale


def main():
    # mark.svg: full detail, for 32 px and up
    write(
        "mark.svg",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">'
        "<title>Squishless</title>" + DEFS + mark_group() + "</svg>\n",
    )
    # favicon.svg: same mark with a slightly heavier seam so it holds at 16 px
    write(
        "favicon.svg",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' + DEFS
        + mark_group(seam_width=6.5) + "</svg>\n",
    )

    d, tw, cap, desc = wordmark_path("Squishless", 700, 46)
    # layout: mark 64 high, text baseline so caps sit centred on the mark
    gap = 14
    baseline = 32 + cap / 2
    total_w = 64 + gap + tw + 2
    for name, ink in (("logo.svg", INK_LIGHT), ("logo-dark.svg", INK_DARK)):
        write(
            name,
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total_w:.1f} 72" '
            f'width="{total_w:.0f}" height="72" role="img" aria-label="Squishless">'
            + DEFS
            + f'<g transform="translate(0 4)">{mark_group()}</g>'
            + f'<path transform="translate({64 + gap} {baseline + 4:.2f})" d="{d}" fill="{ink}"/>'
            + "</svg>\n",
        )


if __name__ == "__main__":
    main()
