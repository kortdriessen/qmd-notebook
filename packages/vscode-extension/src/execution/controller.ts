/**
 * One VS Code NotebookController per discovered kernel candidate, all for the qmd-notebook type.
 */
import * as vscode from 'vscode';
import { NOTEBOOK_TYPE, isQmdNotebook } from '../util/config';
import type { Logger } from '../util/logger';
import { documentRecord } from '../notebook/serializer';
import { KernelDiscovery, type KernelCandidate } from './kernelProvider';
import type { ControllerLike, SessionRegistry } from './sessionRegistry';

export class QmdController implements ControllerLike, vscode.Disposable {
  readonly controller: vscode.NotebookController;
  readonly id: string;

  constructor(
    readonly candidate: KernelCandidate,
    private readonly registry: SessionRegistry,
    private readonly logger: Logger,
  ) {
    this.id = candidate.id;
    this.controller = vscode.notebooks.createNotebookController(candidate.id, NOTEBOOK_TYPE, candidate.label, (cells, notebook) =>
      this.execute(cells, notebook),
    );
    this.controller.supportedLanguages = ['python'];
    this.controller.supportsExecutionOrder = true;
    this.controller.description = candidate.description;
    this.controller.detail = candidate.detail;
    this.controller.interruptHandler = async (notebook) => {
      await this.registry.interrupt(notebook);
    };
    this.controller.onDidChangeSelectedNotebooks(({ notebook, selected }) => {
      if (!isQmdNotebook(notebook)) return;
      if (selected) {
        this.logger.info(`kernel selected: ${candidate.label} for ${notebook.uri.fsPath}`);
        this.registry.setSelectedController(notebook, this);
      } else if (this.registry.getSelectedController(notebook)?.id === this.id) {
        this.registry.setSelectedController(notebook, undefined);
      }
    });
  }

  private async execute(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void> {
    await this.registry.runCells(notebook, cells, this);
  }

  dispose(): void {
    this.controller.dispose();
  }
}

export class ControllerManager implements vscode.Disposable {
  private controllers = new Map<string, QmdController>();
  private readonly disposables: vscode.Disposable[] = [];
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly discovery: KernelDiscovery,
    private readonly logger: Logger,
  ) {
    this.disposables.push(
      vscode.workspace.onDidOpenNotebookDocument((nb) => {
        if (isQmdNotebook(nb)) this.applyAffinity(nb);
      }),
    );
    const pyExt = vscode.extensions.getExtension('ms-python.python');
    if (pyExt) {
      void pyExt.activate().then((api: any) => {
        const ev = api?.environments?.onDidChangeEnvironments;
        if (typeof ev === 'function') this.disposables.push(ev(() => void this.refresh()));
        const active = api?.environments?.onDidChangeActiveEnvironmentPath;
        if (typeof active === 'function') this.disposables.push(active(() => void this.refresh()));
      });
    }
  }

  get all(): QmdController[] {
    return Array.from(this.controllers.values());
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const candidates = await this.discovery.discover(vscode.workspace.workspaceFolders);
    this.registry.setCandidates(candidates);
    const keep = new Set<string>();
    for (const c of candidates) {
      keep.add(c.id);
      const existing = this.controllers.get(c.id);
      if (existing) {
        existing.controller.label = c.label;
        existing.controller.description = c.description;
        existing.controller.detail = c.detail;
        continue;
      }
      this.controllers.set(c.id, new QmdController(c, this.registry, this.logger));
    }
    for (const [id, ctrl] of this.controllers) {
      if (!keep.has(id)) {
        ctrl.dispose();
        this.controllers.delete(id);
      }
    }
    for (const nb of vscode.workspace.notebookDocuments) if (isQmdNotebook(nb)) this.applyAffinity(nb);
  }

  /** Prefer a kernelspec named in front matter (`jupyter: python3`), else the active interpreter. */
  private applyAffinity(nb: vscode.NotebookDocument): void {
    const hint = documentRecord(nb)?.jupyterHint ?? null;
    let preferred: QmdController | undefined;
    if (hint) preferred = this.all.find((c) => c.candidate.kind === 'kernelspec' && c.candidate.kernelName === hint);
    if (!preferred) preferred = this.all.find((c) => c.candidate.description === 'active interpreter');
    for (const c of this.all) {
      c.controller.updateNotebookAffinity(nb, c === preferred ? vscode.NotebookControllerAffinity.Preferred : vscode.NotebookControllerAffinity.Default);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const c of this.controllers.values()) c.dispose();
    this.controllers.clear();
  }
}
