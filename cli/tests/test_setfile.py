from __future__ import annotations

import copy
import hashlib
import json
import os

import pytest

from canvas_cli import setfile


@pytest.fixture
def samples(tmp_path):
    """Three kick files plus one snare, in a directory of their own."""
    d = tmp_path / "samples"
    d.mkdir()
    for name in ("kick-2.wav", "kick-10.wav", "kick-1.wav", "snare.wav"):
        (d / name).write_bytes(b"RIFF")
    return d


def new(args):
    return setfile.main(["new", *args])


@pytest.fixture
def valid_set(samples, tmp_path):
    out = tmp_path / "s.curate.json"
    assert new(["--title", "Kicks", "--mode", "triage", "-o", str(out), str(samples / "kick-1.wav"), str(samples / "snare.wav")]) == 0
    return json.loads(out.read_text())


def write(tmp_path, data, name="x.curate.json"):
    path = tmp_path / name
    path.write_text(json.dumps(data))
    return str(path)


def problems(tmp_path, data, capsys):
    """Run `validate` on data; return (exit code, stderr text)."""
    capsys.readouterr()
    code = setfile.main(["validate", write(tmp_path, data)])
    return code, capsys.readouterr().err


# --- new -----------------------------------------------------------------------------


def test_new_writes_a_valid_set_with_absolute_paths_and_stable_ids(samples, tmp_path, capsys):
    out = tmp_path / "kicks.curate.json"
    code = new(["--title", "Kick candidates", "--mode", "triage", "--created-by", "music-sample-gen",
                "-o", str(out), str(samples / "kick-1.wav"), str(samples / "kick-2.wav")])
    assert code == 0
    assert "wrote" in capsys.readouterr().out
    data = json.loads(out.read_text())
    assert data["version"] == 1 and data["title"] == "Kick candidates" and data["mode"] == "triage"
    assert data["done"] is False and data["createdBy"] == "music-sample-gen"
    assert "handoff" not in data
    first = data["items"][0]
    assert first == {
        "id": hashlib.sha1(str(samples / "kick-1.wav").encode()).hexdigest()[:8],
        "path": str(samples / "kick-1.wav"),
        "label": "kick-1",
        "verdict": None, "rating": None, "note": None,
    }
    assert all(os.path.isabs(i["path"]) for i in data["items"])
    assert setfile.validate_set(data) == []
    assert setfile.main(["validate", str(out)]) == 0


def test_ids_are_stable_across_runs_and_independent_of_order(samples, tmp_path):
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    paths = [str(samples / "kick-1.wav"), str(samples / "snare.wav")]
    new(["--title", "T", "--mode", "pick-one", "-o", str(a), *paths])
    new(["--title", "Other title", "--mode", "rate", "-o", str(b), *reversed(paths)])

    def ids(f):
        return {i["path"]: i["id"] for i in json.loads(f.read_text())["items"]}

    assert ids(a) == ids(b)


def test_globs_are_expanded_naturally_sorted_and_deduplicated(samples, tmp_path):
    out = tmp_path / "g.json"
    # the glob (quoted, as a shell would pass it when unexpanded) plus an explicit repeat
    assert new(["--title", "T", "--mode", "triage", "-o", str(out), str(samples / "kick-*.wav"), str(samples / "kick-2.wav")]) == 0
    labels = [i["label"] for i in json.loads(out.read_text())["items"]]
    assert labels == ["kick-1", "kick-2", "kick-10"]


def test_relative_inputs_are_stored_absolute(samples, tmp_path, monkeypatch):
    monkeypatch.chdir(samples)
    assert new(["--title", "T", "--mode", "triage", "-o", str(tmp_path / "r.json"), "snare.wav", "./kick-1.wav"]) == 0
    paths = [i["path"] for i in json.loads((tmp_path / "r.json").read_text())["items"]]
    assert paths == [str(samples / "snare.wav"), str(samples / "kick-1.wav")]


def test_url_inputs_become_url_items(samples, tmp_path):
    out = tmp_path / "u.json"
    assert new(["--title", "T", "--mode", "pick-one", "-o", str(out), "https://example.com/a/b.png", str(samples / "snare.wav")]) == 0
    data = json.loads(out.read_text())
    assert data["items"][0]["url"] == "https://example.com/a/b.png" and "path" not in data["items"][0]
    assert setfile.validate_set(data) == []


def labels_of(*targets):
    return [item["label"] for item in setfile.build_set("T", "pick-one", list(targets))["items"]]


def test_two_files_with_the_same_stem_in_different_folders_are_told_apart_by_their_folder(tmp_path, capsys):
    # the live finding: both were labelled "render", so the pane and the hand-off could not tell them apart
    first = tmp_path / "breach-tarot-2026-10-08-vii-chariot" / "render.png"
    second = tmp_path / "phase-garden-2026-10-05-cathedral-c004" / "render.png"
    for f in (first, second):
        f.parent.mkdir()
        f.write_bytes(b"x")
    out = tmp_path / "c.curate.json"
    assert new(["--title", "T", "--mode", "pick-one", "-o", str(out), str(first), str(second)]) == 0
    data = json.loads(out.read_text())
    assert [i["label"] for i in data["items"]] == [
        "breach-tarot-2026-10-08-vii-chariot/render",
        "phase-garden-2026-10-05-cathedral-c004/render",
    ]
    assert setfile.validate_set(data) == []


def test_a_three_way_collision_goes_up_as_many_folders_as_it_takes(tmp_path):
    # x/render twice: one folder is not enough, so the whole group takes two
    labels = labels_of("/r/a/x/render.png", "/r/b/x/render.png", "/r/c/y/render.png")
    assert labels == ["a/x/render", "b/x/render", "c/y/render"]


def test_the_shortest_run_that_works_is_used_and_short_paths_use_what_they_have():
    assert labels_of("/m/n/render.png", "/o/p/render.png") == ["n/render", "p/render"]
    assert labels_of("/x/render.png", "/a/x/render.png") == ["x/render", "a/x/render"]


def test_a_stem_that_is_not_shared_stays_plain():
    labels = labels_of("/r/a/render.png", "/r/b/render.png", "/r/c/snare.png")
    assert labels == ["a/render", "b/render", "snare"]


def test_nothing_changes_when_no_stem_repeats():
    assert labels_of("/r/a/kick.wav", "/r/b/snare.wav") == ["kick", "snare"]


def test_url_items_use_their_host_and_path_segments():
    labels = labels_of("https://a.example/x/1/img.png", "https://b.example/x/1/img.png", "https://a.example/other.png")
    assert labels == ["a.example/x/1/img.png", "b.example/x/1/img.png", "other.png"]
    assert labels_of("https://a.example/x/img.png", "https://a.example/y/img.png") == ["x/img.png", "y/img.png"]


def test_a_url_and_a_file_with_the_same_name_are_told_apart():
    assert labels_of("/r/a/img.png", "https://h.example/img") == ["a/img", "h.example/img"]
    # a URL label keeps its extension, a file label does not: these two never collided
    assert labels_of("/r/a/img.png", "https://h.example/img.png") == ["img", "img.png"]


def test_the_same_stem_in_one_folder_is_numbered_when_folders_cannot_help():
    # render.png / render.jpg / render.webp: different paths, identical folders
    assert labels_of("/d/render.png", "/d/render.jpg", "/d/render.webp") == ["render", "render (2)", "render (3)"]


def test_folders_and_numbers_combine_and_numbering_skips_a_label_already_in_the_set():
    assert labels_of("/a/x/render.png", "/a/x/render.jpg", "/b/x/render.png") == ["a/x/render", "a/x/render (2)", "b/x/render"]
    assert labels_of("/d/render.png", "/d/render (2).png", "/d/render.jpg") == ["render", "render (2)", "render (3)"]
    assert labels_of("/d/render.png", "/d/render.jpg", "/d/render (2).png") == ["render", "render (3)", "render (2)"]


def test_long_folder_names_are_cut_from_the_left_to_fit_eighty_characters():
    long_a, long_b = "a" * 120 + "-alpha", "b" * 120 + "-beta"
    labels = labels_of(f"/r/{long_a}/render.png", f"/r/{long_b}/render.png", "/r/short/snare.png")
    for label in labels[:2]:
        assert len(label) <= setfile.LABEL_LIMIT and label.startswith("\u2026/") and label.endswith("/render")
    assert labels[0].endswith("-alpha/render") and labels[1].endswith("-beta/render") and labels[0] != labels[1]
    assert labels[2] == "snare"
    # numbered duplicates stay inside the limit too
    numbered = labels_of(f"/r/{long_a}/render.png", f"/r/{long_a}/render.jpg", f"/q/{long_a}/render.png")
    assert all(len(label) <= setfile.LABEL_LIMIT for label in numbered) and len(set(numbered)) == 3


def test_labels_are_always_unique_whatever_the_layout():
    import itertools
    import random

    rng = random.Random(7)
    names, stems, exts = ["a", "b", "x"], ["render", "r"], [".png", ".jpg"]
    for _ in range(300):
        pool = ["/" + "/".join(parents) + "/" + stem + ext
                for parents in itertools.chain.from_iterable(itertools.product(names, repeat=n) for n in (1, 2, 3))
                for stem in stems for ext in exts]
        paths = rng.sample(pool, rng.randint(2, 12))
        labels = labels_of(*paths)
        assert len(set(labels)) == len(labels), (paths, labels)


def test_literal_takes_the_paths_as_given_and_never_expands_a_glob(samples, tmp_path, capsys):
    out = tmp_path / "lit.json"
    star = str(samples / "kick-*.wav")
    # without --literal the pattern expands to the three kicks; with it, it is a file name that is not there
    assert new(["--title", "T", "--mode", "triage", "-o", str(out), "--literal", star]) == 1
    assert "no such file" in capsys.readouterr().err and not out.exists()
    # a file that really has a glob character in its name is taken as it is, and only it
    odd = samples / "odd[1]*.wav"
    odd.write_bytes(b"RIFF")
    assert new(["--title", "T", "--mode", "triage", "-o", str(out), "--literal", str(odd)]) == 0
    assert [i["path"] for i in json.loads(out.read_text())["items"]] == [str(odd)]


def test_literal_does_not_expand_a_home_directory_or_a_directory_of_files(samples, tmp_path, capsys):
    out = tmp_path / "lit.json"
    assert new(["--title", "T", "--mode", "triage", "-o", str(out), "--literal", "~/anything.wav"]) == 1
    assert "no such file" in capsys.readouterr().err
    assert new(["--title", "T", "--mode", "triage", "-o", str(out), "--literal", str(samples)]) == 1
    assert "directory" in capsys.readouterr().err
    assert not out.exists()


def test_literal_keeps_the_path_exactly_as_given_and_still_takes_urls(samples, tmp_path):
    out = tmp_path / "lit.json"
    unnormalised = f"{samples}/../samples/snare.wav"
    assert new(["--title", "T", "--mode", "triage", "-o", str(out), "--literal", unnormalised, "https://example.com/x.png"]) == 0
    items = json.loads(out.read_text())["items"]
    assert items[0]["path"] == unnormalised and items[1]["url"] == "https://example.com/x.png"


def test_without_literal_a_glob_is_still_expanded(samples, tmp_path):
    out = tmp_path / "g2.json"
    assert new(["--title", "T", "--mode", "triage", "-o", str(out), str(samples / "kick-*.wav")]) == 0
    assert len(json.loads(out.read_text())["items"]) == 3


#: Strings the CLI and the mod must both call a URL, and both must refuse. tests/ in the mod hold the same table.
URLS_OK = ["https://example.com/a.png", "http://x", "HTTPS://EXAMPLE.COM/A", "https://example.com/a%20b?q=1#frag"]
URLS_BAD = [
    "https://", "http://", "https:// a", "https://a b", "https://a\tb", "https://a\nb", "https://a\n", "https://a\u00a0b",
    "https://a\u2028b", "https://a\x85b", "https://a\x07b", "ftp://x", "file:///etc/passwd", "javascript:alert(1)", "//x.example/a", "https:/x", "",
]


@pytest.mark.parametrize("url", URLS_OK)
def test_a_url_is_http_or_https_with_something_after_it(valid_set, tmp_path, capsys, url):
    data = copy.deepcopy(valid_set)
    del data["items"][0]["path"]
    data["items"][0]["url"] = url
    code, err = problems(tmp_path, data, capsys)
    assert code == 0, err


@pytest.mark.parametrize("url", URLS_BAD)
def test_validate_rejects_a_url_with_whitespace_or_another_scheme(valid_set, tmp_path, capsys, url):
    data = copy.deepcopy(valid_set)
    del data["items"][0]["path"]
    data["items"][0]["url"] = url
    code, err = problems(tmp_path, data, capsys)
    assert code == 1 and "url must be an http(s) URL" in err


@pytest.mark.parametrize("url", URLS_BAD[:-1])
def test_new_does_not_take_such_a_string_for_a_url(samples, tmp_path, capsys, url):
    out = tmp_path / "bad.json"
    assert new(["--title", "T", "--mode", "triage", "-o", str(out), "--literal", url]) == 1
    assert "no such file" in capsys.readouterr().err and not out.exists()


def test_default_output_is_a_slug_in_the_working_directory(samples, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert new(["--title", "My Kick Set!", "--mode", "triage", str(samples / "snare.wav")]) == 0
    assert (tmp_path / "my-kick-set.curate.json").is_file()


def test_output_dash_prints_the_set(samples, capsys):
    assert new(["--title", "T", "--mode", "triage", "-o", "-", str(samples / "snare.wav")]) == 0
    assert json.loads(capsys.readouterr().out)["title"] == "T"


@pytest.mark.parametrize(
    "args, message",
    [
        (["/nonexistent/file.wav"], "no such file"),
        (["/nonexistent/*.wav"], "no files match"),
        ([None], "directory"),
    ],
)
def test_new_reports_bad_inputs_without_writing(samples, tmp_path, capsys, args, message):
    out = tmp_path / "never.json"
    args = [str(samples) if a is None else a for a in args]
    assert new(["--title", "T", "--mode", "triage", "-o", str(out), *args]) == 1
    assert message in capsys.readouterr().err
    assert not out.exists()


def test_new_rejects_a_bad_mode(samples):
    with pytest.raises(SystemExit) as exc:
        new(["--title", "T", "--mode", "shuffle", str(samples / "snare.wav")])
    assert exc.value.code == 2


def test_new_refuses_to_overwrite_without_force(samples, tmp_path, capsys):
    out = tmp_path / "keep.curate.json"
    args = ["--title", "First", "--mode", "triage", "-o", str(out), str(samples / "snare.wav")]
    assert new(args) == 0
    original = out.read_text()
    # a verdict recorded since must survive a careless re-run
    data = json.loads(original)
    data["items"][0]["verdict"] = "keep"
    out.write_text(json.dumps(data))
    kept = out.read_text()

    capsys.readouterr()
    assert new(["--title", "Second", "--mode", "triage", "-o", str(out), str(samples / "snare.wav")]) == 1
    err = capsys.readouterr().err
    assert "already exists" in err and "--force" in err
    assert out.read_text() == kept
    assert [p.name for p in tmp_path.iterdir() if p.name.startswith(".curate.")] == []  # no temp litter

    assert new(["--force", "--title", "Second", "--mode", "triage", "-o", str(out), str(samples / "snare.wav")]) == 0
    assert json.loads(out.read_text())["title"] == "Second"


def test_default_output_also_refuses_to_overwrite(samples, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    args = ["--title", "Same", "--mode", "triage", str(samples / "snare.wav")]
    assert new(args) == 0
    assert new(args) == 1


def test_write_set_is_atomic_and_leaves_no_temp_files(tmp_path):
    target = tmp_path / "a.curate.json"
    setfile.write_set(str(target), {"ok": 1})
    assert json.loads(target.read_text()) == {"ok": 1}
    with pytest.raises(TypeError):  # not JSON-serialisable: the write fails part-way
        setfile.write_set(str(target), {"bad": object()})
    assert json.loads(target.read_text()) == {"ok": 1}  # the original is untouched
    assert sorted(p.name for p in tmp_path.iterdir()) == ["a.curate.json"]


# --- validate ------------------------------------------------------------------------------


def test_validate_accepts_a_fresh_set_in_every_mode(samples, tmp_path):
    for mode in setfile.MODES:
        out = tmp_path / f"{mode}.json"
        new(["--title", "T", "--mode", mode, "-o", str(out), str(samples / "snare.wav")])
        assert setfile.main(["validate", str(out)]) == 0


@pytest.mark.parametrize(
    "mutate, expect",
    [
        (lambda d: d.update(version=2), "version must be 1"),
        (lambda d: d.update(version=True), "version must be 1"),
        (lambda d: d.pop("version"), "version must be 1"),
        (lambda d: d.update(mode="shuffle"), "mode must be one of"),
        (lambda d: d.update(title=""), "title"),
        (lambda d: d.update(done="no"), "done"),
        (lambda d: d.update(items="x"), "items must be a list"),
        (lambda d: d["items"][1].update(id=d["items"][0]["id"]), "duplicate id"),
        (lambda d: d["items"][0].update(path="kick.wav"), "relative"),
        (lambda d: d["items"][0].update(path="~/kick.wav"), "relative"),
        (lambda d: d["items"][0].pop("path"), "exactly one of path or url"),
        (lambda d: d["items"][0].update(url="https://x.example/a"), "exactly one of path or url"),
        (lambda d: d["items"][0].update(verdict="love"), "verdict"),
        (lambda d: d["items"][0].update(rating=3), "ratings belong to mode 'rate'"),
        (lambda d: d["items"][0].update(note=5), "note"),
        (lambda d: d["items"].append("nope"), "must be an object"),
    ],
)
def test_validate_rejects(valid_set, tmp_path, capsys, mutate, expect):
    data = copy.deepcopy(valid_set)
    mutate(data)
    code, err = problems(tmp_path, data, capsys)
    assert code == 1
    assert "invalid:" in err and expect in err


@pytest.mark.parametrize("rating", [0, 6, -1, 2.5, "4", True])
def test_validate_rejects_ratings_outside_one_to_five(valid_set, tmp_path, capsys, rating):
    data = copy.deepcopy(valid_set)
    data["mode"] = "rate"
    data["items"][0]["rating"] = rating
    code, err = problems(tmp_path, data, capsys)
    assert code == 1 and "from 1 to 5" in err


@pytest.mark.parametrize("rating", [1, 3, 5])
def test_validate_accepts_ratings_one_to_five_on_a_rate_set(valid_set, tmp_path, capsys, rating):
    data = copy.deepcopy(valid_set)
    data["mode"] = "rate"
    data["items"][0]["rating"] = rating
    assert problems(tmp_path, data, capsys) == (0, "")


def test_validate_rejects_two_picks_in_pick_one(valid_set, tmp_path, capsys):
    data = copy.deepcopy(valid_set)
    data["mode"] = "pick-one"
    for item in data["items"]:
        item["verdict"] = "pick"
    code, err = problems(tmp_path, data, capsys)
    assert code == 1 and "pick-one" in err


def test_validate_reports_every_problem_at_once(valid_set, tmp_path, capsys):
    data = copy.deepcopy(valid_set)
    data["version"] = 9
    data["mode"] = "nope"
    data["items"][0]["path"] = "rel.wav"
    code, err = problems(tmp_path, data, capsys)
    assert code == 1 and err.count("\n") >= 4  # header plus three messages


def test_validate_names_the_offending_item(valid_set, tmp_path, capsys):
    data = copy.deepcopy(valid_set)
    data["items"][1]["path"] = "rel.wav"
    _, err = problems(tmp_path, data, capsys)
    assert f"items[1] (id {data['items'][1]['id']!r})" in err


def test_validate_bad_files(tmp_path, capsys):
    capsys.readouterr()
    assert setfile.main(["validate", str(tmp_path / "missing.json")]) == 1
    assert "no such file" in capsys.readouterr().err
    broken = tmp_path / "broken.json"
    broken.write_text("{nope")
    assert setfile.main(["validate", str(broken)]) == 1
    assert "not valid JSON" in capsys.readouterr().err
    arr = tmp_path / "arr.json"
    arr.write_text("[]")
    assert setfile.main(["validate", str(arr)]) == 1
    assert "JSON object" in capsys.readouterr().err


# --- handoff --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "handoff",
    [
        {"sentAt": "2026-10-10T12:00:00.000Z", "via": "submit"},
        {"sentAt": "2026-10-10T12:00:00+02:00", "via": "fill"},
        {"sentAt": "2026-10-10T12:00:00", "via": "submit"},
    ],
)
def test_validate_accepts_a_handoff_object(valid_set, tmp_path, capsys, handoff):
    data = {**valid_set, "handoff": handoff}
    assert problems(tmp_path, data, capsys) == (0, "")


@pytest.mark.parametrize(
    "handoff, expect",
    [
        ("2026-10-10T12:00:00Z", "handoff must be an object"),
        (None, "handoff must be an object"),
        ([], "handoff must be an object"),
        (True, "handoff must be an object"),
        ({}, "handoff.sentAt"),
        ({"via": "submit"}, "handoff.sentAt"),
        ({"sentAt": "2026-10-10T12:00:00Z"}, "handoff.via"),
        ({"sentAt": "2026-10-10T12:00:00Z", "via": "append"}, "handoff.via"),
        ({"sentAt": "2026-10-10T12:00:00Z", "via": None}, "handoff.via"),
        ({"sentAt": "yesterday", "via": "fill"}, "not an ISO 8601"),
        ({"sentAt": 1760000000, "via": "fill"}, "handoff.sentAt must be"),
        ({"sentAt": "2026-10-10T12:00:00Z", "via": "fill", "by": "me"}, "unknown keys: by"),
    ],
)
def test_validate_rejects_other_handoff_shapes(valid_set, tmp_path, capsys, handoff, expect):
    code, err = problems(tmp_path, {**valid_set, "handoff": handoff}, capsys)
    assert code == 1 and expect in err


# --- show -------------------------------------------------------------------------------------


def test_show_counts_per_verdict_then_lists_kept(valid_set, tmp_path, samples, capsys):
    data = copy.deepcopy(valid_set)
    kick = data["items"][0]
    data["items"].append({"id": "x3", "path": str(samples / "kick-2.wav"), "label": "kick-2",
                          "verdict": "toss", "rating": None, "note": None})
    data["items"].append({"id": "x4", "path": str(samples / "kick-10.wav"), "label": "kick-10",
                          "verdict": "maybe", "rating": None, "note": None})
    kick["verdict"] = "keep"
    path = write(tmp_path, data)
    capsys.readouterr()
    assert setfile.main(["show", path]) == 0
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert lines[0].startswith("Kicks") and "[triage]" in lines[0] and "4 items" in lines[0] and "in progress" in lines[0]
    counts = {line.split()[0]: int(line.split()[1]) for line in lines[1:5]}
    assert counts == {"keep": 1, "maybe": 1, "toss": 1, "undecided": 1}
    assert out.index("keep") < out.index("Kept:")
    kept_block = out.split("Kept:")[1]
    assert f"kick-1  {kick['path']}" in kept_block
    assert "kick-2" not in kept_block and "kick-10" not in kept_block  # tossed/maybe are counted, not listed


def test_show_lists_picked_and_done_state(valid_set, tmp_path, capsys):
    data = copy.deepcopy(valid_set)
    data["mode"], data["done"] = "pick-one", True
    data["items"][1]["verdict"] = "pick"
    path = write(tmp_path, data)
    capsys.readouterr()
    assert setfile.main(["show", path]) == 0
    out = capsys.readouterr().out
    assert "done" in out.splitlines()[0] and "Picked:" in out and "snare" in out.split("Picked:")[1]


def test_show_rate_mode_lists_ratings_best_first(valid_set, tmp_path, capsys):
    data = copy.deepcopy(valid_set)
    data["mode"] = "rate"
    data["items"][0]["rating"], data["items"][1]["rating"] = 2, 5
    path = write(tmp_path, data)
    capsys.readouterr()
    setfile.main(["show", path])
    rated = capsys.readouterr().out.split("Rated:")[1].strip().splitlines()
    assert rated[0].split()[:2] == ["5/5", "snare"] and rated[1].split()[:2] == ["2/5", "kick-1"]


def test_show_mentions_a_handoff(valid_set, tmp_path, capsys):
    data = {**valid_set, "handoff": {"sentAt": "2026-10-10T12:00:00Z", "via": "submit"}}
    path = write(tmp_path, data)
    capsys.readouterr()
    setfile.main(["show", path])
    assert "Handed off: 2026-10-10T12:00:00Z (via submit)" in capsys.readouterr().out


def test_show_on_a_non_set_fails_cleanly(tmp_path, capsys):
    path = write(tmp_path, {"hello": "world"})
    capsys.readouterr()
    assert setfile.main(["show", path]) == 1
    assert "not a set file" in capsys.readouterr().err


# --- symlinked output and file mode --------------------------------------------------


def test_new_force_through_a_symlink_writes_the_real_file_and_keeps_the_link(samples, tmp_path):
    real = tmp_path / "real.curate.json"
    assert new(["--title", "Old", "--mode", "triage", "-o", str(real), str(samples / "snare.wav")]) == 0
    link = tmp_path / "link.curate.json"
    link.symlink_to(real)
    assert new(["--title", "New", "--mode", "triage", "-o", str(link), "--force", str(samples / "snare.wav")]) == 0
    assert link.is_symlink() and os.readlink(link) == str(real)
    assert json.loads(real.read_text())["title"] == "New"


def test_write_set_keeps_the_existing_file_mode(tmp_path):
    path = tmp_path / "m.curate.json"
    path.write_text("{}")
    path.chmod(0o644)
    setfile.write_set(str(path), {"a": 1})
    assert (path.stat().st_mode & 0o7777) == 0o644
    fresh = tmp_path / "fresh.curate.json"
    setfile.write_set(str(fresh), {"a": 1})
    assert (fresh.stat().st_mode & 0o7777) == 0o600
