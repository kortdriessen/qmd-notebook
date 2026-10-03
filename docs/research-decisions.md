# Research decisions (Spikes A–E)

Environment for all spikes: Linux x64 (Ubuntu, kernel 6.17), VS Code 1.130.0
(commit 1b6a188127eeaf9194f945eb6eb89a657e93c54c), Node 22.17, Python 3.13.
Installed extensions inspected: `ms-toolsai.jupyter` 2025.9.1, `ms-python.python` 2026.4.0,
`ms-python.vscode-pylance` 2026.3.1, `quarto.quarto` 1.136.0, `anthropic.claude-code` 2.1.258,
`openai.chatgpt` 26.5721. CLIs: Claude Code 2.1.258, Codex 0.149.1.

Evidence was gathered by reading the installed extension bundles and VS Code's own workbench
bundle (`/usr/share/code/resources/app/out/vs/workbench/workbench.desktop.main.js`), the
Quarto source, and the official docs; then by running the prototypes that became the tests.

## Spike A — custom notebook + Pylance

**Question.** Do Python cells of a custom `qmd-notebook` type get Pylance completion, hover,
diagnostics, go-to-definition and cross-cell analysis like `.ipynb` cells do?

**Evidence.**

- Pylance's LSP notebook selector (from `ms-python.vscode-pylance-2026.3.1/dist/extension.bundle.js`):
  `notebookSelector: [{ notebook: { scheme: "file" }, cells: [{ language: "python" }] }, { notebook: { scheme: "untitled" }, cells: [{ language: "python" }] }]`
  — scheme-based, **no `notebookType` restriction**. The Python extension's document selector
  includes `vscode-notebook-cell`.
- Integration test `test/suite/pylance.test.ts` opens `fixtures/qmd/realistic-analysis.qmd` as a
  QMD Notebook with only Python + Pylance installed and asserts: `languageId === 'python'`;
  completion `bouts.he` → `head` where `bouts` is defined in an earlier cell; hover on `bouts`
  in a later cell mentions `DataFrame`; an undefined name in a new cell is diagnosed while
  `bouts` is not; `load_hypnogram` resolves to `helpers.py` in the workspace.

**Result.** Completion, hover, go-to-definition and cross-cell analysis all work for QMD cells
(no API contract or metadata needed: the LSP notebook sync treats the whole notebook as one
document regardless of view type).

**Unavoidable difference found: diagnostics.** In the same VS Code instance Pylance 2026.3.1
publishes diagnostics (squiggles) for an undefined name in a `.ipynb` cell and in a plain `.py`
file, but publishes none for the identical QMD cell — even after edits, with
`python.analysis.typeCheckingMode: basic` and the cell editor focused. The test prints
`pylance diagnostics: qmd cell=false ipynb cell=true plain .py=true` and skips with a
"[limitation]" note. Pylance's server bundle identifies notebook files by extension
(`isNotebookFile(uri) … uri.hasExtension(".ipynb")`) and its client resolves notebook
environments only for `.ipynb`/interactive URIs, so this is Pylance-side behaviour that a
notebook extension cannot influence through stable APIs. Remediation plan: (1) file a
microsoft/pylance-release issue asking that notebook cell diagnostics honour the LSP
`notebookSelector` (any `file:` notebook with Python cells) instead of the `.ipynb` extension;
(2) meanwhile Pylance still reports problems on hover/completion and QMD Notebook shows its own
fence diagnostics; (3) a QMD-side stopgap would be running `pyright` over a synthesised module of
the cells, not implemented in V1.

**Remote SSH.** The extension is `extensionKind: ["workspace"]`; Pylance and the Python
extension also run remotely, so the behaviour is the same by construction. Not yet exercised on a
real remote host (documented limitation).

## Spike B — kernel integration

**Options examined, in the order the spec prescribes.**

1. *Microsoft Jupyter extension API.* The installed bundle
   (`ms-toolsai.jupyter-2025.9.1/dist/extension.node.js`) registers controllers only for two
   view types: `createNotebookControllers(e){…this.batchAdd(e,[It,nr])}` with
   `It="jupyter-notebook"`, `nr="interactive"`. Its public API (`jupyter.kernels.getKernel(uri)`)
   only returns kernels already started by one of its own controllers. So the Jupyter extension
   cannot populate the kernel picker of a custom notebook type, and `getKernel` cannot be used
   without first attaching a Jupyter controller to some other document. **Not viable** for "a
   normal kernel picker selects a kernel for this notebook".
2. *Command delegation.* The only public execution commands route output to the Interactive
   Window (`jupyter.execSelectionInteractive`), not to our cells. **Not viable.**
3. *Direct Jupyter protocol in Node.* Requires the `zeromq` native module (ABI/platform
   prebuilds inside the VSIX, plus matching binaries for every Remote SSH target) and a
   re-implementation of kernelspec resolution, connection files, HMAC signing and channel
   handling. Materially worse than option 4 for a personal, Remote-SSH-oriented tool.
4. *`jupyter_client` sidecar.* Every Python environment that can be a kernel has `ipykernel`,
   which depends on `jupyter_client`. A 400-line helper (`python/qmd_kernel_host.py`) launched
   **in the selected environment itself** speaks a versioned NDJSON protocol over stdio, so the
   extension has no native dependencies, works identically under Remote SSH (spawned on the
   extension host), and reuses the reference implementation for kernel lifecycle.

**Decision.** Option 4. Ownership: the helper is owned by the selected kernel environment; if an
environment lacks `ipykernel` the extension offers `pip`/`uv` installation. Protocol v1 is
documented at the top of the helper and in `src/execution/kernelHost.ts`.

**Gate.** `test/kernel/session.test.ts` (17 cases against a real kernel) proves `x = 41` then
`x + 1` → `42`, a matplotlib PNG (`image/png` bytes start with the PNG signature) and a pandas
HTML table, plus streams, errors, `display_id` updates, `clear_output(wait)`, stdin, interrupt
(including dropping queued cells), scratch execution without bumping the execution count,
timeouts, restart and crash detection. `test/suite/execution.test.ts` repeats the core sequence
inside VS Code through the native `notebook.cell.execute` command.

## Spike C — native notebook styling limits

**Stable surfaces found** (contribution points and settings present in VS Code 1.130):

- Theme colours `notebook.cellBorderColor`, `notebook.focusedCellBorder`,
  `notebook.inactiveFocusedCellBorder`, `notebook.selectedCellBorder`,
  `notebook.inactiveSelectedCellBorder`, `notebook.cellEditorBackground`,
  `notebook.focusedCellBackground`, `notebook.selectedCellBackground`,
  `notebook.outputContainerBackgroundColor`, `notebook.outputContainerBorderColor`,
  `notebook.focusedEditorBorder`, `notebook.editorBackground` (settable by the user through
  `workbench.colorCustomizations`; extensions cannot change their defaults).
- Settings `notebook.cellFocusIndicator` (`border` gives a full container border),
  `notebook.cellToolbarLocation` (per view type), `notebook.consolidatedRunButton`,
  `notebook.showCellStatusBar`, `notebook.insertToolbarLocation`, `notebook.compactView`,
  `notebook.lineNumbers`, `notebook.output.scrolling`.
- `notebooks.registerNotebookCellStatusBarItemProvider` for per-cell status items.
- Menus: `notebook/toolbar`, `notebook/cell/title`, `notebook/cell/execute`,
  `notebook/kernelSource`. **There is no contributable output-toolbar menu** in this build
  (`notebook/cell/output` does not exist), which shapes Spike D.
- Not available as stable API: notebook editor decorations, per-cell CSS, rounded corners.

**Decision.** Keep the native editor. Ship the closest supported look as a *previewed, opt-in*
command (**Apply Recommended Appearance Settings**): 1px alpha-grey cell border, slightly
differentiated editor background, accent border on the focused cell, bordered output container,
right-side compact cell toolbar, hidden insert bars, compact view. Nothing is written to user
settings automatically.

## Spike D — contextual prompt UI

Order of investigation and outcome:

1. Cell/output toolbar contributions + compact prompt input — cell toolbar: yes
   (`notebook/cell/title`, inline icons); output toolbar: **not contributable** (see Spike C).
   Output selection is therefore done by a command that lists the cell's outputs in a Quick Pick
   when there is more than one (`Ask Agent About Output`, `Ctrl+Alt+O`).
2. Transient custom output rendered by a renderer — possible, but writing outputs outside an
   execution requires a `NotebookCellExecution` from a selected controller and flashes the
   running state; rejected for V1.
3. Cell status bar action + input box — superseded by (5); the status bar keeps a `Comment`
   action on the active cell and `●`/`○` dots per open/resolved thread.
4. Side panel synchronised to the selected cell — **used**: the *Agent Requests* tree view
   (activity bar) shows threads, attachments, messages and status, with reveal-cell, copy-as-
   Markdown, insert-summary, cancel and re-send actions.
5. **Native Comments API — tried, not reachable for cells.** VS Code 1.130 does render comment
   threads under notebook cells (`CellComments` part, `getNotebookComments`), but only threads
   that are *not* "document comment threads": `isDocumentCommentThread(){return this._range===void 0||isIRange(this._range)}`
   (workbench bundle). The extension host always sends `Range.from(range)` (an IRange, or
   undefined), so every thread an extension creates is a document thread, rendered as a text
   editor zone widget — and notebook cell editors do not host the comments contribution. Two
   prototypes (ranged and range-less threads) confirmed nothing appears in the cell; the built-in
   `notebook.commentSelectedCells` is code commenting, not threads. So the in-cell surface is
   built with option 2:
6. **Transient comment outputs rendered by `qmd-notebook.comments` (`dist/renderer.js`) — used.**
   A draft/thread is one extra output item (`application/x-qmd-comment+json`) under the cell,
   rendered as a compact card with a compose box, the user/agent messages, and close/reopen/
   delete; actions go back through `notebooks.createRendererMessaging`. Outputs are transient for
   QMD notebooks (never saved). Writing outputs outside a run uses a `NotebookCellExecution` of
   the selected controller that replays the cell's existing execution summary (order, timing,
   success) so the ✓/timing indicator is unchanged; without a selected kernel comments fall back
   to an input box and the status-bar dots. Delivery needs no clipboard handoff: an agent that
   ran the `focus_notebook` prompt (`assign_notebook` + `wait_for_comments` long-poll) receives
   comments as they are sent.

Requests never enter the `.qmd` (workspace storage only) and composing one never dirties the
document (verified in `bridge.test.ts`).

## Spike E — agent surface handoff

Documented/contributed surfaces found (extension `package.json` command contributions and CLI
`--help` output; docs pages verified 2026-09-02):

- Claude Code extension commands: `claude-vscode.focus` (documented Cmd/Ctrl+Esc focus),
  `claude-vscode.sidebar.open`, `claude-vscode.insertAtMention`. No command to insert or submit
  prompt text.
- Codex extension commands: `chatgpt.openSidebar`, `chatgpt.addToThread`, `chatgpt.newCodexPanel`.
  No prompt-submission command.
- MCP configuration: Claude Code `.mcp.json` (project scope) / `claude mcp add --scope project`;
  Codex `.codex/config.toml` project scope (loaded when the project is trusted; fields `command`,
  `args`, `env`, `cwd`) or `codex mcp add`. Codex shares MCP config between CLI and IDE.
- Non-interactive automation for smoke tests: `claude -p --mcp-config … --strict-mcp-config
  --allowedTools …` and `codex exec`.

**Decision.** MCP is the common bridge (Mode A). Mode B = create the request packet, copy a
one-line handoff token, focus the composer with the documented command. Mode C = managed
integrated terminal running the CLI, text sent only after explicit confirmation, plus the bounded
`wait_for_request` tool for a deliberate live-collaborator loop. No undocumented internals are
called.

**Findings from the automated end-to-end runs** (`test/suite/agents.e2e.test.ts`):

- Claude Code (`claude -p … --mcp-config <file> --strict-mcp-config --allowedTools
  "mcp__qmd-notebook__*"`) connects, calls `get_active_context`, `read_notebook`,
  `summarize_variable`, `read_cell`, `replace_cell_source` (with version + hash) and
  `execute_cell`, and reports the new stdout; the `.qmd` on disk is untouched.
- Codex (`codex exec -c 'mcp_servers.qmd_notebook.command=…' -c 'mcp_servers.qmd_notebook.args=[…]'
  --sandbox read-only …`) registers the server from `-c` overrides, but launches MCP servers
  with a scrubbed environment (no `XDG_RUNTIME_DIR`). The companion therefore also looks in
  `/run/user/<uid>/qmd-notebook` and a tmpdir fallback, and honours `QMD_NOTEBOOK_RUNTIME_DIR`.
- Project-scoped `.codex/config.toml` is only read once the project is trusted in Codex; the
  `-c` overrides (or user-level `codex mcp add`) work without that step.
- Inside a VS Code extension host `process.execPath` is Electron, not node; any launcher must use
  a real `node` for the companion (the configure command writes `node <path>/qmd-notebook-mcp.js`).
- **Registration scope**: user level by default (`claude mcp add --scope user`, `codex mcp add`),
  project level optional. The spec preferred project scope to keep tools out of unrelated repos,
  but the user's workflow — start the agent at a project root to inherit its `AGENTS.md`, then
  work on any notebook of that project, in many projects — favours one registration. The cost is
  that the tool list is visible in every session; calls fail with a clear "no bridge" error when
  no matching window exists. The registered launcher points at a copy of the companion in VS
  Code's global storage (refreshed on activation) rather than the versioned extension folder, so
  upgrades do not break it. Workspace matching: the agent's directory inside a window's folder
  wins; a directory *above* exactly one window's folder also attaches; several candidates → error
  listing them.
- Spawning the agent CLIs from the extension host must use detached processes with stdin
  ignored; sharing the host's stdio/process group made the extension host exit.

## Other constraints recorded

- **Reload from Disk** cannot rely on VS Code: `workbench.action.files.revert` is a no-op for a
  clean notebook (`NotebookEditorInput.revert` only reverts dirty models), and closing the editor
  does not release the model (the extension host keeps a bounded-lifetime reference), so a reopen
  is served from cache. QMD Notebook reloads explicitly: read the file, deserialize with the QMD
  serializer, replace cells + metadata through a `NotebookEdit`, then save (identical bytes) to
  re-synchronise the saved state. VS Code's own auto-reload of clean notebooks on external change
  still works when the file watcher is healthy; during the test runs the node file watcher hit
  `EMFILE: too many open files` (inotify exhaustion from many concurrent VS Code instances), which
  is why the explicit path exists.

- **Polling economics (2026-09-02).** Measured facts: Claude Code 2.1.258 defaults its per-call MCP
  tool timeout to `1e8` ms (~28 h; env `MCP_TOOL_TIMEOUT`, per-server `timeout` field in ms,
  values below 1000 ignored; the initialize `clientInfo.name` is `claude-code`); Codex 0.149.1
  defaults `tool_timeout_sec` to 60 (`clientInfo.name` is `codex-mcp-client`). A long-poll that
  returns empty costs one full model turn (context re-sent at cache-read price if the prompt cache
  is still warm, otherwise rewritten) plus a small permanent addition to the conversation. With a
  5-minute cache the interval must be either just under the cache lifetime or far beyond it: 90 s
  ≈ 4.0 × C input per idle hour, 4.5 min ≈ 1.3 × C, 10 min ≈ 7.5 × C (cache expired), 4 h ≈
  0.3 × C. Decision: the companion picks the wait from the client name (4 h for Claude Code, 55 s
  otherwise, `--max-wait` / `QMD_NOTEBOOK_MAX_WAIT_MS` override), the bridge caps waits at 6 h,
  and the configure command raises Codex's `tool_timeout_sec`. MCP cancellation (`extra.signal`
  in the SDK tool handler) is forwarded as `cancelWait` so an abandoned poll cannot swallow a
  comment. The earlier prompt's fixed 90 s wait exceeded Codex's default and produced a timeout
  error per minute while idle.
- **Per-cell optimistic concurrency (2026-09-02).** The first builds required `expectedVersion`
  (notebook content version) on every edit. In real use the user keeps typing in other cells while
  the agent works, so the version moved by hundreds between the agent's read and its write and
  every edit was rejected (`expected 582, now 736`), forcing re-read/retry turns and loops. The
  version is now optional and informational; replace/delete are guarded by the cell's source hash,
  insert/move by anchor cell ids, which is the actual invariant (only the targeted cell must be
  what the agent saw).
- **Targeted in-cell edits (2026-09-03).** With only whole-cell replacement an agent was observed
  saying "The partial-edit tool still takes whole-cell sources, so I'll resend the cell": every
  small change cost the whole cell in output tokens and risked drift. `edit_cell_text` mirrors the
  file-edit contract agents already use (exact `oldText` → `newText`, unique match or
  `replaceAll`, applied in order, all-or-nothing), computed in `packages/shared/src/textEdits.ts`
  and written as the single smallest differing span through a `WorkspaceEdit`, so one undo step
  reverts it and the rest of the cell is untouched. Failures return the current source, the
  ambiguous line numbers, and a whitespace-insensitive hint (indentation is the usual culprit).
- **Images in comments (2026-09-03).** The compose box lives in the notebook output webview, a
  normal browser context: a `paste` listener on the textarea takes `image/*` items off the
  clipboard (text pastes are left to the browser), measures them and makes a ≤160 px thumbnail
  with a canvas, and posts bytes + thumbnail to the extension over renderer messaging. The
  extension stores bytes as a private 0600 file under the bridge runtime dir (never workspace
  storage, never the `.qmd`), keeps the thumbnail with the draft/thread for display, and re-syncs
  the output; the renderer keeps compose text and focus across that re-render. Delivery reuses
  the MCP image-content path already used for plot outputs: the companion lifts `inlineImages`
  out of the packet JSON into labelled image blocks, so no base64 ever counts as text tokens.
  Drop and a file-picker button exist as fallbacks in case clipboard paste is intercepted in
  some VS Code build. Client probe (2026-09-03, a stand-alone MCP server returning a red 64×64
  swatch as an image block): Claude Code 2.1.258 answered "red"; Codex 0.149.1 answered "Purple"
  whether the image block came before or after the text block, i.e. its model never received it,
  while a text result carrying the file path plus "look at it with your image viewing tool" got
  "Red" through Codex's `view_image`. Delivery is therefore client-aware (image blocks for
  `claude-code`, file paths + instruction for everyone else), and `read_output` /
  `read_attachment` default to path-only delivery for such clients.
- `NotebookDocument.version` increments on transient metadata changes too; the bridge therefore
  attaches runtime ids in the same `NotebookEdit` that inserts a cell, so the version it returns
  is immediately usable.
- VS Code exposes no "focused output" to extensions; `get_active_context.focusedOutputId` is
  always `null` and output identity comes from request packets or `read_cell`.
- Quarto only executes backtick fences with `{lang}`; tilde fences are never executable. The
  parser mirrors Quarto's regexes exactly except that it is *more* protective (see
  `qmd-roundtrip-contract.md`).
