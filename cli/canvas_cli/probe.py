"""ffprobe wrapper."""

from __future__ import annotations

import json

from . import tools


class ProbeError(Exception):
    """ffprobe could not make sense of the file."""


def probe(path: str) -> dict:
    """Parsed ``ffprobe -show_format -show_streams`` output for ``path``.

    Raises :class:`ProbeError` for unparseable files; tool timeouts, a missing
    ffprobe and non-zero exits propagate as ``tools.ToolError`` subclasses
    (a non-zero exit means "ffprobe does not recognise this file").
    """
    out = tools.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-i", path]
    )
    try:
        data = json.loads(out.stdout or b"{}")
    except ValueError as exc:
        raise ProbeError("ffprobe produced no JSON") from exc
    if not isinstance(data, dict) or not data.get("streams"):
        raise ProbeError("no streams")
    return data


def streams(data: dict, codec_type: str, *, skip_cover_art: bool = False) -> list[dict]:
    found = []
    for stream in data.get("streams", []):
        if stream.get("codec_type") != codec_type:
            continue
        if skip_cover_art and (stream.get("disposition") or {}).get("attached_pic"):
            continue
        found.append(stream)
    return found


def duration_seconds(data: dict, stream: dict | None = None) -> float | None:
    for source in (data.get("format") or {}, stream or {}):
        try:
            value = float(source.get("duration"))
        except (TypeError, ValueError):
            continue
        if value >= 0 and value != float("inf"):
            return round(value, 3)
    return None


def to_int(value: object) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
