"""Host tool lookup and a bounded subprocess runner.

Every external tool runs through :func:`run`: argv lists only (never a shell),
stdin closed, a hard timeout. Callers catch :class:`ToolTimeout`,
:class:`ToolMissing` and :class:`ToolFailed` and degrade to the next tier.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass

TIMEOUT_SECONDS = 30

# The mod launches us through $.process.run, which may not carry Homebrew on PATH.
_EXTRA_DIRS = ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin")


class ToolError(Exception):
    """Base class: a host tool could not do its job."""


class ToolMissing(ToolError):
    """The executable is not installed."""


class ToolTimeout(ToolError):
    """The executable ran past its time limit and was killed."""


class ToolFailed(ToolError):
    """The executable exited non-zero (stderr is kept for diagnostics)."""

    def __init__(self, argv: list[str], returncode: int, stderr: bytes):
        super().__init__(f"{os.path.basename(argv[0])} exited {returncode}")
        self.returncode = returncode
        self.stderr = stderr


@dataclass
class Result:
    stdout: bytes
    stderr: bytes
    returncode: int


def find_tool(name: str) -> str:
    """Absolute path to ``name`` or raise :class:`ToolMissing`."""
    found = shutil.which(name)
    if found:
        return found
    for directory in _EXTRA_DIRS:
        candidate = os.path.join(directory, name)
        if os.access(candidate, os.X_OK):
            return candidate
    raise ToolMissing(name)


def run(
    argv: list[str],
    *,
    timeout: float = TIMEOUT_SECONDS,
    check: bool = True,
) -> Result:
    """Run ``argv`` (argv[0] is a bare tool name) and capture its output."""
    full = [find_tool(argv[0]), *argv[1:]]
    try:
        proc = subprocess.run(
            full,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ToolTimeout(os.path.basename(full[0])) from exc
    except FileNotFoundError as exc:
        raise ToolMissing(argv[0]) from exc
    except OSError as exc:
        raise ToolFailed(full, -1, str(exc).encode()) from exc
    if check and proc.returncode != 0:
        raise ToolFailed(full, proc.returncode, proc.stderr)
    return Result(proc.stdout, proc.stderr, proc.returncode)
