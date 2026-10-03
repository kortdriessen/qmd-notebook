# Changelog

## Unreleased

- Automatically install the user-wide Codex `$focus-notebook` skill on extension activation.
  The setup command installs/refreshes this skill instead of creating a Codex custom prompt.
  Bundle the complete workflow and skill-picker metadata; preserve existing custom prompts and
  user-authored or modified skills. Update notebook hints and setup documentation.

## 0.1.0 (2026-09-02)

First working build.

- Open `.qmd` files as native VS Code notebooks (`Open With → QMD Notebook`): `{python}` chunks
  become Python code cells, everything else stays Markdown; byte-identical no-op round trips.
- Kernel execution through a `jupyter_client` helper launched in the selected Python
  environment (Python-extension environments, kernelspecs, configured interpreters); rich outputs
  (stdout/stderr, errors, HTML, PNG, SVG, JSON, display updates, clear_output), interrupt,
  restart, stdin.
- Navigation model: Escape/Enter, `j`/`k`/`a`/`b`/`m`/`y`/`d d`, `Alt+J`/`Alt+K`,
  Shift/Ctrl/Alt+Enter; Edit in Source ⇄ Reopen as Notebook with kernel retention.
- Agent bridge (Unix socket + token) and `qmd-notebook-mcp` companion with read/edit/execute/
  inspect tools, optimistic concurrency (content version + source hash), Claude Code / Codex setup
  command.
- Comment workflow: `focus_notebook` MCP prompt (`assign_notebook` + `wait_for_comments`), in-cell
  comment threads rendered as transient outputs (`Ctrl+Alt+A` / `Ctrl+Alt+O` / cell toolbar) with
  agent replies, resolve/reopen, status-bar dots and a "watching agent" indicator.
