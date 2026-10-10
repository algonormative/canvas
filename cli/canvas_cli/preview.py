"""canvas-preview: turn any media path into a preview fitted to a character budget.

``build_preview`` walks the fallback chain for the file's kind (rich -> reduced
-> card) and returns the richest tier whose embedded content fits ``budget``
characters. A card has no embedded content, so it always fits. Nothing here
raises on a bad file: every failure becomes a card with a ``reason``.

``meta`` holds numeric and dimension fields only. Container tags (title,
artist, comment...) are attacker-controlled text and are never copied out.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from dataclasses import dataclass, field

from . import (
    audio,
    cache,
    kinds,
    probe,
    quicklook,
    raster,
    svgsafe,
    textpreview,
    tools,
    video,
)

TIERS = ("rich", "reduced", "card")
DEFAULT_BUDGET = 8000
MAX_SVG_BYTES = 8 * 1024 * 1024

# Card reasons. missing/unreadable/unsupported are about the file; budget means
# the file is fine but no embedded tier fits; timeout means a host tool ran out
# of time (never cached, so a retry can succeed).
REASONS = ("missing", "unreadable", "unsupported", "budget", "timeout")


@dataclass
class Ctx:
    path: str
    label: str
    size: int
    mtime_ns: int
    budget: int
    kind: str
    mime: str


@dataclass
class Preview:
    kind: str
    mime: str
    label: str
    meta: dict
    tier: str
    svg: str | None = None
    clip: str | None = None
    markdown: str | None = None
    thumb: str | None = None
    reason: str | None = None
    # internal, never serialized
    thumb_bytes: bytes | None = field(default=None, repr=False)
    cacheable: bool = field(default=True, repr=False)

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "mime": self.mime,
            "label": self.label,
            "meta": self.meta,
            "svg": self.svg,
            "clip": self.clip,
            "markdown": self.markdown,
            "thumb": self.thumb,
            "tier": self.tier,
            "reason": self.reason,
        }


# --- cards ------------------------------------------------------------------


def _card(ctx: Ctx, reason: str, meta: dict | None = None, *, cacheable: bool = True,
          clip: str | None = None) -> Preview:
    return Preview(
        kind=ctx.kind, mime=ctx.mime, label=ctx.label,
        meta=meta if meta is not None else ({"size": ctx.size} if ctx.size else {}),
        tier="card", reason=reason, clip=clip, cacheable=cacheable,
    )


def _preview(ctx: Ctx, tier: str, meta: dict, **fields: object) -> Preview:
    return Preview(kind=ctx.kind, mime=ctx.mime, label=ctx.label, meta=meta, tier=tier, **fields)  # type: ignore[arg-type]


# --- raster tiers shared by image, video poster, svg fallback, documents ------


def _raster_tiers(ctx: Ctx, img, meta: dict, *, jpeg_tier: str = "rich", clip: str | None = None) -> Preview:
    fitted = raster.fit_jpeg_svg(img, ctx.budget)
    if fitted:
        svg, jpeg = fitted
        return _preview(ctx, jpeg_tier, meta, svg=svg, thumb_bytes=jpeg, clip=clip)
    mosaic = raster.fit_mosaic_svg(img, ctx.budget)
    if mosaic:
        return _preview(ctx, "reduced", meta, svg=mosaic, clip=clip)
    return _card(ctx, "budget", meta, clip=clip)


def _quicklook_tiers(ctx: Ctx, meta: dict, *, jpeg_tier: str, miss_reason: str) -> Preview:
    png = quicklook.thumbnail_png(ctx.path)
    if png is None:
        return _card(ctx, miss_reason, meta)
    try:
        loaded = raster.load_image(png)
    except raster.ImageUnreadable:
        return _card(ctx, miss_reason, meta)
    return _raster_tiers(ctx, loaded.image, meta, jpeg_tier=jpeg_tier)


# --- per-kind handlers ----------------------------------------------------------


def _audio(ctx: Ctx) -> Preview:
    data = probe.probe(ctx.path)
    tracks = probe.streams(data, "audio")
    if not tracks:
        if probe.streams(data, "video", skip_cover_art=True):
            ctx.kind = "video"
            return _video(ctx, data)
        return _card(ctx, "unreadable")
    track = tracks[0]
    channels = probe.to_int(track.get("channels"))
    duration = probe.duration_seconds(data, track)
    meta = {
        "duration": duration,
        "sampleRate": probe.to_int(track.get("sample_rate")),
        "channels": channels,
        "size": ctx.size,
    }
    samples = audio.decode_samples(ctx.path, duration)
    if not samples:
        return _card(ctx, "unreadable", meta)
    meta.update(audio.measure_loudness(ctx.path))
    clip = audio.ensure_clip(ctx.path, ctx.mtime_ns, ctx.size, channels)
    fitted = audio.fit_waveform(samples, ctx.budget)
    if not fitted:
        return _card(ctx, "budget", meta, clip=clip)
    tier, svg = fitted
    return _preview(ctx, tier, meta, svg=svg, clip=clip)


def _image(ctx: Ctx) -> Preview:
    try:
        loaded = raster.load_image(ctx.path)
    except raster.ImageUnreadable:
        if kinds.extension(ctx.path) in kinds.QUICKLOOK_IMAGE_EXTS:
            return _quicklook_tiers(ctx, {"size": ctx.size}, jpeg_tier="rich", miss_reason="unsupported")
        return _card(ctx, "unreadable")
    meta = {"width": loaded.width, "height": loaded.height, "size": ctx.size}
    return _raster_tiers(ctx, loaded.image, meta)


def _svg(ctx: Ctx) -> Preview:
    clean = None
    if ctx.size <= MAX_SVG_BYTES:
        with open(ctx.path, "rb") as handle:
            raw = handle.read(MAX_SVG_BYTES + 1)
        try:
            clean = svgsafe.sanitize_svg(raw)
        except svgsafe.SvgError:
            clean = None
    meta: dict = {"size": ctx.size}
    if clean is not None:
        dims = svgsafe.svg_dimensions(clean)
        if dims:
            meta.update(width=dims[0], height=dims[1])
        if len(clean) <= ctx.budget:
            return _preview(ctx, "rich", meta, svg=clean)
    # Source missing or too big: the reduced tier is a Quick Look rendering.
    # Without a safe source to fall back on, a miss means the file is unusable.
    miss = "budget" if clean is not None or ctx.size > MAX_SVG_BYTES else "unreadable"
    try:
        return _quicklook_tiers(ctx, meta, jpeg_tier="reduced", miss_reason=miss)
    except tools.ToolMissing:
        return _card(ctx, miss, meta)


def _video(ctx: Ctx, data: dict | None = None) -> Preview:
    data = data or probe.probe(ctx.path)
    tracks = probe.streams(data, "video", skip_cover_art=True)
    if not tracks:
        if probe.streams(data, "audio"):
            ctx.kind = "audio"
            return _audio(ctx)
        return _card(ctx, "unreadable")
    track = tracks[0]
    duration = probe.duration_seconds(data, track)
    meta: dict = {
        "duration": duration,
        "width": probe.to_int(track.get("width")),
        "height": probe.to_int(track.get("height")),
        "size": ctx.size,
    }
    fps = _frame_rate(track.get("avg_frame_rate"))
    if fps:
        meta["fps"] = fps
    strip = video.filmstrip(ctx.path, duration) if ctx.budget >= video.STRIP_MIN_BUDGET else None
    if strip is not None:
        fitted = raster.fit_jpeg_svg(strip, ctx.budget, video.STRIP_SIDES, video.STRIP_QUALITIES)
        if fitted:
            svg, jpeg = fitted
            return _preview(ctx, "rich", meta, svg=svg, thumb_bytes=jpeg)
    loaded = video.poster(ctx.path, duration)
    return _raster_tiers(ctx, loaded.image, meta)


def _frame_rate(value: object) -> float | None:
    try:
        num, den = str(value).split("/")
        rate = float(num) / float(den)
    except (ValueError, ZeroDivisionError):
        return None
    return round(rate, 2) if rate > 0 else None


def _document(ctx: Ctx) -> Preview:
    return _quicklook_tiers(ctx, {"size": ctx.size}, jpeg_tier="rich", miss_reason="unsupported")


def _text(ctx: Ctx) -> Preview:
    try:
        text = textpreview.read_head(ctx.path)
    except textpreview.NotText:
        return _card(ctx, "unsupported")
    meta = {"size": ctx.size}
    is_md = kinds.extension(ctx.path) in kinds.MARKDOWN_EXTS
    rich = textpreview.rich_markdown(text, is_md)
    if len(rich) <= ctx.budget:
        return _preview(ctx, "rich", meta, markdown=rich)
    reduced = textpreview.reduced_markdown(text, is_md, ctx.budget)
    if reduced is not None and len(reduced) <= ctx.budget:
        return _preview(ctx, "reduced", meta, markdown=reduced)
    return _card(ctx, "budget", meta)


def _sniff(ctx: Ctx) -> Preview:
    """Unknown extension: text if it reads as text, else whatever ffprobe or Pillow recognises."""
    with open(ctx.path, "rb") as handle:
        head = handle.read(8192)
    if kinds.looks_like_text(head):
        ctx.kind, ctx.mime = "text", "text/plain"
        return _text(ctx)
    try:
        data = probe.probe(ctx.path)
    except (probe.ProbeError, tools.ToolFailed):
        data = None
    if data is not None:
        if probe.streams(data, "video", skip_cover_art=True):
            ctx.kind = "video"
            return _video(ctx, data)
        if probe.streams(data, "audio"):
            ctx.kind = "audio"
            return _audio(ctx)
    try:
        raster.load_image(ctx.path, max_side=8)
    except raster.ImageUnreadable:
        return _card(ctx, "unsupported")
    ctx.kind = "image"
    return _image(ctx)


_HANDLERS = {
    "audio": _audio,
    "image": _image,
    "svg": _svg,
    "video": _video,
    "pdf": _document,
    "document": _document,
    "text": _text,
}


# --- orchestration -------------------------------------------------------------


def _run_handler(ctx: Ctx) -> Preview:
    handler = _HANDLERS.get(ctx.kind, _sniff)
    try:
        return handler(ctx)
    except tools.ToolTimeout:
        return _card(ctx, "timeout", cacheable=False)
    except tools.ToolMissing:
        return _card(ctx, "unsupported", cacheable=False)
    except (tools.ToolFailed, probe.ProbeError, raster.ImageUnreadable, OSError):
        return _card(ctx, "unreadable")
    except Exception as exc:  # noqa: BLE001 - last resort: a bad file must never crash the tool
        print(f"canvas-preview: unexpected {type(exc).__name__}: {exc}", file=sys.stderr)
        return _card(ctx, "unreadable", cacheable=False)


def _enforce_budget(ctx: Ctx, preview: Preview) -> Preview:
    """Belt and braces: whatever a handler built, embedded content never exceeds the budget."""
    over_svg = preview.svg is not None and len(preview.svg) > ctx.budget
    over_md = preview.markdown is not None and len(preview.markdown) > ctx.budget
    if over_svg or over_md:
        return _card(ctx, "budget", preview.meta, clip=preview.clip)
    return preview


def build_preview(raw_path: str, budget: int) -> dict:
    """The preview dict for ``raw_path`` fitted to ``budget`` characters."""
    budget = max(0, int(budget))
    path = os.path.abspath(os.path.expanduser(raw_path))
    label = os.path.basename(path.rstrip(os.sep)) or path
    guess = kinds.kind_from_extension(path)
    ctx = Ctx(path, label, 0, 0, budget, guess or "unknown", kinds.mime_for(path, guess))

    try:
        st = os.stat(path)
    except (FileNotFoundError, NotADirectoryError):
        return _card(ctx, "missing", {}).to_dict()
    except OSError:
        return _card(ctx, "unreadable", {}).to_dict()
    ctx.size, ctx.mtime_ns = st.st_size, st.st_mtime_ns
    if not stat.S_ISREG(st.st_mode):
        ctx.kind = "unknown"
        return _card(ctx, "unsupported", {}).to_dict()
    if st.st_size == 0 or not os.access(path, os.R_OK):
        return _card(ctx, "unreadable").to_dict()

    key = cache.preview_key(path, st.st_mtime_ns, st.st_size, budget)
    cached = cache.load(key)
    if cached is not None:
        return cached

    preview = _enforce_budget(ctx, _run_handler(ctx))
    result = preview.to_dict()
    if preview.cacheable:
        result = cache.store(key, result, preview.thumb_bytes)
    return result


# --- CLI -------------------------------------------------------------------------


def _budget(text: str) -> int:
    value = int(text)
    if value < 0:
        raise argparse.ArgumentTypeError("budget must be zero or more")
    return value


def _describe(result: dict) -> str:
    lines = [f"{result['label']}  ({result['kind']}, tier {result['tier']})"]
    if result.get("reason"):
        lines.append(f"  reason: {result['reason']}")
    for key, value in result["meta"].items():
        lines.append(f"  {key}: {value}")
    if result.get("svg"):
        lines.append(f"  svg: {len(result['svg'])} chars")
    if result.get("markdown"):
        lines.append(f"  markdown: {len(result['markdown'])} chars")
    if result.get("clip"):
        lines.append(f"  clip: {result['clip']}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="canvas-preview",
        description="Preview a media file as JSON fitted to a character budget.",
    )
    parser.add_argument("path", help="file to preview")
    parser.add_argument("--budget", type=_budget, default=DEFAULT_BUDGET,
                        help=f"max characters of embedded svg/markdown (default {DEFAULT_BUDGET})")
    parser.add_argument("--json", action="store_true", help="print the preview as JSON")
    args = parser.parse_args(argv)
    result = build_preview(args.path, args.budget)
    print(json.dumps(result) if args.json else _describe(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
