from __future__ import annotations

import base64
import io
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

import pytest
from conftest import EVERYTHING, PREVIEWABLE, TAG_MARKER
from PIL import Image

from canvas_cli import cache, preview, svgsafe, tools, video

BUDGETS = [500, 2000, 8000, 30000, 90000]
RANK = {"rich": 0, "reduced": 1, "card": 2}


def run(path, budget):
    return preview.build_preview(str(path), budget)


def svg_root(svg: str) -> ET.Element:
    return ET.fromstring(svg)


# --- budget and tier invariants -------------------------------------------------


@pytest.mark.parametrize("name", EVERYTHING)
def test_budget_never_exceeded(media, name):
    for budget in BUDGETS:
        result = run(media[name], budget)
        assert result["tier"] in RANK
        if result["svg"] is not None:
            assert len(result["svg"]) <= budget, (name, budget, len(result["svg"]))
        if result["markdown"] is not None:
            assert len(result["markdown"]) <= budget, (name, budget)
        if result["tier"] == "card":
            assert result["svg"] is None and result["markdown"] is None
            assert result["reason"] is not None
        else:
            assert result["reason"] is None


@pytest.mark.parametrize("name", EVERYTHING)
def test_tier_degrades_monotonically_as_budget_shrinks(media, name):
    ranks = [RANK[run(media[name], b)["tier"]] for b in BUDGETS]  # ascending budgets
    assert ranks == sorted(ranks, reverse=True), (name, ranks)


@pytest.mark.parametrize("name", PREVIEWABLE)
def test_zero_budget_is_always_a_card(media, name):
    result = run(media[name], 0)
    assert result["tier"] == "card"
    assert result["svg"] is None and result["markdown"] is None


@pytest.mark.parametrize("name", ["sine", "stereo", "png", "mp4", "svg", "text", "markdown"])
def test_ample_budget_reaches_rich(media, name):
    assert run(media[name], 90000)["tier"] == "rich"


@pytest.mark.parametrize("name", ["sine", "stereo", "png", "mp4"])
def test_tiny_budget_still_reaches_reduced_for_raster_and_audio(media, name):
    result = run(media[name], 500)
    assert result["tier"] == "reduced"
    assert len(result["svg"]) <= 500


def test_each_media_kind_reaches_rich_reduced_and_card(media):
    # audio: waveform columns shrink; image/video: JPEG -> mosaic; all end in a card at budget 0
    for name in ("sine", "png", "mp4"):
        tiers = {run(media[name], b)["tier"] for b in (90000, 500, 0)}
        assert tiers == {"rich", "reduced", "card"}, name
    assert {run(media["text"], b)["tier"] for b in (90000, 100, 0)} == {"rich", "reduced", "card"}


# --- audio ------------------------------------------------------------------------


def test_audio_rich(media, cache_dir):
    result = run(media["sine"], 8000)
    assert result["kind"] == "audio" and result["mime"] == "audio/wav"
    assert result["tier"] == "rich"
    meta = result["meta"]
    assert meta["duration"] == pytest.approx(1.0, abs=0.05)
    assert meta["sampleRate"] == 48000 and meta["channels"] == 1
    assert meta["lufs"] == pytest.approx(-9.7, abs=0.5)  # 0.5-amplitude sine
    assert meta["peakDb"] == pytest.approx(-6.0, abs=0.5)
    svg = result["svg"]
    root = svg_root(svg)
    assert {"width", "height", "viewBox"} <= set(root.attrib)
    assert svg.count("<path") == 1  # the whole waveform is a single path
    assert "<image" not in svg and "<rect" not in svg  # vector only, no raster


def test_audio_clip_is_a_playable_mp3_in_the_cache(media, cache_dir):
    result = run(media["sine"], 8000)
    clip = result["clip"]
    assert clip.endswith(".mp3") and os.path.exists(clip)
    assert clip.startswith(str(cache_dir))
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=format_name,duration", "-of", "json", clip],
        capture_output=True, check=True,
    )
    info = json.loads(out.stdout)["format"]
    assert "mp3" in info["format_name"]
    assert float(info["duration"]) == pytest.approx(1.0, abs=0.2)


def test_stereo_audio_meta(media):
    meta = run(media["stereo"], 8000)["meta"]
    assert meta["channels"] == 2 and meta["sampleRate"] == 44100


def test_audio_waveform_gets_coarser_as_budget_shrinks(media):
    sizes = [len(run(media["sine"], b)["svg"]) for b in (500, 2000, 8000)]
    assert sizes == sorted(sizes) and len(set(sizes)) == 3


def test_audio_clip_present_even_when_budget_forces_a_card(media):
    result = run(media["sine"], 0)
    assert result["tier"] == "card" and result["reason"] == "budget"
    assert result["clip"] and os.path.exists(result["clip"])
    assert result["meta"]["duration"] == pytest.approx(1.0, abs=0.05)


# --- image ------------------------------------------------------------------------


def test_image_rich_is_jpeg_data_uri_in_an_svg_with_explicit_size(media):
    result = run(media["png"], 8000)
    assert result["kind"] == "image" and result["mime"] == "image/png" and result["tier"] == "rich"
    assert result["meta"] == {"width": 320, "height": 240, "size": os.path.getsize(media["png"])}
    root = svg_root(result["svg"])
    assert {"width", "height", "viewBox"} <= set(root.attrib)
    assert root.attrib["viewBox"] == f"0 0 {root.attrib['width']} {root.attrib['height']}"
    href = re.search(r'href="data:image/jpeg;base64,([^"]+)"', result["svg"]).group(1)
    jpeg = Image.open(io.BytesIO(base64.b64decode(href)))
    assert jpeg.format == "JPEG"
    assert str(jpeg.width) == root.attrib["width"] and str(jpeg.height) == root.attrib["height"]
    # the same JPEG is available as a file for callers that want it
    assert result["thumb"] and os.path.exists(result["thumb"])


def test_image_mosaic_is_a_grid_of_rects(media):
    result = run(media["png"], 700)
    assert result["tier"] == "reduced"
    svg = result["svg"]
    assert "<image" not in svg and "base64" not in svg
    root = svg_root(svg)
    cols, rows = map(int, root.attrib["viewBox"].split()[2:])
    rects = root.findall("{http://www.w3.org/2000/svg}rect")
    assert len(rects) == cols * rows >= 1
    assert all(re.fullmatch(r"#[0-9a-f]{6}", r.attrib["fill"]) for r in rects)
    assert {"width", "height"} <= set(root.attrib)


def test_larger_budget_gives_finer_mosaic(media):
    # force the mosaic path with a noisy image whose JPEG never fits these budgets
    cells = []
    for budget in (400, 700, 1000):
        root = svg_root(run(media["png"], budget)["svg"])
        cols, rows = map(int, root.attrib["viewBox"].split()[2:])
        cells.append(cols * rows)
    assert cells == sorted(cells)


# --- video --------------------------------------------------------------------------


def test_video_rich_is_a_filmstrip_and_meta_has_dimensions(media):
    result = run(media["mp4"], 90000)
    assert result["kind"] == "video" and result["mime"] == "video/mp4" and result["tier"] == "rich"
    meta = result["meta"]
    assert meta["duration"] == pytest.approx(1.0, abs=0.1)
    assert (meta["width"], meta["height"]) == (160, 120)
    root = svg_root(result["svg"])
    assert int(root.attrib["width"]) > 160  # four frames side by side
    assert "data:image/jpeg;base64," in result["svg"]


def test_video_filmstrip_timeout_degrades_to_poster(media, monkeypatch):
    real = tools.run

    def flaky(argv, **kwargs):
        if any(f"min({video.STRIP_FRAME_MAX_W}," in a for a in argv):
            raise tools.ToolTimeout("ffmpeg")
        return real(argv, **kwargs)

    monkeypatch.setattr(tools, "run", flaky)
    result = run(media["mp4"], 90000)
    assert result["tier"] == "rich"
    assert int(svg_root(result["svg"]).attrib["width"]) == 160  # the single poster frame


def test_video_poster_mosaic_at_tiny_budget(media):
    result = run(media["mp4"], 500)
    assert result["tier"] == "reduced" and "<rect" in result["svg"]


# --- svg ----------------------------------------------------------------------------


def test_svg_rich_is_sanitized_source(media):
    result = run(media["svg"], 8000)
    assert result["kind"] == "svg" and result["mime"] == "image/svg+xml" and result["tier"] == "rich"
    svg = result["svg"]
    root = svg_root(svg)  # still well-formed
    assert "script" not in svg.lower()
    assert "onload" not in svg and "onclick" not in svg
    assert "evil.example" not in svg and "javascript:" not in svg
    assert 'href="data:image/png;base64,' in svg  # data: URIs survive
    assert 'href="#local"' in svg  # so do #fragments
    assert root.attrib["width"] == "100"
    assert result["meta"]["width"] == 100.0


@pytest.mark.parametrize(
    "source, absent, present",
    [
        ('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script><rect/></svg>', ["script", "x()"], ["<rect"]),
        ('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><rect onmouseover="y()"/></svg>', ["onload", "onmouseover"], ["<rect"]),
        ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://e.com/a.png"/></svg>', ["e.com"], ["<image"]),
        ('<svg xmlns="http://www.w3.org/2000/svg"><a href="//e.com/x"><g/></a></svg>', ["e.com"], ["<g"]),
        ('<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(http://e.com/a.css); rect{fill:red}</style><rect/></svg>', ["e.com", "@import"], ["fill:red"]),
        ('<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(http://e.com/g)"/></svg>', ["e.com"], ["<rect"]),
        ('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>hi</div></foreignObject><rect/></svg>', ["foreignobject", "<div"], ["<rect"]),
        ('<svg xmlns="http://www.w3.org/2000/svg"><a href="data:text/html,&lt;b&gt;x&lt;/b&gt;"><g/></a></svg>', ["data:text/html"], ["<g"]),
        ('<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>', ["javascript", "animate"], ["<a"]),
        ('<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#grad)"/></svg>', [], ['url(#grad)']),
        ('<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT>x()</SCRIPT><rect ONCLICK="y()"/></svg>', ["script", "onclick"], ["<rect"]),
    ],
)
def test_sanitizer_strips_active_and_external_content(source, absent, present):
    out = svgsafe.sanitize_svg(source.encode())
    for needle in absent:
        assert needle.lower() not in out.lower(), (needle, out)
    for needle in present:
        assert needle in out, (needle, out)
    ET.fromstring(out)


@pytest.mark.parametrize(
    "bad",
    [b"not xml at all", b"<html></html>", b"<?xml version='1.0'?><!DOCTYPE s [<!ENTITY a 'b'>]><svg xmlns='http://www.w3.org/2000/svg'>&a;</svg>"],
)
def test_sanitizer_rejects_non_svg(bad):
    with pytest.raises(svgsafe.SvgError):
        svgsafe.sanitize_svg(bad)


def test_malformed_svg_is_never_emitted_raw(tmp_path):
    broken = tmp_path / "broken.svg"
    broken.write_text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>')  # unclosed
    result = run(broken, 90000)
    assert result["svg"] is None or "script" not in result["svg"]
    assert result["tier"] != "rich"


def test_oversized_svg_falls_back_to_a_quicklook_thumbnail(media, need_quicklook):
    result = run(media["bigsvg"], 8000)
    assert result["tier"] == "reduced"
    assert "<image" in result["svg"] or "<rect" in result["svg"]
    assert "<circle" not in result["svg"]


# --- pdf / documents --------------------------------------------------------------


def test_pdf_thumbnail(media, need_quicklook):
    result = run(media["pdf"], 90000)
    assert result["kind"] == "pdf" and result["mime"] == "application/pdf"
    assert result["tier"] == "rich" and "data:image/jpeg;base64," in result["svg"]
    assert run(media["pdf"], 600)["tier"] == "reduced"


def test_pdf_without_quicklook_is_a_card(media, monkeypatch):
    def no_ql(argv, **kwargs):
        raise tools.ToolMissing("qlmanage")

    monkeypatch.setattr(tools, "run", no_ql)
    result = run(media["pdf"], 8000)
    assert result["tier"] == "card" and result["reason"] == "unsupported"
    assert not list((cache.cache_root() / "preview").glob("*/result.json"))  # a missing tool is not cached


# --- text -----------------------------------------------------------------------------


def test_text_rich_is_first_forty_lines_fenced(media):
    result = run(media["text"], 8000)
    assert result["kind"] == "text" and result["tier"] == "rich" and result["svg"] is None
    md = result["markdown"]
    assert md.startswith("```\nline 0:") and md.endswith("\n```")
    assert md.count("\n") == 41 and "line 39:" in md and "line 40:" not in md


def test_markdown_is_passed_through_unfenced(media):
    result = run(media["markdown"], 8000)
    assert result["mime"] == "text/markdown"
    assert result["markdown"].startswith("# Heading") and "```" not in result["markdown"]


def test_text_reduced_is_first_line_and_card_when_nothing_fits(media):
    reduced = run(media["text"], 100)
    assert reduced["tier"] == "reduced" and reduced["markdown"] == "`line 0: some text that fills the file`"
    assert run(media["text"], 5)["tier"] == "card"


# --- cards and reasons --------------------------------------------------------------


@pytest.mark.parametrize(
    "name, reason",
    [
        ("missing", "missing"),
        ("empty", "unreadable"),
        ("garbage", "unreadable"),
        ("unknown", "unsupported"),
        ("dir", "unsupported"),
    ],
)
def test_card_reasons(media, name, reason):
    result = run(media[name], 8000)
    assert result["tier"] == "card" and result["reason"] == reason
    assert result["svg"] is None and result["markdown"] is None and result["clip"] is None
    assert result["label"] == media[name].name


def test_budget_card_reason(media):
    assert run(media["png"], 0)["reason"] == "budget"


def test_missing_path_keeps_a_kind_guess_from_the_extension(media):
    result = run(media["missing"], 8000)
    assert result["kind"] == "audio" and result["mime"] == "audio/wav" and result["meta"] == {}


def test_relative_path_is_resolved(media, monkeypatch):
    monkeypatch.chdir(media["text"].parent)
    result = run("notes.txt", 8000)
    assert result["tier"] == "rich" and result["label"] == "notes.txt"


def test_unreadable_permission_denied(tmp_path):
    locked = tmp_path / "locked.txt"
    locked.write_text("secret")
    locked.chmod(0)
    try:
        if os.access(locked, os.R_OK):  # running as root
            pytest.skip("permissions are not enforced for this user")
        result = run(locked, 8000)
        assert result["tier"] == "card" and result["reason"] == "unreadable"
    finally:
        locked.chmod(0o600)


# --- labels and meta hygiene ------------------------------------------------------------


@pytest.mark.parametrize("name", PREVIEWABLE)
def test_label_is_the_file_name_never_a_cache_path(media, cache_dir, name):
    result = run(media[name], 8000)
    assert result["label"] == media[name].name
    assert os.sep not in result["label"]
    assert str(cache_dir) not in result["label"]


@pytest.mark.parametrize("name", EVERYTHING)
def test_meta_is_numbers_only(media, name):
    meta = run(media[name], 8000)["meta"]
    assert all(v is None or (isinstance(v, (int, float)) and not isinstance(v, bool)) for v in meta.values()), meta


@pytest.mark.parametrize("name", ["tagged_mp3", "tagged_mp4"])
def test_container_tags_never_reach_the_output(media, name):
    tags = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format_tags", "-of", "json", str(media[name])],
        capture_output=True, check=True,
    ).stdout.decode()
    assert TAG_MARKER in tags  # the fixture really carries the planted text
    for budget in (0, 500, 8000, 90000):
        assert TAG_MARKER not in json.dumps(run(media[name], budget))


# --- cache ------------------------------------------------------------------------------


def test_second_call_is_a_cache_hit_that_runs_no_tools(media, cache_dir, monkeypatch):
    first = run(media["sine"], 8000)
    key = cache.preview_key(str(media["sine"]), media["sine"].stat().st_mtime_ns, media["sine"].stat().st_size, 8000)
    assert (cache_dir / "preview" / key / "result.json").is_file()

    def boom(*args, **kwargs):
        raise AssertionError("a cache hit must not run any host tool")

    monkeypatch.setattr(tools, "run", boom)
    assert run(media["sine"], 8000) == first


def test_cache_hit_for_images_keeps_the_thumbnail_file(media, monkeypatch):
    first = run(media["png"], 8000)
    monkeypatch.setattr(tools, "run", lambda *a, **k: pytest.fail("tool ran"))
    second = run(media["png"], 8000)
    assert second == first and os.path.exists(second["thumb"])


def test_cache_is_keyed_on_budget(media, cache_dir):
    run(media["png"], 2000)
    run(media["png"], 8000)
    assert len(list((cache_dir / "preview").glob("*/result.json"))) == 2


def test_cache_is_invalidated_when_the_file_changes(tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("first version\n")
    assert "first version" in run(f, 8000)["markdown"]
    f.write_text("second version, longer\n")
    st = f.stat()
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
    assert "second version" in run(f, 8000)["markdown"]


def test_cache_survives_a_damaged_entry(media, cache_dir):
    run(media["text"], 8000)
    (entry,) = (cache_dir / "preview").glob("*/result.json")
    entry.write_text("{not json")
    assert run(media["text"], 8000)["tier"] == "rich"


def test_unwritable_cache_is_not_fatal(media, tmp_path, monkeypatch):
    blocker = tmp_path / "file-not-dir"
    blocker.write_text("x")
    monkeypatch.setenv("CANVAS_CACHE_DIR", str(blocker / "sub"))
    result = run(media["sine"], 8000)
    assert result["tier"] == "rich" and result["clip"] is None
    assert run(media["png"], 8000)["tier"] == "rich"


# --- timeouts -----------------------------------------------------------------------------


def test_real_tool_timeout_is_enforced():
    with pytest.raises(tools.ToolTimeout):
        tools.run(["sleep", "5"], timeout=0.2)


def test_loudness_timeout_still_gives_the_waveform(media, monkeypatch):
    real = tools.run

    def slow_loudness(argv, **kwargs):
        if any("ebur128" in a for a in argv):
            raise tools.ToolTimeout("ffmpeg")
        return real(argv, **kwargs)

    monkeypatch.setattr(tools, "run", slow_loudness)
    result = run(media["sine"], 8000)
    assert result["tier"] == "rich"
    assert result["meta"]["lufs"] is None and result["meta"]["peakDb"] is None
    assert result["meta"]["duration"] == pytest.approx(1.0, abs=0.05)


def test_decode_timeout_is_a_timeout_card_and_not_cached(media, cache_dir, monkeypatch):
    real = tools.run

    def slow_decode(argv, **kwargs):
        if "s16le" in argv:
            raise tools.ToolTimeout("ffmpeg")
        return real(argv, **kwargs)

    monkeypatch.setattr(tools, "run", slow_decode)
    result = run(media["sine"], 8000)
    assert result["tier"] == "card" and result["reason"] == "timeout"
    assert not list((cache_dir / "preview").glob("*/result.json"))


def test_probe_timeout_is_a_card_not_a_crash(media, monkeypatch):
    def hang(argv, **kwargs):
        raise tools.ToolTimeout(argv[0])

    monkeypatch.setattr(tools, "run", hang)
    for name in ("sine", "mp4", "pdf", "bigsvg"):
        result = run(media[name], 8000)
        assert result["tier"] in ("reduced", "card")  # svg/pdf may still degrade gracefully
        if result["tier"] == "card":
            assert result["reason"] in ("timeout", "unsupported", "budget")


def test_unexpected_exception_is_a_card_not_a_crash(media, monkeypatch, capsys):
    def explode(ctx):
        raise RuntimeError("boom")

    monkeypatch.setitem(preview._HANDLERS, "text", explode)
    result = run(media["text"], 8000)
    assert result["tier"] == "card" and result["reason"] == "unreadable"
    assert "boom" in capsys.readouterr().err


# --- CLI ----------------------------------------------------------------------------------------


def test_cli_json_output_and_exit_code(media, capsys):
    assert preview.main([str(media["sine"]), "--budget", "8000", "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["kind"] == "audio" and out["tier"] == "rich" and len(out["svg"]) <= 8000
    assert set(out) == {"kind", "mime", "label", "meta", "svg", "clip", "markdown", "thumb", "tier", "reason"}


def test_cli_missing_file_exits_zero_with_a_card(media, capsys):
    assert preview.main([str(media["missing"]), "--budget", "500", "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["tier"] == "card" and out["reason"] == "missing"


def test_cli_human_output(media, capsys):
    assert preview.main([str(media["sine"])]) == 0
    text = capsys.readouterr().out
    assert "sine.wav" in text and "tier rich" in text and "svg:" in text


def test_cli_as_a_subprocess(media, cache_dir):
    env = {**os.environ, "CANVAS_CACHE_DIR": str(cache_dir)}
    done = subprocess.run(
        [sys.executable, "-m", "canvas_cli.preview", str(media["garbage"]), "--budget", "8000", "--json"],
        capture_output=True, env=env, check=False,
    )
    assert done.returncode == 0
    assert json.loads(done.stdout)["reason"] == "unreadable"


def test_cli_rejects_a_negative_budget(media):
    with pytest.raises(SystemExit) as exc:
        preview.main([str(media["sine"]), "--budget", "-5"])
    assert exc.value.code == 2
