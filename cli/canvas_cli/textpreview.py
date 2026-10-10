"""Text and Markdown previews: the head of the file as a Markdown string."""

from __future__ import annotations

import re

from . import kinds

HEAD_BYTES = 64 * 1024
RICH_LINES = 40
MAX_LINE_CHARS = 200
REDUCED_CHARS = 120


class NotText(Exception):
    """The file is binary or not valid text."""


def read_head(path: str) -> str:
    with open(path, "rb") as handle:
        head = handle.read(HEAD_BYTES)
    if not kinds.looks_like_text(head):
        raise NotText(path)
    return head.decode("utf-8", errors="replace")


def _clip(line: str, limit: int) -> str:
    line = line.rstrip()
    return line if len(line) <= limit else line[: limit - 1] + "…"


def _fence(body: str) -> str:
    longest = max((len(m) for m in re.findall(r"`+", body)), default=0)
    ticks = "`" * max(3, longest + 1)
    return f"{ticks}\n{body}\n{ticks}"


def rich_markdown(text: str, is_markdown: bool) -> str:
    lines = [_clip(line, MAX_LINE_CHARS) for line in text.splitlines()[:RICH_LINES]]
    body = "\n".join(lines)
    return body if is_markdown else _fence(body)


def reduced_markdown(text: str, is_markdown: bool, budget: int) -> str | None:
    """The first non-blank line, trimmed to fit ``budget``; ``None`` if nothing useful fits."""
    first = next((line.strip() for line in text.splitlines() if line.strip()), "")
    if not first:
        return None
    limit = min(REDUCED_CHARS, budget)
    if limit < 8:
        return None
    if is_markdown:
        return _clip(first, limit)
    return "`" + _clip(first.replace("`", "'"), limit - 2) + "`"
