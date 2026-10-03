import * as vscode from 'vscode';
import { OutputAccumulator, type OutputItem, type OutputRecord, type OutputSink } from './outputModel';
import type { ExecutionOutcome, KernelSession } from './session';

export interface CellRunResult {
  success: boolean | null;
  skipped: boolean;
  executionOrder: number | null;
  outcome: ExecutionOutcome | null;
  outputs: OutputRecord[];
  error: { name: string; message: string; traceback: string[] } | null;
  durationMs: number;
}

class VsCodeOutputSink implements OutputSink {
  private readonly map = new WeakMap<OutputRecord, vscode.NotebookCellOutput>();

  constructor(private readonly execution: vscode.NotebookCellExecution) {}

  private toItems(items: OutputItem[]): vscode.NotebookCellOutputItem[] {
    return items.map((i) => new vscode.NotebookCellOutputItem(i.data, i.mime));
  }

  append(output: OutputRecord): void {
    const nb = new vscode.NotebookCellOutput(this.toItems(output.items), output.metadata);
    this.map.set(output, nb);
    void this.execution.appendOutput(nb);
  }

  appendItems(output: OutputRecord, items: OutputItem[]): void {
    const nb = this.map.get(output);
    if (!nb) return;
    void this.execution.appendOutputItems(this.toItems(items), nb);
  }

  replaceItems(output: OutputRecord, items: OutputItem[]): void {
    const nb = this.map.get(output);
    if (!nb) return;
    void this.execution.replaceOutputItems(this.toItems(items), nb);
  }

  clear(): void {
    void this.execution.clearOutput();
  }
}

/** Execute one code cell in the session and mirror outputs into the NotebookCellExecution. */
export async function runCell(
  session: KernelSession,
  controller: vscode.NotebookController,
  cell: vscode.NotebookCell,
  options: { stopOnError?: boolean; trailingOutputs?: () => vscode.NotebookCellOutput[] } = {},
): Promise<CellRunResult> {
  const execution = controller.createNotebookCellExecution(cell);
  const started = Date.now();
  execution.start(started);
  execution.clearOutput();
  // UI outputs that must survive the run (comment threads) are re-attached by the run itself, so
  // nothing has to replay an execution afterwards and race with the fresh outputs.
  const finish = (success: boolean | undefined, endTime: number) => {
    const trailing = options.trailingOutputs?.() ?? [];
    if (trailing.length) execution.appendOutput(trailing);
    execution.end(success, endTime);
  };
  const sink = new VsCodeOutputSink(execution);
  const acc = new OutputAccumulator(sink);
  let outcome: ExecutionOutcome | null = null;
  try {
    outcome = await session.execute(
      {
        code: cell.document.getText(),
        kind: 'cell',
        allowStdin: true,
        storeHistory: true,
        stopOnError: options.stopOnError ?? true,
      },
      (ev) => {
        if (ev.type === 'iopub') {
          acc.handle(ev.msg);
          if (acc.executionCount !== null) execution.executionOrder = acc.executionCount;
        } else if (ev.type === 'input_request') {
          void vscode.window
            .showInputBox({ prompt: ev.prompt || 'Input requested by the kernel', password: ev.password, ignoreFocusOut: true })
            .then((value) => ev.reply(value ?? ''));
        }
      },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    execution.appendOutput(
      new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error({ name: 'KernelError', message })]),
    );
    finish(false, Date.now());
    return {
      success: false,
      skipped: false,
      executionOrder: null,
      outcome: null,
      outputs: acc.outputs,
      error: { name: 'KernelError', message, traceback: [] },
      durationMs: Date.now() - started,
    };
  }
  if (outcome.cancelled && outcome.reply.status === 'aborted') {
    // queued cell dropped by an interrupt: leave no verdict
    finish(undefined, Date.now());
    return { success: null, skipped: true, executionOrder: null, outcome, outputs: acc.outputs, error: null, durationMs: Date.now() - started };
  }
  finish(outcome.success, Date.now());
  const err = acc.lastError
    ? { name: acc.lastError.ename, message: acc.lastError.evalue, traceback: acc.lastError.traceback }
    : outcome.reply.status === 'error'
      ? { name: String(outcome.reply.ename ?? 'Error'), message: String(outcome.reply.evalue ?? ''), traceback: outcome.reply.traceback ?? [] }
      : null;
  return {
    success: outcome.success,
    skipped: false,
    executionOrder: acc.executionCount,
    outcome,
    outputs: acc.outputs,
    error: err,
    durationMs: Date.now() - started,
  };
}

/** Mark a cell as skipped (e.g. `#| eval: false`) without touching its outputs. */
export function skipCell(controller: vscode.NotebookController, cell: vscode.NotebookCell): CellRunResult {
  const execution = controller.createNotebookCellExecution(cell);
  execution.start(Date.now());
  execution.end(undefined, Date.now());
  return { success: null, skipped: true, executionOrder: null, outcome: null, outputs: [], error: null, durationMs: 0 };
}
