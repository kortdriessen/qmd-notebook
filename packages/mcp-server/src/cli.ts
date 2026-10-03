/**
 * qmd-notebook-mcp: stdio MCP server bridging Claude Code / Codex to the live QMD Notebook in
 * VS Code.
 *
 *   qmd-notebook-mcp [--workspace <path>] [--max-wait 4h]   start the MCP server (stdio)
 *   qmd-notebook-mcp doctor [--workspace .]                 check installation and bridge connectivity
 */
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { focusNotebookPrompt } from '@qmd-notebook/shared';
import { z } from 'zod';
import { doctor } from './doctor';
import { BridgeClient } from './ipcClient';
import { registerTools, TOOLS } from './tools';

export const VERSION = '0.1.0';

interface Args {
  command: 'serve' | 'doctor' | 'help' | 'version' | 'list-tools';
  workspace: string;
  verbose: boolean;
  /** Longest wait for an omitted long-poll budget (undefined = decide from the MCP client's name). */
  maxWaitMs?: number;
}

/** "90000" (ms), "55s", "10m", "4h" → milliseconds; undefined/invalid → undefined. */
export function parseDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const factor = unit === 'h' ? 3600000 : unit === 'm' ? 60000 : unit === 's' ? 1000 : 1;
  const ms = Math.round(n * factor);
  return ms > 0 ? ms : undefined;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args {
  const args: Args = { command: 'serve', workspace: process.cwd(), verbose: false, maxWaitMs: parseDuration(env.QMD_NOTEBOOK_MAX_WAIT_MS) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--workspace' || a === '-w') args.workspace = path.resolve(argv[++i] ?? '.');
    else if (a.startsWith('--workspace=')) args.workspace = path.resolve(a.slice('--workspace='.length));
    else if (a === '--max-wait') args.maxWaitMs = parseDuration(argv[++i]) ?? args.maxWaitMs;
    else if (a.startsWith('--max-wait=')) args.maxWaitMs = parseDuration(a.slice('--max-wait='.length)) ?? args.maxWaitMs;
    else if (a === '--verbose' || a === '-v') args.verbose = true;
    else if (a === '--help' || a === '-h') args.command = 'help';
    else if (a === '--version' || a === '-V') args.command = 'version';
    else if (a === 'doctor') args.command = 'doctor';
    else if (a === 'serve') args.command = 'serve';
    else if (a === 'list-tools') args.command = 'list-tools';
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      args.command = 'help';
    }
  }
  return args;
}

const HELP = `qmd-notebook-mcp ${VERSION}

Usage:
  qmd-notebook-mcp [--workspace <path>]     run the MCP server over stdio (used by Claude Code / Codex)
  qmd-notebook-mcp doctor [--workspace .]   diagnose installation, discovery and bridge connectivity
  qmd-notebook-mcp list-tools               print the tool surface

Options:
  -w, --workspace <path>   project folder that identifies the VS Code window (default: cwd)
  --max-wait <duration>    longest wait_for_comments long-poll when the agent omits timeoutMs, e.g. 55s, 10m, 4h
                           (default: 4h for Claude Code, 55s for other clients such as Codex, whose
                           tool_timeout_sec defaults to 60; env QMD_NOTEBOOK_MAX_WAIT_MS)
  -v, --verbose            log bridge activity to stderr
  -h, --help               show this help
  -V, --version            show the version
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (args.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.command === 'list-tools') {
    for (const t of TOOLS) process.stdout.write(`${t.name.padEnd(24)} ${t.readOnly ? '[read] ' : '[write]'} ${t.title}\n`);
    return;
  }
  if (args.command === 'doctor') {
    process.exitCode = await doctor(args.workspace, VERSION);
    return;
  }
  const log = (m: string) => {
    if (args.verbose) process.stderr.write(`[qmd-notebook-mcp] ${m}\n`);
  };
  const client = new BridgeClient({ workspace: args.workspace, clientName: `qmd-notebook-mcp/${VERSION}`, log });
  const server = new McpServer(
    { name: 'qmd-notebook', version: VERSION },
    {
      instructions: [
        'Tools for the QMD Notebook open in VS Code. The live NotebookDocument and its kernel are authoritative:',
        'read with read_notebook (outline: true for a cheap map; knownHashes for delta reads) / read_cell, edit with',
        'edit_cell_text (exact oldText → newText pairs, like a file edit; never resend a whole cell for a small change),',
        'replace_cell_source (rewrites) / insert_cell / apply_cell_edits, using the sourceHash you already hold (a comment packet,',
        'a read, or the previous edit result; edits are guarded per cell, never by a notebook-wide version) and',
        'execute: true to run the cell in the same call;',
        'never edit the .qmd file directly while it is open. Inspect state with list_variables / summarize_variable or',
        'execute_scratch instead of adding cells. If a write is rejected with a conflict, rebase on the current source in',
        'the error. Use get_active_context to see what the user has selected. When watching a notebook for comments',
        '(assign_notebook + wait_for_comments without timeoutMs), pass requestId + note to your edit/execute call and',
        'finish with resolve_request. Keep tool calls per task to a minimum: each one is a full model turn.',
      ].join(' '),
    },
  );
  registerTools(server, client, { maxWaitMs: args.maxWaitMs });
  server.registerPrompt(
    'focus_notebook',
    {
      title: 'Focus a QMD notebook',
      description: 'Become the live assistant of a QMD notebook open in VS Code: watch it for comments the user adds to cells, selections and outputs, and handle them with the notebook tools.',
      argsSchema: { notebook: z.string().optional().describe('File name (analysis.qmd), path suffix, or documentId; omit for the active notebook') },
    },
    ({ notebook }) => ({ messages: [{ role: 'user', content: { type: 'text', text: focusNotebookPrompt(notebook) } }] }),
  );
  // Connect eagerly (best effort) so the first tool call is fast and misconfiguration shows in logs.
  client.connect().catch((e) => log(`bridge not reachable yet: ${e instanceof Error ? e.message : String(e)}`));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`serving ${TOOLS.length} tools for workspace ${args.workspace}${args.maxWaitMs ? ` (max wait ${args.maxWaitMs} ms)` : ''}`);
  const shutdown = () => {
    client.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`qmd-notebook-mcp: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  });
}
