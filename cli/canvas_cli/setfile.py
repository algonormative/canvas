"""canvas-set: create, show and validate ``*.curate.json`` set files.

The set file is the source of truth for a curation session (see the canvas
design, section 1b). Verdict vocabulary: ``keep``, ``toss``, ``maybe`` (triage)
and ``pick`` (pick-one / pick-many); ``null`` means undecided. ``keep`` and
``pick`` both count as "kept/picked" in ``show``.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime

VERSION = 1
MODES = ("pick-one", "pick-many", "triage", "rate")
VERDICTS = ("keep", "toss", "maybe", "pick")
POSITIVE_VERDICTS = ("keep", "pick")
HANDOFF_VIA = ("submit", "fill")
ID_LENGTH = 8
_GLOB_CHARS = re.compile(r"[*?\[]")
_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


class SetError(Exception):
    """A user-facing problem (bad arguments, unreadable file)."""


# --- building -----------------------------------------------------------------


def _natural_key(text: str) -> list:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def expand_inputs(inputs: list[str]) -> list[str]:
    """Absolute paths (and URLs) for ``inputs``: globs expanded, order kept, duplicates dropped."""
    found: list[str] = []
    for raw in inputs:
        if _URL_RE.match(raw):
            found.append(raw)
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
    if _URL_RE.match(target):
        tail = target.rstrip("/").rsplit("/", 1)[-1]
        return tail or target
    return os.path.splitext(os.path.basename(target))[0] or os.path.basename(target)


def build_set(title: str, mode: str, targets: list[str], created_by: str | None = None) -> dict:
    """A fresh set. Item ids are a short hash of the absolute path (lengthened on collision)."""
    items = []
    used: set[str] = set()
    for target in targets:
        length = ID_LENGTH
        item_id = _short_hash(target, length)
        while item_id in used:
            length += 2
            item_id = _short_hash(target, length)
        used.add(item_id)
        item: dict = {"id": item_id}
        item["url" if _URL_RE.match(target) else "path"] = target
        item.update(label=_label_for(target), verdict=None, rating=None, note=None)
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
        if not isinstance(url, str) or not _URL_RE.match(url):
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


def load_set(path: str) -> object:
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise SetError(f"no such file: {path}") from exc
    except (OSError, UnicodeDecodeError) as exc:
        raise SetError(f"cannot read {path}: {exc}") from exc
    except ValueError as exc:
        raise SetError(f"{path} is not valid JSON: {exc}") from exc


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


# --- CLI ----------------------------------------------------------------------------


def _cmd_new(args: argparse.Namespace) -> int:
    title = args.title.strip()
    if not title:
        raise SetError("--title must not be empty")
    targets = expand_inputs(args.inputs)
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
    new.add_argument("inputs", nargs="+", metavar="PATH_OR_GLOB")
    new.set_defaults(func=_cmd_new)

    show = sub.add_parser("show", help="summarise a set: verdict counts, then kept/picked items")
    show.add_argument("file")
    show.set_defaults(func=_cmd_show)

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
        return 1


if __name__ == "__main__":
    sys.exit(main())
