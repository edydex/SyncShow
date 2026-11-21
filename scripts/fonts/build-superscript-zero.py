"""Build SyncShowSuperscriptZero-{Regular,Bold}.ttf from the bundled Liberation Sans.

Liberation Sans has superscript one to nine but no superscript zero (U+2070),
so verse numbers 10, 20, 30, 100... drew their zero from whatever fallback font
the computer had: taller, heavier and higher than the digit beside it.

This builds a one-glyph font: Liberation's own "0" scaled and raised with the
same transform that turns Liberation's "1" into its superscript one (U+00B9),
with the same advance width, so it matches the Latin-1 superscripts it usually
sits next to. The output is a derivative of Liberation Sans under the SIL Open
Font License 1.1 and does not use the reserved font name "Liberation".

Run from the repository root (requires fontTools, e.g. `uv pip install fonttools`):
    python scripts/fonts/build-superscript-zero.py
"""
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

FONTS = Path(__file__).resolve().parents[2] / "assets" / "fonts"
FAMILY = "SyncShow Superscript Zero"


def build(style: str) -> Path:
    source = TTFont(FONTS / f"LiberationSans-{style}.ttf")
    cmap, glyf, hmtx = source.getBestCmap(), source["glyf"], source["hmtx"]
    one, sup, zero = (glyf[cmap[cp]] for cp in (0x31, 0xB9, 0x30))
    for glyph in (one, sup, zero):
        glyph.recalcBounds(glyf)
    scale = (sup.yMax - sup.yMin) / (one.yMax - one.yMin)
    advance = hmtx[cmap[0xB9]][0]
    dx = (advance - (zero.xMax - zero.xMin) * scale) / 2 - zero.xMin * scale
    dy = sup.yMin - one.yMin * scale
    pen = TTGlyphPen(None)
    zero.draw(TransformPen(pen, (scale, 0, 0, scale, dx, dy)), glyf)
    glyph = pen.glyph()

    builder = FontBuilder(source["head"].unitsPerEm, isTTF=True)
    builder.setupGlyphOrder([".notdef", "uni2070"])
    builder.setupCharacterMap({0x2070: "uni2070"})
    builder.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "uni2070": glyph})
    glyph.recalcBounds(builder.font["glyf"])
    builder.setupHorizontalMetrics({".notdef": (advance, 0), "uni2070": (advance, glyph.xMin)})
    hhea = source["hhea"]
    builder.setupHorizontalHeader(ascent=hhea.ascent, descent=hhea.descent, lineGap=hhea.lineGap)
    os2 = source["OS/2"]
    builder.setupOS2(
        usWeightClass=os2.usWeightClass,
        fsSelection=0x20 if style == "Bold" else 0x40,
        sTypoAscender=os2.sTypoAscender, sTypoDescender=os2.sTypoDescender, sTypoLineGap=os2.sTypoLineGap,
        usWinAscent=os2.usWinAscent, usWinDescent=os2.usWinDescent,
        sxHeight=os2.sxHeight, sCapHeight=os2.sCapHeight, achVendID="SYNC",
    )
    builder.setupNameTable({
        "copyright": "Derived from Liberation Sans. Digitized data copyright (c) 2010 Google Corporation "
                     "with Reserved Font Arimo, Tinos and Cousine. Copyright (c) 2012 Red Hat, Inc. "
                     "with Reserved Font Name Liberation.",
        "familyName": FAMILY,
        "styleName": style,
        "uniqueFontIdentifier": f"{FAMILY} {style} 1.0",
        "fullName": f"{FAMILY} {style}",
        "psName": f"SyncShowSuperscriptZero-{style}",
        "version": "Version 1.0",
        "licenseDescription": "This Font Software is licensed under the SIL Open Font License, Version 1.1.",
        "licenseInfoURL": "https://openfontlicense.org",
    })
    builder.setupPost()
    builder.font["head"].macStyle = 1 if style == "Bold" else 0
    output = FONTS / f"SyncShowSuperscriptZero-{style}.ttf"
    builder.save(output)
    return output


if __name__ == "__main__":
    for style in ("Regular", "Bold"):
        print(build(style))
