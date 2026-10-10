"""Audio previews: waveform path, loudness meta, and a playable mp3 clip."""

from __future__ import annotations

import math
import os
import re
import sys
import tempfile
from array import array
from pathlib import Path

from . import cache, tools

#: Waveform drawing space. Columns sit on an integer grid so path data stays short.
WAVE_VIEW_W = 400
WAVE_VIEW_H = 100
WAVE_DISPLAY_W = 320
WAVE_DISPLAY_H = 80
WAVE_COLOR = "#4a9eda"
#: Peak columns per candidate; each divides ``WAVE_VIEW_W``. The first is "rich".
RICH_COLUMNS = 400
REDUCED_COLUMNS = (200, 100, 50, 25, 10, 5)

CLIP_SECONDS = 60
CLIP_BITRATE = "128k"
#: Cap on decoded samples so a long file cannot flood memory (rate drops instead).
MAX_SAMPLES = 1_500_000
MAX_RATE = 8000
MIN_RATE = 200


def decode_samples(path: str, duration: float | None) -> array:
    """Mono 16-bit samples of ``path`` at a low rate chosen to bound the sample count."""
    rate = MAX_RATE
    if duration and duration > 0:
        rate = max(MIN_RATE, min(MAX_RATE, int(MAX_SAMPLES / duration)))
    out = tools.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-i", path,
         "-vn", "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"]
    )
    samples = array("h")
    usable = len(out.stdout) - len(out.stdout) % 2
    samples.frombytes(out.stdout[:usable])
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def column_peaks(samples: array, columns: int) -> list[tuple[float, float]]:
    """(min, max) per column, scaled to [-1, 1]."""
    n = len(samples)
    peaks = []
    for i in range(columns):
        start = i * n // columns
        end = max((i + 1) * n // columns, start + 1)
        chunk = samples[start:end] or samples[-1:]
        peaks.append((min(chunk) / 32768.0, max(chunk) / 32768.0))
    return peaks


def waveform_svg(samples: array, columns: int) -> str:
    """One ``<path>`` of vertical min/max strokes, ``columns`` of them across the view."""
    step = WAVE_VIEW_W // columns
    mid = WAVE_VIEW_H / 2
    segments = []
    for i, (lo, hi) in enumerate(column_peaks(samples, columns)):
        top = min(round(mid - hi * mid), WAVE_VIEW_H // 2 - 1)
        bottom = max(round(mid - lo * mid), WAVE_VIEW_H // 2 + 1)
        segments.append(f"M{i * step} {top}V{bottom}")
    stroke = round(max(0.8, step * 0.8), 1)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WAVE_DISPLAY_W}" height="{WAVE_DISPLAY_H}" '
        f'viewBox="0 0 {WAVE_VIEW_W} {WAVE_VIEW_H}">'
        f'<path d="{"".join(segments)}" stroke="{WAVE_COLOR}" stroke-width="{stroke}" fill="none"/></svg>'
    )


def fit_waveform(samples: array, budget: int) -> tuple[str, str] | None:
    """Richest waveform within ``budget`` as ``(tier, svg)``; ``None`` if none fits."""
    if not samples:
        return None
    for columns in (RICH_COLUMNS, *REDUCED_COLUMNS):
        svg = waveform_svg(samples, columns)
        if len(svg) <= budget:
            return ("rich" if columns == RICH_COLUMNS else "reduced"), svg
    return None


_I_RE = re.compile(r"^\s*I:\s+(-?[\d.]+|-inf)\s+LUFS", re.MULTILINE)
_PEAK_RE = re.compile(r"^\s*Peak:\s+(-?[\d.]+|-inf)\s+dBFS", re.MULTILINE)
#: ebur128 reports its -70 LUFS gate floor when the file is too short to measure.
_LUFS_FLOOR = -70.0


def measure_loudness(path: str) -> dict:
    """``{"lufs": float|None, "peakDb": float|None}`` from one ebur128 pass.

    Timeouts and tool failures give ``None`` values: loudness is nice to have,
    never a reason to lose the preview.
    """
    empty = {"lufs": None, "peakDb": None}
    try:
        out = tools.run(
            ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-i", path,
             "-vn", "-af", "ebur128=peak=sample", "-f", "null", "-"]
        )
    except tools.ToolError:
        return empty
    text = out.stderr.decode("utf-8", "replace")
    summary = text.rsplit("Summary:", 1)[-1]
    lufs = _number(_I_RE.search(summary))
    peak = _number(_PEAK_RE.search(summary))
    if lufs is not None and lufs <= _LUFS_FLOOR:
        lufs = None
    return {"lufs": lufs, "peakDb": peak}


def _number(match: re.Match[str] | None) -> float | None:
    if not match:
        return None
    try:
        value = float(match.group(1))
    except ValueError:
        return None
    return value + 0.0 if math.isfinite(value) else None  # + 0.0 turns -0.0 into 0.0


def ensure_clip(path: str, mtime_ns: int, size: int, channels: int | None) -> str | None:
    """Path of the cached mp3 clip (first 60 s), creating it if needed; ``None`` on failure."""
    target: Path = cache.clip_path(path, mtime_ns, size)
    if target.exists() and target.stat().st_size > 0:
        return str(target)
    tmp = None
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".clip.", suffix=".mp3")
        os.close(fd)
        tools.run(
            ["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-y", "-i", path,
             "-vn", "-map_metadata", "-1", "-t", str(CLIP_SECONDS),
             "-ac", str(min(channels or 2, 2)), "-c:a", "libmp3lame", "-b:a", CLIP_BITRATE,
             "-f", "mp3", tmp]
        )
        if os.path.getsize(tmp) == 0:
            return None
        os.replace(tmp, target)
        tmp = None
        return str(target)
    except (tools.ToolError, OSError):
        return None
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
