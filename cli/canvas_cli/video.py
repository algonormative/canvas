"""Video stills via ffmpeg: a poster frame and a 4-frame filmstrip."""

from __future__ import annotations

from PIL import Image

from . import raster, tools

POSTER_MAX_W = 640
STRIP_FRAME_MAX_W = 240
STRIP_FRACTIONS = (0.125, 0.375, 0.625, 0.875)
#: Longest-side candidates (px) and qualities for a strip, widest first.
STRIP_SIDES = (960, 640, 480, 320)
STRIP_QUALITIES = (70, 50)
#: A four-tile strip cannot meaningfully fit in less; do not decode four frames for it.
STRIP_MIN_BUDGET = 3000


def _frame_png(path: str, seconds: float, max_w: int) -> bytes:
    out = tools.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-ss", f"{seconds:.3f}", "-i", path,
         "-an", "-frames:v", "1", "-vf", f"scale=w='min({max_w},iw)':h=-2",
         "-f", "image2pipe", "-c:v", "png", "-"]
    )
    if not out.stdout:
        raise tools.ToolFailed(["ffmpeg"], 0, b"no frame at that position")
    return out.stdout


def poster(path: str, duration: float | None) -> raster.Loaded:
    """One representative frame (10% in, falling back to the first frame)."""
    seconds = duration * 0.1 if duration else 0.0
    try:
        data = _frame_png(path, seconds, POSTER_MAX_W)
    except tools.ToolFailed:
        if seconds == 0.0:
            raise
        data = _frame_png(path, 0.0, POSTER_MAX_W)
    return raster.load_image(data)


def filmstrip(path: str, duration: float | None) -> Image.Image | None:
    """Four frames side by side, or ``None`` if any frame cannot be had."""
    if not duration or duration <= 0:
        return None
    try:
        frames = [
            raster.load_image(_frame_png(path, duration * f, STRIP_FRAME_MAX_W), STRIP_FRAME_MAX_W).image
            for f in STRIP_FRACTIONS
        ]
    except (tools.ToolError, raster.ImageUnreadable):
        return None
    height = min(f.height for f in frames)
    frames = [f if f.height == height else f.resize((max(1, round(f.width * height / f.height)), height)) for f in frames]
    strip = Image.new("RGB", (sum(f.width for f in frames), height))
    x = 0
    for frame in frames:
        strip.paste(frame, (x, 0))
        x += frame.width
    return strip
