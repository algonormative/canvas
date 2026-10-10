"""Quick Look thumbnails via ``qlmanage -t`` (macOS)."""

from __future__ import annotations

import glob
import os
import tempfile

from . import tools

THUMB_PIXELS = 512


def thumbnail_png(path: str, pixels: int = THUMB_PIXELS) -> bytes | None:
    """PNG bytes of a Quick Look thumbnail of ``path``, or ``None`` if there is none.

    ``qlmanage`` exits 0 even when it makes nothing, so success is judged by the
    output file. Timeouts and a missing ``qlmanage`` propagate as
    :class:`canvas_cli.tools.ToolError` for the caller to degrade on.
    """
    with tempfile.TemporaryDirectory(prefix="canvas-ql-") as out_dir:
        tools.run(["qlmanage", "-t", "-s", str(pixels), "-o", out_dir, path], check=False)
        outputs = sorted(glob.glob(os.path.join(glob.escape(out_dir), "*.png")))
        if not outputs:
            return None
        with open(outputs[0], "rb") as handle:
            data = handle.read()
    return data or None
