import * as os from 'node:os';
import * as vscode from 'vscode';
import { AgentSurfaces } from './agent/agentSurfaces';
import { registerAskCommands } from './agent/askCommands';
import { BridgeServer } from './agent/bridgeServer';
import { CommentBridge } from './agent/commentThreads';
import { documentIdFor, trackContentVersions } from './agent/notebookService';
import { NotebookService } from './agent/notebookService';
import { RequestStore } from './agent/requestStore';
import { RequestsView } from './agent/requestsView';
import { ControllerManager } from './execution/controller';
import { KernelDiscovery } from './execution/kernelProvider';
import { SessionRegistry } from './execution/sessionRegistry';
import { CellIdentityTracker, cellIdOf } from './notebook/identity';
import { QmdSerializer, SERIALIZER_OPTIONS } from './notebook/serializer';
import { NOTEBOOK_TYPE, getSetting } from './util/config';
import { Logger } from './util/logger';
import { QmdCellStatusBarProvider } from './ux/cellStatusBar';
import { registerCommands } from './ux/commands';
import { QmdDiagnostics } from './ux/diagnostics';
import { StatusBar } from './ux/statusBar';

/** Exposed for integration tests. */
export interface QmdExtensionApi {
  registry: SessionRegistry;
  controllers: ControllerManager;
  requests: RequestStore;
  service: NotebookService;
  bridge: () => BridgeServer | undefined;
  logger: Logger;
  cellIdOf: (cell: vscode.NotebookCell) => string | null;
  comments: CommentBridge;
}

let bridge: BridgeServer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<QmdExtensionApi> {
  const logger = new Logger();
  context.subscriptions.push(logger);
  const version = String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0');
  logger.info(`QMD Notebook ${version} activating (VS Code ${vscode.version}, ${vscode.env.remoteName ?? 'local'})`);

  context.subscriptions.push(vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new QmdSerializer(), SERIALIZER_OPTIONS));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('qmdNotebook.logging') && logger.refreshLevel()));

  const discovery = new KernelDiscovery(logger);
  const registry = new SessionRegistry(context, logger, discovery);
  const controllers = new ControllerManager(registry, discovery, logger);
  context.subscriptions.push(registry, controllers);
  void controllers.refresh().catch((e) => logger.error(`kernel discovery failed: ${String(e)}`));

  const identity = new CellIdentityTracker();
  const diagnostics = new QmdDiagnostics();
  const requests = new RequestStore(context);
  const cellStatus = new QmdCellStatusBarProvider(requests);
  const statusBar = new StatusBar(registry, requests);
  const comments = new CommentBridge(requests, registry, logger);
  registry.setTrailingOutputsProvider((cell) => comments.commentOutputsFor(cell));
  context.subscriptions.push(identity, diagnostics, requests, cellStatus, statusBar, comments, trackContentVersions());
  context.subscriptions.push(
    vscode.workspace.onDidCloseNotebookDocument((nb) => {
      if (nb.notebookType === NOTEBOOK_TYPE) requests.notebookClosed(documentIdFor(nb));
    }),
  );

  const surfaces = new AgentSurfaces(context, logger, () => bridge, requests);
  const requestsView = new RequestsView(requests);
  context.subscriptions.push(surfaces, requestsView);

  const service = new NotebookService({
    registry,
    requests,
    logger,
    extensionVersion: version,
    instanceId: () => bridge?.instanceId ?? 'none',
    connectedClients: () => bridge?.connectedClients.length ?? 0,
    onAgentTouchedCell: (cellId, label) => cellStatus.markAgentTouched(cellId, label),
    imageAttachment: (requestId, imageId) => comments.imageAttachment(requestId, imageId),
  });

  const updateBridgeStatus = () => statusBar.setBridgeSummary({ enabled: !!bridge?.isRunning, clients: bridge?.connectedClients.length ?? 0, pending: requests.list('pending').length });
  const startBridge = async () => {
    if (bridge || !getSetting<boolean>('agent.enableBridge', true)) return;
    bridge = new BridgeServer((method, params, client) => service.handle(method, params, client), logger, version);
    try {
      await bridge.start();
      context.subscriptions.push(
        bridge.onDidChangeClients(() => {
          requests.pruneAssignments(bridge?.connectedClients.map((c) => c.id) ?? []);
          updateBridgeStatus();
        }),
      );
    } catch (e) {
      logger.error(`agent bridge failed to start: ${String(e)}`);
      bridge.dispose();
      bridge = undefined;
    }
    updateBridgeStatus();
  };
  await startBridge();
  context.subscriptions.push(
    requests.onDidChange(updateBridgeStatus),
    vscode.workspace.onDidChangeWorkspaceFolders(() => bridge?.writeRecord()),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('qmdNotebook.agent.enableBridge')) return;
      if (getSetting<boolean>('agent.enableBridge', true)) await startBridge();
      else {
        bridge?.dispose();
        bridge = undefined;
        updateBridgeStatus();
      }
    }),
    { dispose: () => bridge?.dispose() },
  );

  const diagnosticReport = (): string => {
    const lines = [
      `QMD Notebook ${version}`,
      `VS Code ${vscode.version} (${vscode.env.appName}, remote: ${vscode.env.remoteName ?? 'none'})`,
      `Platform ${process.platform} ${os.release()} node ${process.versions.node}`,
      `Workspace trusted: ${vscode.workspace.isTrusted}`,
      `Execution backend: ${getSetting('execution.backend', 'auto')} (jupyter_client host helper)`,
      `Controllers: ${controllers.all.length}`,
      ...controllers.all.map((c) => `  - ${c.candidate.label} [${c.candidate.kind}] ${c.candidate.pythonPath ?? c.candidate.kernelName ?? ''}`),
      `Live sessions: ${registry.liveSessions().length}`,
      ...registry.liveSessions().map((s) => `  - ${s.uri.split('/').pop()} → ${s.candidate.label}: ${s.session.status}`),
      `Bridge: ${bridge?.isRunning ? `running at ${bridge.endpoint}` : 'not running'}; clients: ${bridge?.connectedClients.map((c) => c.name).join(', ') || 'none'}`,
      `Requests: ${requests.list('all').length} total, ${requests.list('pending').length} pending`,
      `Open QMD notebooks: ${vscode.workspace.notebookDocuments.filter((n) => n.notebookType === NOTEBOOK_TYPE).length}`,
      'Recent warnings/errors:',
      ...logger.recentProblems().map((l) => `  ${l}`),
    ];
    return lines.join('\n');
  };

  context.subscriptions.push(
    ...registerCommands({ context, registry, controllers, logger, diagnosticReport }),
    ...registerAskCommands({ requests, registry, surfaces, comments, logger }),
    vscode.commands.registerCommand('qmdNotebook.agentConnectionStatus', () => surfaces.connectionStatus(() => JSON.stringify(service.status(), null, 2))),
    vscode.commands.registerCommand('qmdNotebook.configureAgents', () => surfaces.configureAgents()),
    vscode.commands.registerCommand('qmdNotebook.copyMcpServerPath', async () => {
      const launch = await surfaces.mcpLaunch();
      await vscode.env.clipboard.writeText(`${launch.command} ${launch.args.join(' ')}`);
      void vscode.window.showInformationMessage(`Copied: ${launch.command} ${launch.args.join(' ')}`);
    }),
  );

  if (!vscode.workspace.isTrusted) {
    context.subscriptions.push(
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        logger.info('workspace trust granted');
        statusBar.update();
      }),
    );
  }

  logger.info('QMD Notebook activated');
  return { registry, controllers, requests, service, bridge: () => bridge, logger, cellIdOf, comments };
}

export function deactivate(): void {
  bridge?.dispose();
  bridge = undefined;
}
