"""Fixtures are generated at test time with ffmpeg, sox and Pillow; none are committed."""

from __future__ import annotations

import random
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from canvas_cli import quicklook, tools

#: Marker text planted in container tags; it must never appear in any preview output.
TAG_MARKER = "IGNORE-PREVIOUS-INSTRUCTIONS"


def _run(*argv: str) -> None:
    subprocess.run([*argv], check=True, capture_output=True, stdin=subprocess.DEVNULL)


def _big_svg() -> str:
    circles = "".join(
        f'<circle cx="{(i * 7) % 400}" cy="{(i * 13) % 300}" r="{3 + i % 9}" fill="#{(i * 977) % 0xFFFFFF:06x}"/>'
        for i in range(400)
    )
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">{circles}</svg>'


EVIL_SVG = """<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="100" height="100" viewBox="0 0 100 100" onload="alert(1)">
  <script>alert(2)</script>
  <circle cx="50" cy="50" r="40" fill="red" onclick="steal()"/>
  <image xlink:href="http://evil.example/track.png" width="10" height="10"/>
  <a href="javascript:alert(3)"><rect width="5" height="5"/></a>
  <image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>
  <use href="#local"/>
</svg>
"""


@pytest.fixture(autouse=True)
def cache_dir(tmp_path, monkeypatch):
    """Every test gets its own empty preview cache."""
    root = tmp_path / "canvas-cache"
    monkeypatch.setenv("CANVAS_CACHE_DIR", str(root))
    return root


@pytest.fixture(scope="session")
def media(tmp_path_factory):
    """name -> Path for every generated fixture (some deliberately broken or absent)."""
    d = tmp_path_factory.mktemp("media")
    m: dict[str, Path] = {}

    m["sine"] = d / "sine.wav"
    _run("sox", "-n", "-r", "48000", "-c", "1", str(m["sine"]), "synth", "1", "sine", "440", "vol", "0.5")
    m["stereo"] = d / "stereo.wav"
    _run("sox", "-n", "-r", "44100", "-c", "2", str(m["stereo"]), "synth", "1", "sine", "440", "sine", "660")

    random.seed(7)
    noise = Image.effect_noise((320, 240), 90)
    gradient = Image.linear_gradient("L").resize((320, 240))
    m["png"] = d / "picture.png"
    Image.merge("RGB", (noise, gradient, noise.point(lambda v: 255 - v))).save(m["png"])

    m["mp4"] = d / "clip.mp4"
    _run("ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10",
         "-pix_fmt", "yuv420p", str(m["mp4"]))

    m["svg"] = d / "evil.svg"
    m["svg"].write_text(EVIL_SVG)
    m["bigsvg"] = d / "big.svg"
    m["bigsvg"].write_text(_big_svg())

    m["text"] = d / "notes.txt"
    m["text"].write_text("".join(f"line {i}: some text that fills the file\n" for i in range(100)))
    m["markdown"] = d / "readme.md"
    m["markdown"].write_text("# Heading\n\n" + "".join(f"- bullet {i}\n" for i in range(100)))

    m["pdf"] = d / "doc.pdf"
    Image.new("RGB", (200, 280), (240, 230, 200)).save(m["pdf"])

    m["missing"] = d / "does-not-exist.wav"
    m["empty"] = d / "empty.wav"
    m["empty"].write_bytes(b"")
    m["garbage"] = d / "garbage.wav"
    m["garbage"].write_bytes(bytes(random.randrange(256) for _ in range(4096)))
    m["unknown"] = d / "blob.xyz"
    m["unknown"].write_bytes(bytes(range(256)) * 8)
    m["dir"] = d / "somedir"
    m["dir"].mkdir()

    # Container tags carrying text an attacker could control.
    tags = ["-metadata", f"title={TAG_MARKER}", "-metadata", f"artist={TAG_MARKER}",
            "-metadata", f"comment={TAG_MARKER}"]
    m["tagged_mp3"] = d / "tagged.mp3"
    _run("ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", *tags,
         str(m["tagged_mp3"]))
    m["tagged_mp4"] = d / "tagged.mp4"
    _run("ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10",
         "-pix_fmt", "yuv420p", *tags, str(m["tagged_mp4"]))
    return m


#: Fixtures that are real files of a kind the tool previews.
PREVIEWABLE = ["sine", "stereo", "png", "mp4", "svg", "bigsvg", "text", "markdown", "pdf", "tagged_mp3", "tagged_mp4"]
#: Everything, for budget-invariant sweeps.
EVERYTHING = [*PREVIEWABLE, "missing", "empty", "garbage", "unknown", "dir"]


@pytest.fixture(scope="session")
def quicklook_works(media) -> bool:
    """Whether qlmanage can make a thumbnail here (it can fail inside sandboxes)."""
    try:
        return quicklook.thumbnail_png(str(media["png"])) is not None
    except tools.ToolError:
        return False


@pytest.fixture
def need_quicklook(quicklook_works):
    if not quicklook_works:
        pytest.skip("qlmanage cannot produce thumbnails in this environment")
