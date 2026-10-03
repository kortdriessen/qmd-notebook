# Agent setup: Claude Code and Codex

QMD Notebook exposes the live notebook and its kernel to agents through a companion MCP server,
`qmd-notebook-mcp`. Both Claude Code and Codex talk to it over stdio; the companion connects to
the VS Code window that has your project open.

Verified with: VS Code 1.130, QMD Notebook 0.1.0, Claude Code CLI 2.1.258 / extension 2.1.258,
Codex CLI 0.149.1 / extension 26.5721, Linux.

## 1. Install the extension and the companion

- Install `qmd-notebook.vsix` (`code --install-extension qmd-notebook.vsix`) plus the Python and
  Pylance extensions. The Jupyter extension is **not** required (QMD Notebook runs its own
  `jupyter_client` helper in the selected environment).
- The companion is bundled inside the extension as `dist/qmd-notebook-mcp.js`; no separate
  install is needed. Optionally put it on your PATH for the short `qmd-notebook-mcp` form:

  ```bash
  cd packages/mcp-server && npm run build && npm install -g .
  ```

- When QMD Notebook activates (for example, after opening a `.qmd`), it automatically installs
  the bundled **focus-notebook** Codex skill at `~/.agents/skills/focus-notebook/`. Invoke it with
  `$focus-notebook analysis.qmd`, or select it from Codex's skill picker. The skill is available
  across projects on that host; the MCP connection below is still required to access VS Code.
  Codex detects skill changes automatically; restart it if the skill does not appear.
  See [OpenAI's skill documentation](https://learn.chatgpt.com/docs/build-skills).
- Extension upgrades refresh the installed skill only while its managed files remain unchanged.
  Existing user-authored or customized skills are preserved. Set
  `qmdNotebook.agent.installCodexSkill` to `false` to disable automatic installation on future
  activations. Under Remote SSH the skill is installed on the remote extension host, for Codex
  sessions running there.

## 2. One-command configuration (recommended)

In VS Code run **QMD Notebook: Configure Claude Code / Codex MCP Access** and pick a scope:

- **User level (default)** — once for all projects: `claude mcp add --scope user …`,
  `codex mcp add …`, rules appended to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, and
  Claude's `/focus-notebook` command in `~/.claude/commands/`, and Codex's `$focus-notebook` skill
  in `~/.agents/skills/`. Because the
  companion is launched with `--workspace .`, the agent connects to whichever VS Code window has
  the directory it was started in (or a parent of it, when unambiguous). This is the right choice
  when you start agents at a project root such as `/data/slap_analysis` to inherit that project's
  context and then work on any notebook inside it.
- **This project only** — `.mcp.json`, `.codex/config.toml` (loaded once you trust the project in
  Codex), project `CLAUDE.md` / `AGENTS.md`, `.claude/commands/`. Use it for repositories that
  should not expose the notebook tools elsewhere.

The Codex skill is user-wide in either configuration scope; MCP registration follows the scope
you select. Setup installs skills instead of creating Codex custom prompts. Existing
`~/.codex/prompts/focus-notebook.md` files are left untouched for compatibility; use
`$focus-notebook` going forward. The skill contains the notebook workflow itself, so it does not
require a particular project's `AGENTS.md` to explain how to handle comments.

It uses `qmd-notebook-mcp` if it is on your PATH, otherwise `node <global-storage>/qmd-notebook-mcp.js`
(a copy of the bundled companion at a stable path that survives extension upgrades).
**QMD Notebook: Copy MCP Server Path** copies that launch line for manual setups.

## 3. Manual configuration

### Claude Code

User scope (recommended):

```bash
claude mcp add --scope user qmd-notebook -- node /path/to/extension/dist/qmd-notebook-mcp.js --workspace .
```

Project scope (`.mcp.json` in the repository root, or `claude mcp add --scope project …`):

```jsonc
{
  "mcpServers": {
    "qmd-notebook": {
      "command": "qmd-notebook-mcp",
      "args": ["--workspace", "."]
    }
  }
}
```

`--workspace .` resolves against the directory Claude Code runs in (the project), so the same
entry works in the sidebar extension and in the CLI. Restart Claude Code after adding a server;
`/mcp` inside Claude Code shows whether `qmd-notebook` is connected.

### Codex

User scope (recommended; shared by the Codex CLI and the Codex IDE extension):

```bash
codex mcp add qmd_notebook -- node /path/to/extension/dist/qmd-notebook-mcp.js --workspace .
```

Project-scoped (`.codex/config.toml`, requires trusting the project in Codex):

```toml
[mcp_servers.qmd_notebook]
command = "qmd-notebook-mcp"
args = ["--workspace", "."]
```

`codex mcp list` shows the configured servers.

### Rules for agents

Add this to `CLAUDE.md` and `AGENTS.md` (the configure command does it for you):

```markdown
## Live QMD notebooks

When the QMD Notebook MCP tools are available:

- Treat the open VS Code NotebookDocument as authoritative for notebook content.
- Never edit an open `.qmd` notebook through filesystem text replacement.
- Use QMD Notebook tools to read and edit cells by runtime cell ID.
- Treat the selected live kernel as authoritative for Python runtime state.
- Use structured variable-inspection tools or scratch execution for temporary diagnostics.
- Do not add notebook cells merely to inspect variables.
- Edit with the cell's sourceHash you already hold (comment packet, previous read or edit result); call read_cell only when you have none. Edits are guarded per cell: the user editing other cells never conflicts with yours.
- For changes inside a cell use edit_cell_text (exact oldText → newText pairs, like a file edit) instead of resending the whole cell; replace_cell_source is for rewrites.
- If an edit conflicts, rebase on the current source returned in the error; never overwrite the user's concurrent change.
- After modifying a Python cell, execute it unless the user asks not to or execution is unsafe/expensive (execute: true on the edit call does both in one step).
- Every tool call is a full model turn: prefer one edit-and-run call over read, edit, run, read.
- Keep a cell's leading `#|` option lines (Quarto cell options such as label, fig-cap, eval) when you rewrite it, unless the change is about them.
- Inspect the resulting output or error before claiming completion.
- Put durable explanatory code/comments in the QMD only when useful; keep transient reasoning in the request thread.
```

## 4. Check the connection

1. Open the project in VS Code and trust it.
2. Open a `.qmd` with **Open With → QMD Notebook** and select a kernel.
3. Run **QMD Notebook: Agent Connection Status** (also in the notebook toolbar). It shows the
   bridge socket, connected clients, and whether `.mcp.json` / `.codex/config.toml` mention the
   server.
4. From a terminal in the project:

   ```bash
   qmd-notebook-mcp doctor --workspace .
   # or: node /path/to/extension/dist/qmd-notebook-mcp.js doctor --workspace .
   ```

   It checks the runtime directory permissions, discovery records, bridge reachability, protocol
   version, open notebooks and kernel status — without printing tokens or notebook contents.

   The companion looks for the bridge's discovery record in `$XDG_RUNTIME_DIR/qmd-notebook`,
   then `/run/user/<uid>/qmd-notebook`, then a tmpdir fallback; agent clients that launch MCP
   servers with a scrubbed environment (Codex does) still find it. `QMD_NOTEBOOK_RUNTIME_DIR`
   overrides the location if needed.
5. In Claude Code or Codex ask: *"Use the QMD Notebook tools to summarize the active notebook and
   list live variables."*

## 5. Tool surface

| Tool | Purpose |
| --- | --- |
| `list_open_notebooks`, `get_active_context` | which notebook/cell/selection the user is on, kernel status, pending requests |
| `read_attachment` | an image the user pasted into a comment, as MCP image content plus its private file path (images on the message being delivered already arrive inline with `wait_for_comments`) |
| `read_notebook`, `read_cell`, `read_output` | cells with runtime ids + `sourceHash`, bounded outputs, images as MCP image content / temp file; `read_notebook` has `outline: true` (one line per cell) and `knownHashes` (delta read: unchanged cells come back without source) |
| `edit_cell_text` | targeted edits inside a cell: exact `oldText` → `newText` pairs with file-edit semantics (unique match or `replaceAll`), written as one minimal undoable change; rejects missing/ambiguous text before writing, with the current source, line numbers and a whitespace hint |
| `replace_cell_source`, `insert_cell`, `delete_cell`, `move_cell`, `apply_cell_edits` | whole-cell rewrites and structure (batch ops include `edit`) through VS Code (undoable), guarded per cell: `expectedSourceHash` for replace/delete, anchor cell ids for insert/move (the user editing other cells never conflicts; `expectedVersion` is optional and informational); `execute: true` runs the edited python cell(s) in the same call and returns the results; `requestId` + `note` mark the comment being handled as *working*, link the cells and post the note into its thread |
| `execute_cell`, `execute_cells` | run cells in the notebook's live kernel and get bounded results |
| `execute_scratch`, `list_variables`, `summarize_variable` | inspect the kernel without adding cells (`execute_scratch` can mutate state) |
| `interrupt_kernel`, `restart_kernel` | kernel control |
| `assign_notebook`, `release_notebook`, `wait_for_comments` | become the watching agent of a notebook and receive its comments as full packets (prompt, attached cell source + current hash, notebook version, selection/output preview, neighbours, thread) plus a notebook map; long-poll, batched, `stopped` on release/close; with `timeoutMs` omitted the companion waits as long as the client allows and MCP cancellation (Escape, client timeout) is forwarded to the bridge |
| `get_request`, `list_requests`, `update_request`, `resolve_request`, `wait_for_request` | older threads / handoff tokens, questions to the user (`needs-input`), resolve with the reply |
| prompt `focus_notebook` | the one-time "focus" instruction (`/mcp__qmd-notebook__focus_notebook <name>` in Claude Code) |

Every write is refused with a structured conflict (`code -32003`, current version/hash/source)
if the user changed the cell since it was read. Untrusted workspaces refuse execution and edits.

## 6. Comments in the notebook, handled by a watching agent

This is the everyday loop. Nothing is copied between surfaces.

1. **Focus once, in the agent surface.** In Claude Code type
   `/mcp__qmd-notebook__focus_notebook analysis.qmd` (the MCP prompt; also available as
   `/focus-notebook analysis.qmd` after the configure command writes
   `.claude/commands/focus-notebook.md`). In Codex type `$focus-notebook analysis.qmd` (the
   user-wide skill installed by the extension). The identifier is the file name, a path suffix, or the documentId; omit
   it for the active notebook. The agent calls `assign_notebook` and the status bar shows
   `<agent> watching`. It then loops on `wait_for_comments` until you say stop, close the
   notebook, or run **QMD Notebook: Release Watching Agent**. Each wait is one long tool call
   that returns the instant a comment arrives; idle time costs no tokens (see *How the watching
   works* below).
2. **Comment in the editor.** Select text and press `Ctrl+Alt+A`, click the comment icon in the
   cell toolbar or the `Comment` item in the cell status bar, or `Ctrl+Alt+O` for an output (a
   picker appears when a cell has several). A compose box appears right under that cell; type and
   press **Send** (`Ctrl+Enter`). Paste an image with `Ctrl+V` (or drop one, or use the image
   button to pick a file): it is stored as a private 0600 file under the bridge runtime dir,
   shown as a removable thumbnail, and delivered to the agent as image content together with the
   comment. The thread stays under the cell (as a transient output, never
   saved) showing the anchor (selection excerpt / cell / output), the status, and the messages.
   The packet the agent receives carries the exact selected text, cell source + hash, output
   preview (plots as images through `read_output`), neighbouring cells and kernel status. A kernel
   must be selected for the inline box (otherwise an input box collects the comment).
3. **Watch it work.** The thread label goes `queued for <agent>` → `delivered` →
   `<agent> working…` (with the agent's one-line plan as a reply) → `resolved` (the agent's
   summary as the final reply; the thread collapses). A typical comment takes the agent two
   tool calls: one edit with `requestId` + `note` + `execute: true` (plan posted, cell rewritten
   and run, outputs returned), then `resolve_request`. Each cell shows dots in its status bar:
   `●` per open comment, `○` per resolved one; click them to expand the threads. Reply inside a
   thread to send a follow-up (the agent gets it as the same request with `followUp: true`);
   `needs your input` means the agent asked a question. Several comments can be open at once;
   the agent is told to work through them without blocking on long-running cells.
4. The **Agent Requests** view (activity bar) lists every thread with *Copy thread as Markdown* /
   *Insert thread summary into document*. Comments live in workspace storage, never in the
   `.qmd`, and composing one never dirties the notebook.

### How the watching works (and what it costs)

The extension holds the notebook; the agent holds nothing. A language model only learns
something when a tool call returns, and nothing can be pushed into it mid-turn, so "watching" is
a long-poll: `wait_for_comments` blocks inside the bridge until a comment, a follow-up reply, a
release or the timeout. While it blocks, no model request is in flight and no tokens are used.
Every return, including an empty timeout, is a full model turn (the whole context is re-sent,
prefix-cached; a few hundred output tokens) and appends a little to the conversation, which is
what eventually triggers compaction. So the design minimises turns:

- **Long waits.** With `timeoutMs` omitted, the companion waits as long as the MCP client allows:
  4 h for Claude Code (its default per-call MCP timeout is about 28 h, `MCP_TOOL_TIMEOUT` or the
  per-server `timeout` field), 55 s for other clients. Codex allows 60 s per call by default
  (`tool_timeout_sec`); the configure command raises it to 14700 s for `qmd_notebook` and adds
  `--max-wait 4h` to the companion's arguments so Codex long-polls too. A 90 s poll costs ~40
  turns per idle hour; a 4 h poll costs a quarter of one.
- **Full packets.** The wait returns everything needed to act: the attached cell's current
  source and `sourceHash` (refreshed at delivery if the user edited after commenting,
  `changedSinceComment: true`), the notebook content `version` (informational), the
  selection or output preview, neighbouring cells, the thread, plus a **notebook map** (one line
  per cell: id, first line, hash, execution state). No `get_request`, no `read_cell`.
- **One call to edit and run.** `execute: true` on the edit; `requestId` + `note` replace the
  separate `update_request(working)` call.
- **Targeted edits.** `edit_cell_text` takes exact old/new text pairs, so changing two colour
  values in a 60-line plotting cell costs two short strings of output tokens instead of the whole
  cell, and nothing outside the named text can drift.
- **Images ride with the comment.** For Claude Code, pasted images are delivered as MCP image
  content blocks in the same `wait_for_comments` result (only the images of the message being
  delivered; each bounded by `qmdNotebook.agent.maxImageBytes`, larger ones listed in
  `inlineImagesOmitted`), so the agent sees the picture in the turn it reads the comment. Codex
  0.149 does not show MCP image content to its model (verified with a solid-colour swatch: it
  guessed), but its built-in `view_image` tool reads a local file, so for Codex and unknown
  clients the companion sends the private file paths plus an instruction instead of bytes.
  Thumbnails are for the notebook UI only and never reach the agent.
- **Delta reads.** `read_notebook` with `knownHashes` returns sources only for cells that changed;
  `outline: true` returns just the map.
- **Cancellation.** If the client abandons a wait (Escape in the CLI, its own timeout), the MCP
  cancellation is forwarded to the bridge (`cancelWait`), so a comment arriving later is never
  marked as delivered to nobody.

While the agent is inside a wait, text typed into its terminal is queued until the wait returns;
press Escape first to cancel the wait and talk to it. Comments in the notebook need nothing.

Fallbacks: if no agent is watching when you send a comment, the thread says
`queued · no agent watching` and a toast offers **Copy handoff** (a one-line token an agent can
handle with `get_request`). **Start Live Claude/Codex Session** / **Send Request to Live Agent**
type that token into an integrated-terminal session (experimental).

## 7. Sidebar vs CLI

- MCP capability is identical in the IDE extension and the CLI for both clients.
- Editor-selection context differs: the IDE integrations may attach ordinary selected text on
  their own; the QMD bridge is what supplies cell identity, outputs and kernel access.
- There is no documented API to inject text into either composer, so one-click submission is not
  promised: the handoff is copied and the composer focused (paste + Enter).
- The CLI is the guaranteed automation path (Mode C / `wait_for_request`).

## 8. Validation record (2026-09-02)

`QMD_E2E_AGENTS=claude,codex npm run test:vscode -w packages/vscode-extension` (grep
`end-to-end`) drives the real CLIs against a live notebook in the test VS Code instance. Both
passed:

| Client | Invocation | Observed |
| --- | --- | --- |
| Claude Code 2.1.258 | `claude -p … --mcp-config <json> --strict-mcp-config --allowedTools "mcp__qmd-notebook__*"` | `get_active_context`, `read_notebook`, `summarize_variable` (counter = 7), `read_cell`, `replace_cell_source` (version 5, hash accepted), `execute_cell` → stdout `agent 107`; file untouched |
| Codex 0.149.1 | `codex exec -c 'mcp_servers.qmd_notebook.command=…' -c '…args=[…]' --sandbox read-only …` | same tool sequence, `agent 107`, file untouched |
| Claude Code (focus scenario) | `claude -p "<focus_notebook prompt> … handle the waiting comment, then release_notebook"` | `assign_notebook` → `wait_for_comments` → `get_request` → `update_request(working)` → edit (one conflict, re-read and rebased) → `execute_cell` → `resolve_request` → `release_notebook`; thread resolved, stdout `hello from the comment`, file untouched |
| Codex (focus scenario) | `codex exec … "<focus_notebook prompt> …"` | same loop; thread resolved, stdout `hello from the comment`, file untouched |

Second build (same day), after the two-call protocol (full packets, `execute: true`,
`requestId` + `note`): the bridge log (`bridge: <client> → <method>`) shows both agents dropping
the reads and the separate execute/progress calls:

| Client | Bridge calls in the focus scenario | Observed |
| --- | --- | --- |
| Claude Code 2.1.258 | `hello` → `assignNotebook` (the waiting comment came back as a full packet) → `replaceCellSource` (with `execute: true`, `requestId`, `note`) → `resolveRequest` → `waitForComments` → `releaseNotebook` | thread *working* with the note, then resolved; stdout `hello from the comment`; file untouched; 38 s wall clock including CLI start-up |
| Codex 0.149.1 | same six calls; its final `waitForComments` (no `timeoutMs`, no `--max-wait` in the test config) returned after 57 s, i.e. the 55 s budget chosen for a client whose `tool_timeout_sec` is the default 60 | same result; 89 s wall clock |

Re-run after edits became per-cell: identical sequences for both agents; Codex passed a stale
`expectedVersion` with its edit, which the bridge logged (`notebook version moved … since the
agent's read`) and accepted because the cell hash matched.

Re-run after `edit_cell_text` shipped (2026-09-03): for the comment "print 'hello from the
comment' after the counter line, then run it", both Claude Code and Codex chose `edit_cell_text`
with one replacement and `execute: true` (bridge log: `editCellText` → `resolveRequest`; no
whole-cell replace, no separate execute call). The scripted edit scenario still uses
`replace_cell_source` because its prompt asks for it by name.

Images (2026-09-03): a 64×64 solid red PNG attached to a comment asking for the dominant colour.
Claude Code received it as MCP image content with the packet and answered "red" in 15 s. Codex
0.149 answered "Red" too, through the file-path route (`attachedImages` + `view_image`); with
image blocks alone it had answered "Blue"/"Purple", so that route is what the companion sends it.

`version` in tool results is a *content* version: it changes when cell text, kind, order or count
change, not when outputs or execution state change. Since the second build it is informational
only. Edits are guarded per cell (source hash, anchor ids), because a notebook-wide version moves
with every keystroke anywhere in the notebook and made the user's typing in *other* cells reject
the agent's edits (`notebook content version changed (expected 582, now 736)`), costing a re-read
and a retry each time. The only remaining conflict is the one that matters: the same cell edited
by both.

## 9. Remote SSH

The extension is declared `extensionKind: ["workspace"]`, so under Remote SSH it runs on the
remote host: kernels, the bridge socket (`$XDG_RUNTIME_DIR/qmd-notebook/` on the remote) and
the discovery record are all remote. Run the companion in the remote environment (Claude Code /
Codex in the VS Code integrated terminal, or the IDE extensions when they execute their MCP
servers remotely). Not yet tested end to end on a remote host — see the known limitations in the
README.
