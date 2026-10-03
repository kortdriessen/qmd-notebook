/**
 * One KernelSession per open QMD notebook, kept alive for a grace period after the notebook
 * closes (so "Edit in Source" and back reconnects to the same kernel state).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { KernelInfo, ScratchResult, OutputItemSummary } from '@qmd-notebook/shared';
import { getSetting, isQmdNotebook } from '../util/config';
import type { Logger } from '../util/logger';
import { runCell, skipCell, type CellRunResult } from './cellRunner';
import { OutputAccumulator, STDERR_MIME, STDOUT_MIME, itemText, type OutputItem, type OutputRecord, type OutputSink } from './outputModel';
import { KernelDiscovery, probePython, type KernelCandidate } from './kernelProvider';
import { KernelSession, type ExecutionOutcome } from './session';
import { extractJson, listVariablesCode, summarizeVariableCode } from './variableInspector';
import { cellRecord } from '../notebook/serializer';
import { cellIdOf } from '../notebook/identity';
import { isEvalDisabled } from '../notebook/cellOptions';

export interface ControllerLike {
  readonly id: string;
  readonly candidate: KernelCandidate;
  readonly controller: vscode.NotebookController;
}

interface SessionEntry {
  session: KernelSession;
  candidate: KernelCandidate;
  disposeTimer?: NodeJS.Timeout;
  cwd: string;
}

export class SessionRegistry implements vscode.Disposable {
  private readonly entries = new Map<string, SessionEntry>();
  private readonly selections = new Map<string, ControllerLike>();
  private readonly cellRuns = new WeakMap<vscode.NotebookCell, Promise<CellRunResult>>();
  private readonly runningCells = new Set<string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.NotebookDocument | undefined>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];
  private allCandidates: KernelCandidate[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly discovery: KernelDiscovery,
  ) {
    this.disposables.push(
      vscode.workspace.onDidCloseNotebookDocument((nb) => {
        if (isQmdNotebook(nb)) this.scheduleDispose(nb);
      }),
      vscode.workspace.onDidOpenNotebookDocument((nb) => {
        if (isQmdNotebook(nb)) this.cancelScheduledDispose(nb);
      }),
      this._onDidChange,
    );
  }

  setCandidates(candidates: KernelCandidate[]): void {
    this.allCandidates = candidates;
  }

  private key(nb: vscode.NotebookDocument): string {
    return nb.uri.toString();
  }

  setSelectedController(nb: vscode.NotebookDocument, controller: ControllerLike | undefined): void {
    const key = this.key(nb);
    if (controller) this.selections.set(key, controller);
    else if (this.selections.get(key)) this.selections.delete(key);
    this._onDidChange.fire(nb);
  }

  getSelectedController(nb: vscode.NotebookDocument): ControllerLike | undefined {
    return this.selections.get(this.key(nb));
  }

  getSession(nb: vscode.NotebookDocument): KernelSession | undefined {
    return this.entries.get(this.key(nb))?.session;
  }

  kernelInfo(nb: vscode.NotebookDocument): KernelInfo {
    const sel = this.getSelectedController(nb);
    const entry = this.entries.get(this.key(nb));
    const session = entry?.session;
    return {
      status: !sel ? 'none' : !session ? 'not-started' : session.status,
      displayName: sel?.candidate.label ?? null,
      controllerId: sel?.id ?? null,
      pythonPath: sel?.candidate.pythonPath ?? null,
      sessionId: session?.sessionId ?? null,
      agentActivity: session?.agentActivity ?? null,
    };
  }

  private cwdFor(nb: vscode.NotebookDocument): string {
    if (nb.uri.scheme === 'file') return path.dirname(nb.uri.fsPath);
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.fsPath ?? os.tmpdir();
  }

  /** Get the live session for the notebook, starting one for the selected controller if needed. */
  async ensureSession(nb: vscode.NotebookDocument, controller: ControllerLike): Promise<KernelSession> {
    if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted: kernels are disabled');
    const key = this.key(nb);
    const existing = this.entries.get(key);
    if (existing && existing.candidate.id === controller.candidate.id && !existing.session.isDisposed && existing.session.status !== 'dead') {
      return existing.session;
    }
    if (existing) {
      this.logger.info(`replacing session for ${path.basename(nb.uri.fsPath)} (${existing.candidate.label} -> ${controller.candidate.label})`);
      await existing.session.dispose();
      this.entries.delete(key);
    }
    const spec = await this.launchSpecFor(controller.candidate, nb);
    const session = new KernelSession(spec, this.logger);
    const entry: SessionEntry = { session, candidate: controller.candidate, cwd: spec.cwd };
    this.entries.set(key, entry);
    session.onDidChangeStatus((s) => {
      this._onDidChange.fire(nb);
      if (s === 'dead' && !session.isDisposed) this.notifyKernelDead(nb, controller);
    });
    session.onDidChangeAgentActivity(() => this._onDidChange.fire(nb));
    this._onDidChange.fire(nb);
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting ${controller.candidate.label}…`, cancellable: false },
        () => session.start(),
      );
    } catch (e) {
      this.entries.delete(key);
      this._onDidChange.fire(nb);
      throw e;
    }
    this.logger.info(`kernel started for ${path.basename(nb.uri.fsPath)}: ${controller.candidate.label}`);
    return session;
  }

  private async launchSpecFor(candidate: KernelCandidate, nb: vscode.NotebookDocument) {
    const hostScript = this.context.asAbsolutePath(path.join('python', 'qmd_kernel_host.py'));
    const startupTimeoutMs = getSetting<number>('execution.startupTimeoutSeconds', 60) * 1000;
    const cwd = this.cwdFor(nb);
    if (candidate.kind === 'python-env') {
      const python = candidate.pythonPath!;
      if (!(await this.discovery.hasJupyterClient(python))) {
        await this.offerInstallIpykernel(candidate);
        throw new Error(`ipykernel is not installed in ${candidate.label} (${python})`);
      }
      return {
        hostPython: python,
        hostScript,
        argv: [python, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
        displayName: candidate.label,
        cwd,
        startupTimeoutMs,
      };
    }
    const hostPython = await this.discovery.hostPythonForKernelspec(candidate, this.allCandidates);
    if (!hostPython) {
      throw new Error(`No Python interpreter with jupyter_client was found to launch kernelspec "${candidate.kernelName}". Select a Python environment kernel instead, or install ipykernel in one of your environments.`);
    }
    return { hostPython, hostScript, kernelName: candidate.kernelName, displayName: candidate.label, cwd, startupTimeoutMs };
  }

  private async offerInstallIpykernel(candidate: KernelCandidate): Promise<void> {
    const python = candidate.pythonPath!;
    const choice = await vscode.window.showErrorMessage(
      `The selected environment "${candidate.label}" does not have ipykernel installed.`,
      { modal: false },
      'Install ipykernel',
      'Show Interpreter Path',
    );
    if (choice === 'Show Interpreter Path') {
      void vscode.window.showInformationMessage(python);
      return;
    }
    if (choice !== 'Install ipykernel') return;
    const hasPip = (await probePython(python, 'import pip')) !== null;
    let command: string;
    if (hasPip) command = `"${python}" -m pip install ipykernel`;
    else if (fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'uv')) || process.env.PATH?.split(path.delimiter).some((d) => fs.existsSync(path.join(d, 'uv')))) {
      command = `uv pip install --python "${python}" ipykernel`;
    } else command = `"${python}" -m ensurepip --upgrade && "${python}" -m pip install ipykernel`;
    const terminal = vscode.window.createTerminal({ name: 'QMD Notebook: install ipykernel' });
    terminal.show();
    terminal.sendText(command, true);
    this.discovery.invalidateProbe(python);
    void vscode.window.showInformationMessage('After the installation finishes, run the cell again.');
  }

  private notifyKernelDead(nb: vscode.NotebookDocument, controller: ControllerLike): void {
    void vscode.window
      .showWarningMessage(`The kernel for ${path.basename(nb.uri.fsPath)} died.`, 'Restart Kernel', 'Show Log')
      .then(async (choice) => {
        if (choice === 'Restart Kernel') {
          await this.restart(nb, controller).catch((e) => vscode.window.showErrorMessage(String(e)));
        } else if (choice === 'Show Log') this.logger.show();
      });
  }

  async runCells(nb: vscode.NotebookDocument, cells: vscode.NotebookCell[], controller: ControllerLike, options: { force?: boolean } = {}): Promise<CellRunResult[]> {
    const results: CellRunResult[] = [];
    let session: KernelSession;
    try {
      session = await this.ensureSession(nb, controller);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.error(`kernel start failed: ${message}`);
      void vscode.window.showErrorMessage(`QMD Notebook: ${message}`);
      for (const cell of cells) {
        const exec = controller.controller.createNotebookCellExecution(cell);
        exec.start(Date.now());
        exec.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error({ name: 'KernelStartError', message })]));
        exec.end(false, Date.now());
        results.push({ success: false, skipped: false, executionOrder: null, outcome: null, outputs: [], error: { name: 'KernelStartError', message, traceback: [] }, durationMs: 0 });
      }
      return results;
    }
    const stopOnError = getSetting<boolean>('execution.stopOnError', true);
    let stop = false;
    for (const cell of cells) {
      if (cell.kind !== vscode.NotebookCellKind.Code) continue;
      if (stop) {
        results.push(skipCell(controller.controller, cell));
        continue;
      }
      const rec = cellRecord(cell);
      if (!options.force && isEvalDisabled(rec?.options)) {
        vscode.window.setStatusBarMessage('$(circle-slash) QMD: skipped cell with `#| eval: false` (use Force Run Cell to run it)', 4000);
        results.push(skipCell(controller.controller, cell));
        continue;
      }
      const promise = runCell(session, controller.controller, cell, { stopOnError, trailingOutputs: () => this.trailingOutputs?.(cell) ?? [] });
      this.cellRuns.set(cell, promise);
      const runningId = cellIdOf(cell);
      if (runningId) this.runningCells.add(runningId);
      this._onDidChange.fire(nb);
      let result: CellRunResult;
      try {
        result = await promise;
      } finally {
        if (runningId) this.runningCells.delete(runningId);
        this._onDidChange.fire(nb);
      }
      results.push(result);
      if (result.success === false && stopOnError && cells.length > 1) stop = true;
    }
    return results;
  }

  waitForCell(cell: vscode.NotebookCell): Promise<CellRunResult> | undefined {
    return this.cellRuns.get(cell);
  }

  private trailingOutputs: ((cell: vscode.NotebookCell) => vscode.NotebookCellOutput[]) | undefined;

  /** Outputs to re-attach at the end of every run (comment threads live in transient outputs). */
  setTrailingOutputsProvider(provider: (cell: vscode.NotebookCell) => vscode.NotebookCellOutput[]): void {
    this.trailingOutputs = provider;
  }

  isRunning(cell: vscode.NotebookCell): boolean {
    const id = cellIdOf(cell);
    return !!id && this.runningCells.has(id);
  }

  async executeScratch(nb: vscode.NotebookDocument, code: string, options: { timeoutMs?: number; maxBytes?: number; label?: string } = {}): Promise<ScratchResult> {
    const controller = this.getSelectedController(nb);
    if (!controller) throw new Error('No kernel selected for this notebook. Ask the user to pick a kernel with the notebook kernel picker.');
    const session = await this.ensureSession(nb, controller);
    const maxBytes = options.maxBytes ?? getSetting<number>('agent.maxTextBytes', 200000);
    const records: OutputRecord[] = [];
    const sink: OutputSink = {
      append: (o) => records.push(o),
      appendItems: () => undefined,
      replaceItems: () => undefined,
      clear: () => (records.length = 0),
    };
    const acc = new OutputAccumulator(sink);
    let outcome: ExecutionOutcome;
    const started = Date.now();
    try {
      outcome = await session.execute(
        { code, kind: 'scratch', label: options.label ?? 'agent scratch execution', allowStdin: false, storeHistory: false, timeoutMs: options.timeoutMs ?? 60000 },
        (ev) => {
          if (ev.type === 'iopub') acc.handle(ev.msg);
        },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { success: false, timedOut: false, durationMs: Date.now() - started, stdout: '', stderr: '', results: [], displays: [], error: { name: 'KernelError', message }, truncated: false };
    }
    let budget = maxBytes;
    let truncated = false;
    const take = (items: OutputItem[]): OutputItemSummary[] =>
      items.map((i) => {
        const isText = !i.mime.startsWith('image/') || i.mime === 'image/svg+xml';
        if (!isText) {
          return { mime: i.mime, bytes: i.data.byteLength };
        }
        const { text, truncated: t } = itemText(i, Math.max(0, budget));
        budget -= text.length;
        if (t) truncated = true;
        return { mime: i.mime, bytes: i.data.byteLength, text, truncated: t };
      });
    const stdout = records.filter((r) => r.kind === 'stream' && r.streamName === 'stdout').flatMap((r) => r.items).map((i) => Buffer.from(i.data).toString('utf8')).join('');
    const stderr = records.filter((r) => r.kind === 'stream' && r.streamName === 'stderr').flatMap((r) => r.items).map((i) => Buffer.from(i.data).toString('utf8')).join('');
    const cap = (s: string) => {
      if (s.length > budget) {
        truncated = true;
        const out = s.slice(0, Math.max(0, budget));
        budget = 0;
        return out;
      }
      budget -= s.length;
      return s;
    };
    const results = records.filter((r) => r.kind === 'execute_result').flatMap((r) => take(r.items.filter((i) => i.mime !== STDOUT_MIME && i.mime !== STDERR_MIME)));
    const displays = records.filter((r) => r.kind === 'display_data').flatMap((r) => take(r.items));
    return {
      success: outcome.success,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
      stdout: cap(stdout),
      stderr: cap(stderr),
      results,
      displays,
      error: acc.lastError ? { name: acc.lastError.ename, message: acc.lastError.evalue, traceback: acc.lastError.traceback.slice(-30) } : null,
      truncated,
    };
  }

  async listVariables(nb: vscode.NotebookDocument, maxCount = 200): Promise<unknown> {
    const r = await this.executeScratch(nb, listVariablesCode(maxCount), { label: 'agent: list variables', timeoutMs: 30000 });
    const parsed = extractJson(r.stdout);
    if (parsed === undefined) return { error: r.error ?? { name: 'InspectionError', message: 'no structured result' }, stderr: r.stderr };
    return parsed;
  }

  async summarizeVariable(nb: vscode.NotebookDocument, name: string, maxRows = 10, maxChars = 4000): Promise<unknown> {
    const r = await this.executeScratch(nb, summarizeVariableCode(name, maxRows, maxChars), { label: `agent: summarize ${name}`, timeoutMs: 30000 });
    const parsed = extractJson(r.stdout);
    if (parsed === undefined) return { error: r.error ?? { name: 'InspectionError', message: 'no structured result' }, stderr: r.stderr };
    return parsed;
  }

  async interrupt(nb: vscode.NotebookDocument): Promise<void> {
    await this.getSession(nb)?.interrupt();
  }

  async restart(nb: vscode.NotebookDocument, controller?: ControllerLike): Promise<void> {
    const entry = this.entries.get(this.key(nb));
    if (entry && !entry.session.isDisposed) {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Restarting kernel…' }, () => entry.session.restart());
      this._onDidChange.fire(nb);
      return;
    }
    const sel = controller ?? this.getSelectedController(nb);
    if (!sel) throw new Error('No kernel selected');
    if (entry) this.entries.delete(this.key(nb));
    await this.ensureSession(nb, sel);
  }

  async shutdown(nb: vscode.NotebookDocument): Promise<void> {
    const key = this.key(nb);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await entry.session.dispose();
    this._onDidChange.fire(nb);
  }

  private scheduleDispose(nb: vscode.NotebookDocument): void {
    const key = this.key(nb);
    const entry = this.entries.get(key);
    if (!entry) return;
    const seconds = getSetting<number>('execution.retainKernelOnSourceSwitchSeconds', 600);
    if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
    if (seconds <= 0) {
      void this.shutdown(nb);
      return;
    }
    this.logger.info(`notebook closed; keeping kernel alive for ${seconds}s`);
    entry.disposeTimer = setTimeout(() => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
        void entry.session.dispose();
        this.logger.info(`kernel for ${path.basename(nb.uri.fsPath)} shut down after grace period`);
      }
    }, seconds * 1000);
  }

  private cancelScheduledDispose(nb: vscode.NotebookDocument): void {
    const entry = this.entries.get(this.key(nb));
    if (entry?.disposeTimer) {
      clearTimeout(entry.disposeTimer);
      entry.disposeTimer = undefined;
      this.logger.info(`notebook reopened; reusing live kernel ${entry.candidate.label}`);
    }
  }

  liveSessions(): Array<{ uri: string; candidate: KernelCandidate; session: KernelSession }> {
    return Array.from(this.entries.entries()).map(([uri, e]) => ({ uri, candidate: e.candidate, session: e.session }));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const [, entry] of this.entries) {
      if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
      void entry.session.dispose();
    }
    this.entries.clear();
  }
}
