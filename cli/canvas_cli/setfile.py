"""canvas-set: create, show and validate ``*.curate.json`` set files.

The set file is the source of truth for a curation session (see the canvas
design, section 1b). Verdict vocabulary: ``keep``, ``toss``, ``maybe`` (triage)
and ``pick`` (pick-one / pick-many); ``null`` means undecided. ``keep`` and
``pick`` both count as "kept/picked" in ``show``.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import glob
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import UTC, datetime

from . import cache

VERSION = 1
MODES = ("pick-one", "pick-many", "triage", "rate")
VERDICTS = ("keep", "toss", "maybe", "pick")
POSITIVE_VERDICTS = ("keep", "pick")
HANDOFF_VIA = ("submit", "fill")
CLEAR = "clear"
ID_LENGTH = 8
LABEL_LIMIT = 80
EXIT_HANDOFF = 3
EXIT_CHANGED = 4
_GLOB_CHARS = re.compile(r"[*?\[]")
# One rule for what a URL item is, shared with the canvas mod (parseSetFile, parseCurate): http or https,
# something after the scheme, and no whitespace or control character anywhere. Spelled out because Python's
# \s and JavaScript's \s differ at the edges (C0/C1 controls, U+FEFF).
_URL_RE = re.compile(r"https?://[^\s\x00-\x1f\x7f-\x9f\u2028\u2029\ufeff]+", re.IGNORECASE)


def is_url(text: object) -> bool:
    return isinstance(text, str) and _URL_RE.fullmatch(text) is not None


class SetError(Exception):
    """A user-facing problem (bad arguments, unreadable file)."""

    exit_code = 1


class HandoffRefused(SetError):
    """The set was already handed off to Claude and the request would send it again."""

    exit_code = EXIT_HANDOFF


class ChangedSinceSummary(SetError):
    """The set is not the file a hand-off was built from: what was sent no longer matches it."""

    exit_code = EXIT_CHANGED


# --- building -----------------------------------------------------------------


def _natural_key(text: str) -> list:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def expand_inputs(inputs: list[str], *, literal: bool = False) -> list[str]:
    """Absolute paths (and URLs) for ``inputs``: globs expanded, order kept, duplicates dropped.

    With ``literal`` each input is exactly one file: no ``~``, no glob, no normalising. That is the
    mode for inputs somebody else chose (the canvas mod passes the model's paths this way), where a
    pattern like ``/Users/me/Documents/*`` must not become every file in the folder.
    """
    found: list[str] = []
    for raw in inputs:
        if is_url(raw):
            found.append(raw)
            continue
        if literal:
            target = raw if os.path.isabs(raw) else os.path.join(os.getcwd(), raw)
            if os.path.isdir(target):
                raise SetError(f"{raw!r} is a directory; pass its files")
            if not os.path.isfile(target):
                raise SetError(f"no such file: {raw!r}")
            found.append(target)
            continue
        expanded = os.path.expanduser(raw)
        if _GLOB_CHARS.search(expanded) and not os.path.exists(expanded):
            matches = sorted(glob.glob(expanded, recursive=True), key=_natural_key)
            files = [m for m in matches if os.path.isfile(m)]
            if not files:
                raise SetError(f"no files match {raw!r}")
            found.extend(os.path.abspath(m) for m in files)
        elif os.path.isdir(expanded):
            raise SetError(f"{raw!r} is a directory; pass its files (for example {raw.rstrip('/')}/*)")
        elif os.path.isfile(expanded):
            found.append(os.path.abspath(expanded))
        else:
            raise SetError(f"no such file: {raw!r}")
    unique = list(dict.fromkeys(found))
    if not unique:
        raise SetError("nothing to add")
    return unique


def _short_hash(text: str, length: int) -> str:
    return hashlib.sha1(text.encode("utf-8", "surrogateescape")).hexdigest()[:length]


def _label_for(target: str) -> str:
    if is_url(target):
        tail = target.rstrip("/").rsplit("/", 1)[-1]
        return tail or target
    return os.path.splitext(os.path.basename(target))[0] or os.path.basename(target)


def _parents_of(target: str) -> list[str]:
    """The names above an item's label, outermost first: directories for a path, host and segments for a URL."""
    if is_url(target):
        parts = target.split("://", 1)[1].rstrip("/").split("/")
    else:
        parts = [p for p in target.split(os.sep) if p]
    return parts[:-1]


def _fit(prefix: str, base: str, suffix: str = "") -> str:
    """``prefix/base`` plus ``suffix``, at most LABEL_LIMIT characters: a long prefix is cut from its left, behind "…/"."""
    tail = base + suffix
    if not prefix:
        return tail
    full = f"{prefix}/{tail}"
    if len(full) <= LABEL_LIMIT:
        return full
    room = LABEL_LIMIT - 3 - len(tail)  # "…/" before the kept prefix, "/" after it
    kept = prefix[-room:].lstrip("/") if room > 0 else ""
    if kept:
        return f"\u2026/{kept}/{tail}"
    return "\u2026/" + tail[-(LABEL_LIMIT - 2) :]


def unique_labels(targets: list[str]) -> list[str]:
    """A label per target: the plain stem, unless two or more targets share it.

    Targets that share a stem each get the shortest run of parent names that tells them apart
    (``a-2026/render`` and ``b-2026/render``), one run length for the whole group. Where parents run out
    first (``x/render.png`` and ``x/render.jpg``), the later ones are numbered: ``render``, ``render (2)``.
    """
    stems = [_label_for(t) for t in targets]
    groups: dict[str, list[int]] = {}
    for index, stem in enumerate(stems):
        groups.setdefault(stem, []).append(index)
    prefixes = [""] * len(targets)
    for members in groups.values():
        if len(members) < 2:
            continue
        parents = [_parents_of(targets[i]) for i in members]
        deepest = max(len(p) for p in parents)

        def runs(depth: int, parents=parents) -> list[str]:
            return ["/".join(p[-depth:]) if depth else "" for p in parents]

        def distinct(depth: int, members=members, runs=runs) -> int:
            return len({_fit(run, stems[i]) for run, i in zip(runs(depth), members)})

        best = distinct(deepest)
        depth = next((d for d in range(1, deepest + 1) if distinct(d) == best), 0) if best > 1 else 0
        for i, run in zip(members, runs(depth)):
            prefixes[i] = run
    labels = [_fit(prefix, stem) for prefix, stem in zip(prefixes, stems)]
    reserved = set(labels)
    seen: set[str] = set()
    unique = []
    for i, label in enumerate(labels):
        if label in seen:
            n = 2
            while (label := _fit(prefixes[i], stems[i], f" ({n})")) in reserved or label in seen:
                n += 1
        seen.add(label)
        unique.append(label)
    return unique


def build_set(title: str, mode: str, targets: list[str], created_by: str | None = None) -> dict:
    """A fresh set. Item ids are a short hash of the absolute path (lengthened on collision)."""
    items = []
    used: set[str] = set()
    labels = unique_labels(targets)
    for target, label in zip(targets, labels):
        length = ID_LENGTH
        item_id = _short_hash(target, length)
        while item_id in used:
            length += 2
            item_id = _short_hash(target, length)
        used.add(item_id)
        item: dict = {"id": item_id}
        item["url" if is_url(target) else "path"] = target
        item.update(label=label, verdict=None, rating=None, note=None)
        items.append(item)
    return {
        "version": VERSION,
        "title": title,
        "mode": mode,
        "items": items,
        "done": False,
        "createdBy": created_by,
    }


# --- writing --------------------------------------------------------------------


def write_set(path: str, data: dict, *, overwrite: bool = True) -> None:
    """Atomic write: temp file in the target directory, then rename.

    With ``overwrite=False`` the final step is a hard link, which fails if the
    destination exists, so two writers cannot silently clobber each other.
    """
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".curate.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        if overwrite:
            os.replace(tmp, path)
        else:
            os.link(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def _slug(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "set"


# --- validation -------------------------------------------------------------------


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _validate_handoff(handoff: object) -> list[str]:
    if not isinstance(handoff, dict):
        return ['handoff must be an object like {"sentAt": "<ISO 8601>", "via": "submit" or "fill"}']
    errors = []
    extra = sorted(set(handoff) - {"sentAt", "via"})
    if extra:
        errors.append(f"handoff has unknown keys: {', '.join(extra)}")
    sent_at = handoff.get("sentAt")
    if not isinstance(sent_at, str):
        errors.append("handoff.sentAt must be an ISO 8601 timestamp string")
    else:
        try:
            datetime.fromisoformat(sent_at)
        except ValueError:
            errors.append(f"handoff.sentAt is not an ISO 8601 timestamp: {sent_at!r}")
    if handoff.get("via") not in HANDOFF_VIA:
        errors.append(f"handoff.via must be one of {', '.join(HANDOFF_VIA)} (got {handoff.get('via')!r})")
    return errors


def _validate_item(index: int, item: object, mode: object) -> tuple[list[str], str | None]:
    where = f"items[{index}]"
    if not isinstance(item, dict):
        return [f"{where} must be an object"], None
    errors: list[str] = []
    item_id = item.get("id")
    if not isinstance(item_id, str) or not item_id:
        errors.append(f"{where}: id must be a non-empty string")
        item_id = None
    else:
        where = f"{where} (id {item_id!r})"

    has_path, has_url = "path" in item, "url" in item
    if has_path == has_url:
        errors.append(f"{where}: needs exactly one of path or url")
    elif has_path:
        path = item["path"]
        if not isinstance(path, str) or not path:
            errors.append(f"{where}: path must be a non-empty string")
        elif not os.path.isabs(path):
            errors.append(f"{where}: path {path!r} is relative; paths must be absolute")
    else:
        url = item["url"]
        if not is_url(url):
            errors.append(f"{where}: url must be an http(s) URL")

    if "label" in item and not isinstance(item["label"], str):
        errors.append(f"{where}: label must be a string")
    verdict = item.get("verdict")
    if verdict is not None and verdict not in VERDICTS:
        errors.append(f"{where}: verdict {verdict!r} is not one of {', '.join(VERDICTS)} (or null)")
    rating = item.get("rating")
    if rating is not None:
        if not _is_int(rating) or not 1 <= rating <= 5:
            errors.append(f"{where}: rating {rating!r} must be a whole number from 1 to 5")
        elif mode != "rate":
            errors.append(f"{where}: rating is set but the set's mode is {mode!r}; ratings belong to mode 'rate'")
    note = item.get("note")
    if note is not None and not isinstance(note, str):
        errors.append(f"{where}: note must be a string or null")
    return errors, item_id


def validate_set(data: object) -> list[str]:
    """Every problem found in ``data`` as a readable message; empty means valid."""
    if not isinstance(data, dict):
        return ["the file must contain a JSON object"]
    errors: list[str] = []
    if data.get("version") != VERSION or isinstance(data.get("version"), bool):
        errors.append(f"version must be {VERSION} (got {data.get('version')!r})")
    if not isinstance(data.get("title"), str) or not data.get("title"):
        errors.append("title must be a non-empty string")
    mode = data.get("mode")
    if mode not in MODES:
        errors.append(f"mode must be one of {', '.join(MODES)} (got {mode!r})")
    if not isinstance(data.get("done"), bool):
        errors.append("done must be true or false")
    if data.get("createdBy") is not None and not isinstance(data.get("createdBy"), str):
        errors.append("createdBy must be a string or null")
    if "handoff" in data:
        errors.extend(_validate_handoff(data["handoff"]))

    items = data.get("items")
    if not isinstance(items, list):
        errors.append("items must be a list")
        return errors
    seen: dict[str, int] = {}
    for index, item in enumerate(items):
        item_errors, item_id = _validate_item(index, item, mode)
        errors.extend(item_errors)
        if item_id is not None:
            if item_id in seen:
                errors.append(f"items[{index}]: duplicate id {item_id!r} (also items[{seen[item_id]}])")
            else:
                seen[item_id] = index
    if mode == "pick-one":
        picked = [i.get("id") for i in items if isinstance(i, dict) and i.get("verdict") in POSITIVE_VERDICTS]
        if len(picked) > 1:
            errors.append(f"mode pick-one allows one pick but {len(picked)} items are picked: {', '.join(map(str, picked))}")
    return errors


# --- reading / summarising --------------------------------------------------------


def read_set(path: str) -> tuple[object, str]:
    """The parsed JSON at ``path`` and the sha256 of the very bytes it was parsed from."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
        return json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest()
    except FileNotFoundError as exc:
        raise SetError(f"no such file: {path}") from exc
    except (OSError, UnicodeDecodeError) as exc:
        raise SetError(f"cannot read {path}: {exc}") from exc
    except ValueError as exc:
        raise SetError(f"{path} is not valid JSON: {exc}") from exc


def load_set(path: str) -> object:
    return read_set(path)[0]


def _where(item: dict) -> str:
    return str(item.get("path") or item.get("url") or "")


def summarize(data: dict) -> str:
    """The human summary: counts per verdict, then who was kept/picked."""
    items = [i for i in data.get("items", []) if isinstance(i, dict)]
    mode = data.get("mode")
    state = "done" if data.get("done") else "in progress"
    plural = "item" if len(items) == 1 else "items"
    lines = [f"{data.get('title', '(untitled)')}  [{mode}]  {len(items)} {plural}, {state}"]

    counts: dict[str, int] = {}
    undecided = 0
    for item in items:
        verdict = item.get("verdict")
        if verdict is None:
            undecided += 1
        else:
            counts[str(verdict)] = counts.get(str(verdict), 0) + 1
    width = max([len(v) for v in (*counts, "undecided")])
    for verdict in (*POSITIVE_VERDICTS, "maybe", "toss", *sorted(set(counts) - set(VERDICTS))):
        if counts.get(verdict):
            lines.append(f"  {verdict.ljust(width)}  {counts[verdict]}")
    lines.append(f"  {'undecided'.ljust(width)}  {undecided}")

    for verdict, heading in (("keep", "Kept"), ("pick", "Picked")):
        chosen = [i for i in items if i.get("verdict") == verdict]
        if chosen:
            lines.append(f"{heading}:")
            lines.extend(f"  {i.get('label') or i.get('id')}  {_where(i)}" for i in chosen)
    if mode == "rate":
        rated = sorted((i for i in items if _is_int(i.get("rating"))), key=lambda i: -i["rating"])
        if rated:
            lines.append("Rated:")
            lines.extend(f"  {i['rating']}/5  {i.get('label') or i.get('id')}  {_where(i)}" for i in rated)
    handoff = data.get("handoff")
    if isinstance(handoff, dict):
        lines.append(f"Handed off: {handoff.get('sentAt')} (via {handoff.get('via')})")
    return "\n".join(lines)


# --- editing: mark, handoff, summary ---------------------------------------------------


@contextlib.contextmanager
def locked(path: str):
    """Hold an exclusive lock while one process reads, changes and rewrites ``path``.

    The rename in :func:`write_set` keeps a reader from ever seeing a torn file, but
    two writers that each read before the other wrote would still lose an update.
    The lock lives under the canvas cache root (not beside the set) and is keyed on
    the real path, so a set reached through a symlink locks the same file.
    """
    real = os.path.realpath(path)
    lock_dir = cache.cache_root() / "locks"
    name = hashlib.sha1(real.encode("utf-8", "surrogateescape")).hexdigest()
    try:
        lock_dir.mkdir(parents=True, exist_ok=True)
        fd = os.open(lock_dir / f"{name}.lock", os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as exc:
        raise SetError(f"cannot lock {path}: {exc}") from exc
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)  # closing the descriptor releases the lock


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _load_valid(path: str, shown: str | None = None) -> tuple[dict, str]:
    """The set at ``path`` as a dict with its digest, or a SetError naming what is wrong with it.

    ``shown`` is the name the person typed (``path`` may be the real file behind a link).
    """
    data, digest = read_set(path)
    errors = validate_set(data)
    if errors:
        name = shown or path
        raise SetError(f"{name} is not a valid set ({errors[0]}); run: canvas-set validate {name}")
    assert isinstance(data, dict)
    return data, digest


def _save_valid(path: str, data: dict) -> None:
    """Write ``data`` over ``path`` only if it is still a valid set afterwards."""
    errors = validate_set(data)
    if errors:
        raise SetError(f"refusing to write an invalid set: {errors[0]}")
    write_set(path, data, overwrite=True)


def counts_of(items: list[dict]) -> dict:
    """keep (keep or pick), maybe, toss, notReviewed (no verdict and no rating) and rated (any rating)."""
    counts = {"keep": 0, "maybe": 0, "toss": 0, "notReviewed": 0, "rated": 0}
    for item in items:
        if item.get("rating") is not None:
            counts["rated"] += 1
        verdict = item.get("verdict")
        if verdict in POSITIVE_VERDICTS:
            counts["keep"] += 1
        elif verdict in ("maybe", "toss"):
            counts[verdict] += 1
        elif item.get("rating") is None:
            counts["notReviewed"] += 1
    return counts


def mark_item(
    path: str,
    item_id: str,
    *,
    verdict: str | None = None,
    rating: int | None = None,
    note: str | None = None,
) -> dict:
    """Change one item of the set at ``path``; every other item is left as it was.

    ``verdict`` is one of VERDICTS or ``"clear"`` (which also drops the rating).
    A positive verdict in a pick-one set takes the pick from whichever item had it.
    Returns what changed, for the caller to redraw from.
    """
    if verdict is None and rating is None and note is None:
        raise SetError("nothing to mark: give --verdict, --rating or --note")
    if verdict is not None and verdict != CLEAR and verdict not in VERDICTS:
        raise SetError(f"verdict must be one of {', '.join((*VERDICTS, CLEAR))} (got {verdict!r})")
    if rating is not None and (not _is_int(rating) or not 1 <= rating <= 5):
        raise SetError(f"rating must be a whole number from 1 to 5 (got {rating!r})")

    # Every step below happens on the real file: a set reached through a link is edited in place, and
    # the rename in write_set must replace the file, not the link.
    real = os.path.realpath(path)
    with locked(real):
        data, _digest = _load_valid(real, path)
        items = data["items"]
        mode = data["mode"]
        target = next((i for i in items if i["id"] == item_id), None)
        if target is None:
            raise SetError(f"no item with id {item_id!r} in {path}")
        if rating is not None and mode != "rate":
            raise SetError(f"--rating is for sets in mode 'rate'; this set is {mode!r}")
        handed_off = "handoff" in data
        if verdict == "pick" and handed_off and mode != "pick-one":
            raise HandoffRefused(
                f"{path} was already handed off ({data['handoff']['sentAt']}); a pick now would not reach Claude"
            )

        before = json.dumps(items, sort_keys=True)
        cleared: list[str] = []
        if verdict == CLEAR:
            target["verdict"] = None
            target["rating"] = None
        elif verdict is not None:
            target["verdict"] = verdict
            if mode == "pick-one" and verdict in POSITIVE_VERDICTS:
                for other in items:
                    if other is not target and other.get("verdict") in POSITIVE_VERDICTS:
                        other["verdict"] = None
                        cleared.append(other["id"])
        if rating is not None:
            target["rating"] = rating
        if note is not None:
            target["note"] = note or None
        changed = json.dumps(items, sort_keys=True) != before
        if changed:
            _save_valid(real, data)

        return {
            "id": item_id,
            "verdict": target.get("verdict"),
            "rating": target.get("rating"),
            "note": target.get("note"),
            "cleared": cleared,
            "changed": changed,
            "updatedAfterHandoff": changed and handed_off,
            "counts": counts_of(items),
        }


def record_handoff(path: str, via: str, expect_digest: str | None = None) -> dict:
    """Stamp the set as handed off (and done). Refuses a second time: Claude is told once.

    With ``expect_digest`` (the digest ``summary`` printed) the stamp is refused, under the same lock
    that guards the write, if the file is no longer the one the hand-off was built from.
    """
    if via not in HANDOFF_VIA:
        raise SetError(f"--via must be one of {', '.join(HANDOFF_VIA)} (got {via!r})")
    real = os.path.realpath(path)
    with locked(real):
        data, digest = _load_valid(real, path)
        if "handoff" in data:
            raise HandoffRefused(f"{path} was already handed off ({data['handoff']['sentAt']}, via {data['handoff']['via']})")
        if expect_digest is not None and expect_digest != digest:
            raise ChangedSinceSummary(f"{path} changed since summary; run canvas-set summary again")
        data["handoff"] = {"sentAt": _now(), "via": via}
        data["done"] = True
        _save_valid(real, data)
        return data["handoff"]


def clean_text(text: object, limit: int) -> str:
    """One line, no control characters, at most ``limit`` characters (an ellipsis marks a cut)."""
    flat = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]", " ", str(text))).strip()
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "\u2026"


def quoted_label(item: dict) -> str:
    """The item's label in double quotes, 80 characters at most with the quotes, inner quotes softened."""
    inner = clean_text(item.get("label") or item.get("id") or "", LABEL_LIMIT - 2).replace('"', "'")
    return f'"{inner}"'


def summary_of(path: str) -> dict:
    """What a hand-off to Claude is built from, read fresh from the file.

    ``digest`` is the sha256 of the bytes this summary was made from: ``handoff --expect-digest``
    refuses to stamp a file that has changed since.
    """
    data, digest = _load_valid(os.path.realpath(path), path)
    items = data["items"]
    mode = data["mode"]

    def entry(item: dict) -> dict:
        return {"label": quoted_label(item), "path": clean_text(_where(item), 4096)}

    summary = {
        "file": os.path.abspath(path),
        "title": clean_text(data["title"], LABEL_LIMIT),
        "mode": mode,
        "total": len(items),
        "counts": counts_of(items),
        "kept": [entry(i) for i in items if i.get("verdict") in POSITIVE_VERDICTS],
        "rated": [],
        "done": data["done"],
        "handoff": data.get("handoff"),
        "digest": digest,
    }
    if mode == "rate":
        rated = [i for i in items if i.get("rating") is not None]
        rated.sort(key=lambda i: -i["rating"])
        summary["rated"] = [{**entry(i), "rating": i["rating"]} for i in rated]
    return summary


# --- CLI ----------------------------------------------------------------------------


def _cmd_new(args: argparse.Namespace) -> int:
    title = args.title.strip()
    if not title:
        raise SetError("--title must not be empty")
    targets = expand_inputs(args.inputs, literal=args.literal)
    data = build_set(title, args.mode, targets, args.created_by)
    if args.output == "-":
        json.dump(data, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    dest = os.path.abspath(args.output or f"{_slug(title)}.curate.json")
    try:
        write_set(dest, data, overwrite=args.force)
    except FileExistsError as exc:
        raise SetError(f"{dest} already exists; pass --force to overwrite it") from exc
    print(f"wrote {dest} ({len(data['items'])} items, {args.mode})")
    return 0


def _cmd_show(args: argparse.Namespace) -> int:
    data = load_set(args.file)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise SetError(f"{args.file} is not a set file (run: canvas-set validate {args.file})")
    print(summarize(data))
    return 0


def _cmd_mark(args: argparse.Namespace) -> int:
    result = mark_item(args.file, args.item_id, verdict=args.verdict, rating=args.rating, note=args.note)
    if args.json:
        print(json.dumps(result))
        return 0
    bits = [f"verdict={result['verdict'] or '-'}"]
    if result["rating"] is not None:
        bits.append(f"rating={result['rating']}")
    if result["note"]:
        bits.append("note set")
    print(f"marked {result['id']}: {' '.join(bits)}")
    for other in result["cleared"]:
        print(f"cleared the earlier pick {other}")
    if result["updatedAfterHandoff"]:
        print("updated-after-handoff")
    return 0


def _cmd_handoff(args: argparse.Namespace) -> int:
    handoff = record_handoff(args.file, args.via, args.expect_digest)
    print(f"handed off {os.path.abspath(args.file)} ({handoff['sentAt']}, via {handoff['via']})")
    return 0


def _cmd_summary(args: argparse.Namespace) -> int:
    if args.json:
        print(json.dumps(summary_of(args.file)))
        return 0
    return _cmd_show(args)


def _cmd_validate(args: argparse.Namespace) -> int:
    data = load_set(args.file)
    errors = validate_set(data)
    if errors:
        print(f"invalid: {args.file}", file=sys.stderr)
        for message in errors:
            print(f"  {message}", file=sys.stderr)
        return 1
    print(f"ok: {args.file} ({data['mode']}, {len(data['items'])} items)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="canvas-set", description="Create, show and validate *.curate.json set files.")
    sub = parser.add_subparsers(dest="command", required=True)

    new = sub.add_parser("new", help="write a new set from paths or globs")
    new.add_argument("--title", required=True)
    new.add_argument("--mode", required=True, choices=MODES)
    new.add_argument("--created-by", default=None, dest="created_by")
    new.add_argument("-o", "--output", default=None, help="output file ('-' for stdout); default <title-slug>.curate.json")
    new.add_argument("--force", action="store_true", help="overwrite the output file if it exists")
    new.add_argument(
        "--literal",
        action="store_true",
        help="take every input as exactly one file: no glob, no ~, no normalising (for paths somebody else chose)",
    )
    new.add_argument("inputs", nargs="+", metavar="PATH_OR_GLOB")
    new.set_defaults(func=_cmd_new)

    show = sub.add_parser("show", help="summarise a set: verdict counts, then kept/picked items")
    show.add_argument("file")
    show.set_defaults(func=_cmd_show)

    mark = sub.add_parser(
        "mark",
        help="record a verdict, rating or note on one item (read-modify-write under a lock)",
        description="Change one item of a set. --verdict clear also drops the rating. "
        "In a pick-one set a new pick clears the old one. Exit 3 when the set was already handed "
        "off and the pick would not reach Claude (a pick in pick-one is rewritten and the output "
        "says updated-after-handoff).",
    )
    mark.add_argument("file")
    mark.add_argument("item_id", metavar="ITEM_ID")
    mark.add_argument("--verdict", choices=(*VERDICTS, CLEAR))
    mark.add_argument("--rating", type=int, choices=range(1, 6), metavar="1-5")
    mark.add_argument("--note", help="free text; an empty string removes the note")
    mark.add_argument("--json", action="store_true", help="print the result as JSON")
    mark.set_defaults(func=_cmd_mark)

    handoff = sub.add_parser(
        "handoff",
        help="stamp the set as handed off to Claude (and done); exit 3 if it already was, 4 if it changed since the summary",
    )
    handoff.add_argument("file")
    handoff.add_argument("--via", required=True, choices=HANDOFF_VIA)
    handoff.add_argument(
        "--expect-digest",
        dest="expect_digest",
        default=None,
        help="the digest from 'summary --json'; refuse (exit 4, 'changed since summary') if the file is no longer that one",
    )
    handoff.set_defaults(func=_cmd_handoff)

    summary = sub.add_parser(
        "summary",
        help="what a hand-off is built from: counts, kept or picked items, ratings (read fresh from the file)",
    )
    summary.add_argument("file")
    summary.add_argument("--json", action="store_true", help="print the summary as JSON")
    summary.set_defaults(func=_cmd_summary)

    check = sub.add_parser("validate", help="check a set file; non-zero exit with messages if invalid")
    check.add_argument("file")
    check.set_defaults(func=_cmd_validate)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except SetError as exc:
        print(f"canvas-set: {exc}", file=sys.stderr)
        return exc.exit_code


if __name__ == "__main__":
    sys.exit(main())
