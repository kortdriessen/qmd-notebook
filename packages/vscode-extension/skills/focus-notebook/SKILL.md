---
name: focus-notebook
description: Focus on a live QMD notebook in VS Code and handle comments attached to its cells, selections, and outputs. Use when the user asks to focus on or watch a QMD notebook for comments, or invokes $focus-notebook.
---

# Focus Notebook

Act as the live assistant for the QMD notebook the user names. Accept a filename,
path suffix, or document ID; use the active notebook when no target is supplied.

Use the QMD Notebook MCP tools (usually registered as `qmd_notebook`). If they
are unavailable, ask the user to run **QMD Notebook: Configure Claude Code / Codex
MCP Access** in VS Code and reconnect Codex. A skill supplies the workflow; the
MCP connection supplies access to the live notebook and kernel. Do not substitute
filesystem edits for a missing connection.

## Start and watch

1. Call `assign_notebook` with the requested target and `agentName: "Codex"`.
   Keep the returned `documentId` and use it on subsequent notebook calls so
   switching editor tabs does not change your target. Briefly report what is pending.
2. Handle any `pendingComments` returned by assignment before waiting.
3. Loop on `wait_for_comments` with that `documentId` and omit `timeoutMs`.
   Process returned comments; an empty batch means wait again. Stop when the user
   says stop or the tool returns `stopped: true`. When the user asks to stop,
   call `release_notebook` for this document.

Each comment includes its request ID, current cell source and `sourceHash`,
selection or output preview, neighbours, kernel status, and thread. Reuse that
packet instead of rereading it. Open attached image paths with the available
image-viewing tool before interpreting them; use `read_attachment` for omitted
or older images and `read_output` for notebook plots.

## Handle a comment

- Treat the open VS Code NotebookDocument and selected live kernel as authoritative.
  Never edit an open `.qmd` through filesystem text replacement.
- Use runtime cell IDs. For targeted changes use `edit_cell_text` with exact
  `oldText`/`newText` pairs; use `replace_cell_source` for rewrites and `insert_cell`
  for useful new notebook content. Preserve leading `#|` Quarto options.
- Supply the `sourceHash` you already hold as `expectedSourceHash`. On a conflict,
  rebase on the current source and hash returned by the error; preserve the user's
  concurrent changes. Read a cell only when the packet or prior result is insufficient.
- Pass `requestId`, a one-line `note`, and `execute: true` with a Python edit unless
  the user asks not to execute or execution is unsafe or expensive. Inspect the
  resulting output or error before declaring success. Markdown edits need no execution.
- Use `list_variables`, `summarize_variable`, or `execute_scratch` for temporary
  diagnostics in the live kernel. Do not add notebook cells just to inspect state.
- If an execution reports `stillRunning`, inspect `read_cell` later until its result
  is known. Do not equate a tool timeout with execution failure or rerun the cell
  merely because the tool stopped waiting.
- Finish with `resolve_request`, a concise explanation of what changed and what
  the output shows, and `linkedCellIds`. If a decision is needed, use
  `update_request` with `status: "needs-input"`; the reply returns as a follow-up
  through `wait_for_comments`. Continue independent comments while waiting.

Prefer an edit-and-run call followed by a resolve call when that is sufficient.
Use the notebook map, `read_notebook` outlines or delta reads for wider context
only when the comment needs it. Keep temporary reasoning in the request thread.
