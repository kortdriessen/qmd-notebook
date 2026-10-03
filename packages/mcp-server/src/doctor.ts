/**
 * `qmd-notebook-mcp doctor --workspace .` — checks installation, discovery permissions, bridge
 * reachability, protocol compatibility, active document and kernel, without printing notebook
 * contents or tokens.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROTOCOL_VERSION, type BridgeStatus } from '@qmd-notebook/shared';
import { findBridge, listRecords, matchesWorkspace, runtimeDirs, NoBridgeError } from './discovery';
import { BridgeClient } from './ipcClient';

export async function doctor(workspace: string, version: string): Promise<number> {
  const lines: string[] = [];
  let failures = 0;
  const ok = (msg: string) => lines.push(`  [ok]   ${msg}`);
  const warn = (msg: string) => lines.push(`  [warn] ${msg}`);
  const fail = (msg: string) => {
    failures++;
    lines.push(`  [FAIL] ${msg}`);
  };

  lines.push(`qmd-notebook-mcp ${version} (protocol ${PROTOCOL_VERSION}), node ${process.versions.node}`);
  lines.push(`workspace: ${path.resolve(workspace)}`);
  lines.push('');
  lines.push('Discovery');
  for (const dir of runtimeDirs()) {
    if (!fs.existsSync(dir)) {
      warn(`runtime dir missing: ${dir}`);
      continue;
    }
    const mode = fs.statSync(dir).mode & 0o777;
    if (mode === 0o700) ok(`runtime dir ${dir} (mode 700)`);
    else warn(`runtime dir ${dir} has mode ${mode.toString(8)} (expected 700)`);
  }
  const records = listRecords();
  if (records.length === 0) fail('no bridge discovery records found (is VS Code open with the QMD Notebook extension and a .qmd notebook?)');
  for (const r of records) {
    const rel = matchesWorkspace(r.record, workspace) ? 'matches workspace' : 'other workspace';
    const perm = r.mode === null ? 'mode ?' : r.mode === 0o600 ? 'mode 600' : `mode ${r.mode.toString(8)} (expected 600)`;
    (r.alive ? ok : warn)(`${r.record.instanceId} pid ${r.record.pid} ${r.alive ? 'alive' : 'STALE'} · ${r.record.workspaceFolders.join(', ') || '(no folder)'} · ${rel} · ${perm} · extension ${r.record.extensionVersion} · protocol ${r.record.protocolVersion}`);
    if (r.record.protocolVersion !== PROTOCOL_VERSION) fail(`protocol mismatch: bridge ${r.record.protocolVersion} vs companion ${PROTOCOL_VERSION}; update the extension or the companion`);
  }
  lines.push('');
  lines.push('Bridge');
  let found;
  try {
    found = findBridge(workspace);
    ok(`selected instance ${found.record.instanceId} at ${found.record.socketPath}`);
  } catch (e) {
    fail(e instanceof NoBridgeError ? e.message.split('\n')[0]! : String(e));
    lines.push('');
    console.log(lines.join('\n'));
    return 1;
  }
  const client = new BridgeClient({ workspace, clientName: `qmd-notebook-mcp/${version} doctor` });
  try {
    await client.connect();
    ok('connected and authenticated');
    const status = (await client.call('status', {}, 10000)) as BridgeStatus;
    ok(`extension ${status.extensionVersion} on VS Code ${status.vscodeVersion}${status.remoteName ? ` (remote: ${status.remoteName})` : ''}`);
    (status.workspaceTrusted ? ok : warn)(`workspace trusted: ${status.workspaceTrusted}${status.workspaceTrusted ? '' : ' (execution and edits are disabled until trusted)'}`);
    lines.push('');
    lines.push('Notebooks');
    if (status.notebooks.length === 0) warn('no QMD notebooks are open (Open With → QMD Notebook)');
    for (const nb of status.notebooks) {
      const k = nb.kernel;
      const kernel = k.status === 'none' ? 'no kernel selected' : `${k.displayName} · ${k.status}`;
      (nb.isActive ? ok : warn)(`${nb.displayName} (${nb.documentId})${nb.isActive ? ' [active]' : ''} · ${nb.cellCount} cells · v${nb.version}${nb.isDirty ? ' · dirty' : ''} · ${kernel}`);
    }
    lines.push('');
    ok(`connected agent clients: ${status.connectedClients} · pending requests: ${status.pendingRequests}`);
  } catch (e) {
    fail(`bridge call failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    client.close();
  }
  lines.push('');
  lines.push(failures ? `${failures} problem(s) found.` : 'All checks passed.');
  console.log(lines.join('\n'));
  return failures ? 1 : 0;
}
