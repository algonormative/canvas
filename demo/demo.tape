# Records the terminal demo: vhs demo/demo.tape
# Needs a logged-in `claude` with canvas installed and its CLI on PATH.
# DEMO_SET is a curation set (demo/setup.sh prints one); DEMO_SETTINGS
# optionally points at a settings file that turns other plugins off.
Output demo/terminal.gif
Require claude
Set Shell bash
Set FontSize 15
Set Width 1600
Set Height 1100
Set Padding 24
Set Framerate 12
Set PlaybackSpeed 2
Set TypingSpeed 25ms
Set Theme "Catppuccin Mocha"

Hide
Type 'unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE CLAUDE_CODE_ENTRYPOINT; cd "$(dirname "$DEMO_SET")" && clear && claude ${DEMO_SETTINGS:+--settings "$DEMO_SETTINGS"} --strict-mcp-config --allowedTools "mcp__canvas__curate mcp__canvas__show" 2>/dev/null'
Enter
Sleep 6s
# Answer the folder-trust question (its default is No) if it appears.
Down
Enter
Sleep 10s
Show

Type "Open demo.curate.json in this folder for me to curate."
Sleep 500ms
Enter
Sleep 20s
Screenshot demo/terminal-curate.png
Sleep 4s
Type "/exit"
Enter
Sleep 2s
