# Architecture

```
analysis.qmd ──parse/emit──► VS Code NotebookDocument ◄── Pylance / Monaco
                                   │            ▲
                    NotebookController (per kernel candidate)
                                   │
                        SessionRegistry → KernelSession (queue)
                                   │
                    python/qmd_kernel_host.py (jupyter_client, NDJSON over stdio)
                                   │
                            IPython kernel (ipykernel)

Claude Code / Codex ──stdio MCP──► qmd-notebook-mcp ──NDJSON JSON-RPC over unix socket──► BridgeServer
                                                                                            │
                                                                        NotebookService (WorkspaceEdit, executions,
                                                                        scratch inspection, request threads)
```

Four separable layers, each with its own tests:

| Layer | Code | Tests |
| --- | --- | --- |
| QMD document adapter | `src/notebook/` (parser, emitter, model, serializer, identity, cellOptions) | `test/unit/*` (node:test, no VS Code) |
| Kernel execution | `src/execution/` + `python/qmd_kernel_host.py` | `test/kernel/session.test.ts` (real kernel, no VS Code) |
| Notebook UX | `src/ux/` (commands, status bar, cell status bar, diagnostics, source toggle, settings) | `test/suite/{serializer,navigation,sourceToggle,execution,pylance}.test.ts` (VS Code) |
| Agent bridge | `src/agent/` + `packages/mcp-server` + `packages/shared` | `test/suite/bridge.test.ts` (real MCP companion), `packages/mcp-server/test` |

## Document adapter

`QmdSerializer` (`registerNotebookSerializer('qmd-notebook', …, { transientOutputs: true })`).
Parse records live in `metadata.qmd`. They are **not** marked transient on purpose: VS Code strips
transient metadata before calling `serializeNotebook`, and the emitter needs the records to
reproduce the original bytes. The extension therefore never edits metadata after open (that would
dirty the document); cells created by VS Code's own commands get their runtime id from a side
table keyed by the live `NotebookCell` object (`identity.ts`), while cells inserted by QMD
commands or agents carry a `fresh` record in the same insert edit. See `qmd-roundtrip-contract.md`.

## Execution

- `KernelDiscovery` builds kernel candidates from the Python extension's public API
  (`ms-python.python` exports → `environments.known/resolveEnvironment`), Jupyter kernelspec
  directories, `qmdNotebook.execution.pythonCandidates`, workspace `.venv` folders, and a PATH
  fallback. `ControllerManager` keeps one `NotebookController` per candidate; a `jupyter:` front
  matter hint or the active interpreter gets `Preferred` affinity.
- `SessionRegistry` owns one `KernelSession` per notebook URI, keeps it alive for
  `retainKernelOnSourceSwitchSeconds` after the notebook closes, and offers `ipykernel`
  installation when the chosen environment lacks it.
- `KernelSession` spawns `python/qmd_kernel_host.py` **inside the selected environment** (any env
  that can run ipykernel also has `jupyter_client`) and speaks a small versioned NDJSON protocol
  (`hello/start/execute/interrupt/restart/shutdown/input_reply`). It serialises all executions —
  user cells and agent scratch code — through one FIFO queue.
- `OutputAccumulator` translates IOPub messages with Jupyter semantics (stream merging,
  `display_id` updates, `clear_output(wait)`, errors) into an editor-agnostic model that
  `cellRunner.ts` mirrors onto `NotebookCellExecution` (`appendOutput`, `appendOutputItems`,
  `replaceOutputItems`, `clearOutput`).
- `variableInspector.ts` generates bounded Python for `list_variables` / `summarize_variable`,
  executed as scratch (`store_history=False`) inside a temporary function that cleans up after
  itself.

Why a Python helper instead of a Node Jupyter client: see `research-decisions.md` (Spike B).

## Notebook UX

Native notebook editor only. Commands in `src/ux/commands.ts`; keybindings in `package.json`
scoped with `notebookType == 'qmd-notebook'` and `!inputFocus` guards; `StatusBar` shows
`QMD: NAV/EDIT`, kernel state, agent activity and bridge status; `QmdCellStatusBarProvider` adds
`eval: false`, agent-thread and "Ask agent" items; `QmdDiagnostics` warns about unmatched or
stray executable fences in Markdown cells; `sourceToggle.ts` implements Edit in Source ⇄ Reopen as
Notebook; `settings.ts` previews and applies the recommended appearance settings.

## Agent bridge

- `BridgeServer`: Unix domain socket under `$XDG_RUNTIME_DIR/qmd-notebook/` (0700 dir, 0600
  socket and record; loopback TCP on Windows), per-session random token, `hello` required before
  any other method, stale record cleanup, workspace identity in the record.
- `NotebookService`: every method validated with the shared Zod shapes; mutations require the
  notebook `version` and per-cell `sourceHash` preconditions, are applied with
  `WorkspaceEdit`/`NotebookEdit` (undoable, visible immediately), and are refused in untrusted
  workspaces.
- `qmd-notebook-mcp` (`packages/mcp-server`): stdio MCP server; `--workspace` (default cwd) picks
  the VS Code window; `doctor` diagnoses; tools map 1:1 to bridge methods; images are returned as
  MCP image content and as a 0600 temp file.
- `RequestStore` + `askCommands.ts` + `RequestsView`: contextual requests with attachments
  (selection / cell / output + neighbours), stored in workspace storage, delivered as a short
  handoff token (Mode B) or to a managed CLI terminal (Mode C, experimental).
- `skills/focus-notebook/`: the self-contained Codex skill bundled in the VSIX. `codexSkill.ts`
  installs it into `~/.agents/skills/focus-notebook/` on activation (unless disabled), and the
  configure command can install/refresh it too. A manifest tracks managed file hashes so
  upgrades preserve user-authored or customized skills. Claude keeps its slash command.
