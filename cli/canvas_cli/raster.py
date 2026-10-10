"""Still-image handling with Pillow: load, JPEG-in-SVG thumbnails, vector mosaics.

Both fitters take a character budget and return the richest candidate whose
SVG string fits. Candidate lists are fixed (independent of the budget), so a
larger budget can only ever reach an equal or richer candidate.
"""

from __future__ import annotations

import base64
import io
import warnings
from dataclasses import dataclass

from PIL import Image, ImageOps

SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {vw} {vh}"{extra}>'

#: Longest side, in pixels, of the JPEG candidates tried for the rich tier.
JPEG_SIDES = (480, 320, 240, 160, 120, 96, 64)
JPEG_QUALITIES = (75, 55, 35)
#: Longest side, in cells, of the mosaic candidates tried for the reduced tier.
MOSAIC_SIDES = (32, 24, 16, 12, 8, 6, 4, 3, 2, 1)
#: Display size (px) of the longer mosaic edge.
MOSAIC_DISPLAY = 128


class ImageUnreadable(Exception):
    """Pillow could not open or decode the image."""


@dataclass
class Loaded:
    image: Image.Image  # RGB, downscaled to at most ``max_side`` on the long edge
    width: int  # original pixel dimensions
    height: int
    format: str | None


def _flatten_to_rgb(img: Image.Image) -> Image.Image:
    if img.mode in ("I;16", "I;16L", "I;16B", "I;16N", "I"):
        img = img.convert("I").point(lambda v: v * (1 / 256)).convert("L")
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        backdrop = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(backdrop, rgba).convert("RGB")
    return img.convert("RGB")


def load_image(source: str | bytes, max_side: int = 512) -> Loaded:
    """Open a path (or PNG/JPEG bytes) as an RGB image no larger than ``max_side``."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            handle = io.BytesIO(source) if isinstance(source, bytes) else source
            with Image.open(handle) as img:
                fmt = img.format
                img = ImageOps.exif_transpose(img) or img
                width, height = img.size
                if fmt == "JPEG":
                    img.draft("RGB", (max_side * 2, max_side * 2))
                img.load()
                rgb = _flatten_to_rgb(img)
        rgb.thumbnail((max_side, max_side), Image.Resampling.LANCZOS, reducing_gap=2.0)
    except Exception as exc:  # Pillow raises a wide family on bad input
        raise ImageUnreadable(str(exc)) from exc
    return Loaded(rgb, width, height, fmt)


def image_svg(width: int, height: int, jpeg: bytes) -> str:
    b64 = base64.b64encode(jpeg).decode("ascii")
    return (
        SVG_OPEN.format(w=width, h=height, vw=width, vh=height, extra="")
        + f'<image width="{width}" height="{height}" href="data:image/jpeg;base64,{b64}"/></svg>'
    )


def fit_jpeg_svg(
    img: Image.Image,
    budget: int,
    sides: tuple[int, ...] = JPEG_SIDES,
    qualities: tuple[int, ...] = JPEG_QUALITIES,
) -> tuple[str, bytes] | None:
    """Largest JPEG thumbnail (as ``<image>`` in an ``<svg>``) within ``budget``.

    Returns ``(svg, jpeg_bytes)`` or ``None`` when even the smallest does not fit.
    """
    seen: set[tuple[int, int]] = set()
    for side in sides:
        frame = img.copy()
        frame.thumbnail((side, side), Image.Resampling.LANCZOS, reducing_gap=2.0)
        if frame.size in seen:
            continue
        seen.add(frame.size)
        for quality in qualities:
            buf = io.BytesIO()
            frame.save(buf, "JPEG", quality=quality)
            jpeg = buf.getvalue()
            if 4 * ((len(jpeg) + 2) // 3) > budget:  # base64 alone already over
                continue
            svg = image_svg(frame.width, frame.height, jpeg)
            if len(svg) <= budget:
                return svg, jpeg
    return None


def mosaic_grid(img: Image.Image, side: int) -> tuple[int, int]:
    """Columns and rows for a mosaic whose long edge is ``side`` cells (never above the pixels)."""
    w, h = img.size
    longest = max(w, h)
    cols = min(w, max(1, round(side * w / longest)))
    rows = min(h, max(1, round(side * h / longest)))
    return cols, rows


def mosaic_svg(img: Image.Image, side: int) -> str:
    """A ``side``-cell grid of ``<rect>`` fills averaged from ``img``."""
    cols, rows = mosaic_grid(img, side)
    small = img.resize((cols, rows), Image.Resampling.BOX)
    pixels = small.load()
    disp_w = max(1, round(MOSAIC_DISPLAY * cols / max(cols, rows)))
    disp_h = max(1, round(MOSAIC_DISPLAY * rows / max(cols, rows)))
    parts = [SVG_OPEN.format(w=disp_w, h=disp_h, vw=cols, vh=rows, extra=' shape-rendering="crispEdges"')]
    for y in range(rows):
        for x in range(cols):
            r, g, b = pixels[x, y]
            parts.append(f'<rect x="{x}" y="{y}" width="1" height="1" fill="#{r:02x}{g:02x}{b:02x}"/>')
    parts.append("</svg>")
    return "".join(parts)


def fit_mosaic_svg(img: Image.Image, budget: int, sides: tuple[int, ...] = MOSAIC_SIDES) -> str | None:
    """Finest mosaic within ``budget``, or ``None`` if even one cell does not fit."""
    seen: set[tuple[int, int]] = set()
    for side in sides:
        grid = mosaic_grid(img, side)
        if grid in seen:
            continue
        seen.add(grid)
        svg = mosaic_svg(img, side)
        if len(svg) <= budget:
            return svg
    return None
