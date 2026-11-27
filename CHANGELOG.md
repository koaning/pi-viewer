# Changelog

## [0.1.1]

- pi shows what changed in pi-viewer under "Extension Updates" after an update, from this changelog.
- Each version is tagged (`v0.1.1`), so you can pin one with `pi install git:github.com/koaning/pi-viewer@v0.1.1`, and gets a GitHub release.

## [0.1.0]

- A live dashboard of your pi sessions in the browser: context makeup, tokens, cost, every request, a trace per turn, and tool stats.
- The session list groups by day or by project (Conductor worktrees fold into their repository), with running sessions as cards on top. One-shot sessions are hidden until you ask.
- `pi --viewer` opens the session list, and `/viewer` opens the current session. Every pi shares one background server on port 4545 (`PI_VIEWER_PORT`), which quits shortly after the last pi goes.
- Turn traces list requests and tool calls in time order, one turn open at a time. Tool inputs read as fields: bash commands tokenized, edits as before and after, code highlighted.
- Keyboard shortcuts: <kbd>⌘K</kbd> or <kbd>/</kbd> to search, <kbd>j</kbd>/<kbd>k</kbd> to move, <kbd>Enter</kbd> to open, <kbd>Esc</kbd> to go back, <kbd>?</kbd> for the list.
- Install with `pi install git:github.com/koaning/pi-viewer@release`.
