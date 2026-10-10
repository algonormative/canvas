"""On-disk preview cache.

Layout under the canvas cache root (``$CANVAS_CACHE_DIR`` or ``~/.cache/canvas``)::

    preview/<sha1(abs path, mtime_ns, size, budget)>/result.json   one finished preview
    preview/<same key>/thumb.jpg                                   the embedded JPEG, if any
    clips/<sha1(abs path, mtime_ns, size)>.mp3                      audio clips, shared by budget

Clips are keyed without the budget because they are the one large artefact and
are identical whatever budget the caller asks for.

Every write is write-temp-then-rename. Any filesystem problem degrades to "no
cache": callers get ``None`` back and compute the result again.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

# Bump when the result shape or any renderer changes in a way old entries cannot satisfy.
CACHE_VERSION = 1


def cache_root() -> Path:
    override = os.environ.get("CANVAS_CACHE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".cache" / "canvas"


def _digest(*parts: object) -> str:
    return hashlib.sha1("\0".join(str(p) for p in parts).encode("utf-8", "surrogateescape")).hexdigest()


def preview_key(abs_path: str, mtime_ns: int, size: int, budget: int) -> str:
    return _digest(abs_path, mtime_ns, size, budget)


def entry_dir(key: str) -> Path:
    return cache_root() / "preview" / key


def clip_path(abs_path: str, mtime_ns: int, size: int) -> Path:
    return cache_root() / "clips" / f"{_digest(abs_path, mtime_ns, size)}.mp3"


def atomic_write_bytes(dest: Path, data: bytes) -> None:
    """Write ``data`` to ``dest`` atomically (temp file in the same directory, then rename)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dest.parent, prefix=f".{dest.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load(key: str) -> dict | None:
    """Return the cached preview dict for ``key`` or ``None`` on any miss or damage."""
    try:
        data = json.loads((entry_dir(key) / "result.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("_v") != CACHE_VERSION:
        return None
    # A result is only as good as the files it points at.
    for field in ("clip", "thumb"):
        ref = data.get(field)
        if ref and not os.path.exists(ref):
            return None
    data.pop("_v", None)
    return data


def store(key: str, result: dict, thumb: bytes | None) -> dict:
    """Persist ``result`` (and its thumbnail) and return it with ``thumb`` filled in.

    Never raises: an unwritable cache just means the next call recomputes.
    """
    result = dict(result)
    try:
        directory = entry_dir(key)
        if thumb:
            thumb_file = directory / "thumb.jpg"
            atomic_write_bytes(thumb_file, thumb)
            result["thumb"] = str(thumb_file)
        payload = dict(result, _v=CACHE_VERSION)
        atomic_write_bytes(directory / "result.json", json.dumps(payload).encode("utf-8"))
    except OSError:
        result["thumb"] = None
    return result
