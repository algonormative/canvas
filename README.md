# canvas

A Claude Code mod that lets Claude open persistent, live-updating panes beside the chat,
plus a media-curation panel for any set of audio, images, video, SVG or documents.

- `mod/`: the Claude Code mod (function hooks). Symlinked into `~/.claude/mods/canvas`.
- `cli/`: `canvas-preview` and `canvas-set`, the deterministic media substrate the mod renders.

Design: `~/git/vault/active/claude-mods/design.md`.

## Install

The repo is its own Claude Code marketplace (`.claude-plugin/marketplace.json` → `./mod`):

```sh
claude plugin marketplace add ~/git/canvas
claude plugin install canvas@canvas --scope user
```

A local folder marketplace is read live, so edits to `mod/` take effect on `/reload-plugins`.
Put the CLIs on PATH with `~/git/vault/scripts/install-tools.sh` (they are registered there).
