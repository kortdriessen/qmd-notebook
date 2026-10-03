# Changelog

## 0.2.0 (2026-10-03)

- Automatically install the user-wide Codex `$focus-notebook` skill on extension activation.
  The setup command installs/refreshes this skill instead of creating a Codex custom prompt.
  Bundle the complete workflow and skill-picker metadata; preserve existing custom prompts and
  user-authored or modified skills. Update notebook hints and setup documentation.

## 0.1.0 (2026-09-02, second build)

Fewer model turns per comment, cheaper watching.

- `wait_for_comments` / `assign_notebook` return full packets (attached cell source + current
  `sourceHash`, notebook `version`, selection/output preview, neighbours, thread) and a notebook
  map; attachments are refreshed at delivery when the user edited after commenting.
- Edit tools accept `execute: true` (run and return outputs in the same call) and
  `requestId` + `note` (the comment becomes *working*, the note lands in its thread, cells are
  linked). `read_notebook` gains `outline: true` and `knownHashes` (delta reads). Comment threads
  are no longer reported as cell outputs to agents.
- Long-polls: omitted `timeoutMs` waits as long as the client allows (4 h for Claude Code, 55 s
  otherwise; `--max-wait` / `QMD_NOTEBOOK_MAX_WAIT_MS`); MCP cancellation is forwarded to the
  bridge; the configure command raises Codex's `tool_timeout_sec` and registers `--max-wait 4h`.
- Focus prompt, agent rules and companion instructions rewritten around the two-call protocol
  (edit-and-run with `requestId`, then `resolve_request`).
- Readme: cell options (`#|`) section.
- Edits are guarded per cell (source hash, anchor ids); the notebook content version is optional
  and informational, so the user typing in other cells no longer rejects the agent's edits.
- `edit_cell_text` (and the `edit` op of `apply_cell_edits`): targeted edits inside a cell with
  exact old/new text pairs, file-edit semantics, minimal undoable writes, helpful rejections.
- Images in comments: paste (`Ctrl+V`), drop or pick an image in the compose box or a reply box;
  thumbnails in the thread (click to open), private 0600 storage, delivered to the agent as MCP
  image content with the comment; `read_attachment` refetches one.

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
