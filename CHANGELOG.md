# Changelog

## 0.1.1

- README: screenshots and badges.
- `demo/setup.sh`: generates demo sounds, images and a curation set.

## 0.1.0

First public release.

- `show` tool: persistent, live-updating panes with markdown, stats, table, SVG, media and action panels; the same id updates a pane in place.
- Action buttons and timed `refresh` run commands only by name through a user-owned allowlist file (`~/.config/canvas/commands.json`, option `commandsFile`); a missing file allows nothing.
- `curate` tool: a media-curation panel for audio, images, video, SVG, PDFs, text and URLs, with keep / toss / maybe / pick / rate verdicts written to a `.curate.json` set file and handed back to Claude as a prompt.
- `/canvas` command to list and close panes.
- `canvas-preview` and `canvas-set` CLIs (Python 3.11+): deterministic previews fitted to a size budget with fallback tiers, and set-file create / show / validate.
