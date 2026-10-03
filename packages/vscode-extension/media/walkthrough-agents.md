# Claude Code and Codex

1. Run **QMD Notebook: Configure Claude Code / Codex MCP Access** and choose **User level** for
   access across projects. It registers the companion, adds notebook rules, and installs Claude's
   `/focus-notebook` command and Codex's `$focus-notebook` skill. The Codex skill is also installed
   automatically when the extension activates, in `~/.agents/skills/focus-notebook/`.
2. In the agent (sidebar or terminal) type `/mcp__qmd-notebook__focus_notebook analysis.qmd`
   (Claude Code) or `$focus-notebook analysis.qmd` (Codex). The status bar shows `<agent> watching`.
3. Comment in the notebook: select text and press `Ctrl+Alt+A`, use the comment icon in a cell's
   toolbar, or `Ctrl+Alt+O` for an output. Type in the box under the cell and press Send.
   The watching agent picks it up, posts its plan and reply into the same thread, edits and runs the
   cell through the live kernel, and the cell shows `●` / `○` dots for open / resolved comments.

Nothing is copied between surfaces, and comments never enter the `.qmd`.
