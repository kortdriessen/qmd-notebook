/**
 * Adapters to the agent clients' documented surfaces (Spike E):
 *  - Claude Code VS Code extension: `claude-vscode.focus` (documented Cmd/Ctrl+Esc "focus input").
 *  - Codex VS Code extension: `chatgpt.openSidebar`.
 *  - CLI: a managed integrated terminal running `claude` / `codex` (Mode C, experimental).
 *  - MCP registration (user-level by default, project-level optional) and the rules / focus
 *    command for Claude Code and user-wide skill for Codex.
 * Only commands contributed by those extensions are used; there is no undocumented composer API.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { focusNotebookPrompt } from '@qmd-notebook/shared';
import { codexFocusSkillDirectory, installCodexFocusSkill } from './codexSkill';
import { getSetting } from '../util/config';
import type { Logger } from '../util/logger';
import type { BridgeServer } from './bridgeServer';
import type { RequestStore } from './requestStore';

export type AgentClientKind = 'claude' | 'codex' | 'none';

export const AGENT_RULES_SNIPPET = `## Live QMD notebooks

When the QMD Notebook MCP tools are available:

- Treat the open VS Code NotebookDocument as authoritative for notebook content.
- Never edit an open \`.qmd\` notebook through filesystem text replacement.
- Use QMD Notebook tools to read and edit cells by runtime cell ID.
- Treat the selected live kernel as authoritative for Python runtime state.
- Use structured variable-inspection tools or scratch execution for temporary diagnostics.
- Do not add notebook cells merely to inspect variables.
- Edit with the cell's sourceHash you already hold (comment packet, previous read or edit result); call read_cell only when you have none. Edits are guarded per cell: the user editing other cells never conflicts with yours.
- For changes inside a cell use edit_cell_text (exact oldText → newText pairs, like a file edit) instead of resending the whole cell; replace_cell_source is for rewrites.
- If an edit conflicts, rebase on the current source returned in the error; never overwrite the user's concurrent change.
- After modifying a Python cell, execute it unless the user asks not to or execution is unsafe/expensive (execute: true on the edit call does both in one step).
- Every tool call is a full model turn: prefer one edit-and-run call over read, edit, run, read.
- Keep a cell's leading \`#|\` option lines (Quarto cell options such as label, fig-cap, eval) when you rewrite it, unless the change is about them.
- Inspect the resulting output or error before claiming completion.
- Put durable explanatory code/comments in the QMD only when useful; keep transient reasoning in the request thread.

Comment workflow: when asked to focus on a notebook (the \`focus_notebook\` prompt, Claude Code's \`/focus-notebook\`, or Codex's \`$focus-notebook\` skill),
call \`assign_notebook\`, then loop on \`wait_for_comments\` with no timeoutMs (it returns the moment a
comment arrives). Each comment is a full packet (prompt, attached cell source + current sourceHash,
notebook version, selection/output preview, neighbours, thread, pasted images as image content or, in Codex, as file paths to open with view_image), so do not re-read it: make the edit with
\`requestId\` + a one-line \`note\` (shown in the thread) and \`execute: true\`, then \`resolve_request\` with
your reply. Keep looping until told to stop or \`wait_for_comments\` returns \`stopped: true\`.
`;

/** Slash-command body for Claude Code (.claude/commands). Codex uses the bundled skill. */
export const FOCUS_COMMAND_MARKDOWN = `---
description: Watch a QMD notebook open in VS Code and handle the comments the user adds in it
---

${focusNotebookPrompt('$ARGUMENTS')}
`;

export type ConfigScope = 'user' | 'project';

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [cmd], { timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout.toString().split(/\r?\n/)[0]?.trim() || null));
  });
}

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 30000, env: { ...process.env } }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** Codex allows an MCP tool call 60 s by default; long-polls need more. 4 h 5 min leaves room for --max-wait 4h. */
export const CODEX_TOOL_TIMEOUT_SEC = 14700;
export const CODEX_MAX_WAIT_ARGS = ['--max-wait', '4h'];

/**
 * Set `tool_timeout_sec` inside the `[mcp_servers.qmd_notebook]` table of a Codex config.toml
 * (inserted after the table header, or updated in place). Returns true when the file changed.
 */
export function ensureCodexToolTimeout(file: string, seconds = CODEX_TOOL_TIMEOUT_SEC): boolean {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const header = lines.findIndex((l) => /^\s*\[mcp_servers\.qmd_notebook\]\s*$/.test(l));
  if (header < 0) return false;
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const line = `tool_timeout_sec = ${seconds}`;
  for (let i = header + 1; i < end; i++) {
    const m = /^\s*tool_timeout_sec\s*=\s*(\d+)/.exec(lines[i]!);
    if (m) {
      if (Number(m[1]) >= seconds) return false;
      lines[i] = line;
      fs.writeFileSync(file, lines.join('\n'));
      return true;
    }
  }
  lines.splice(header + 1, 0, line);
  fs.writeFileSync(file, lines.join('\n'));
  return true;
}

/**
 * Append the rules section, or replace an existing one (from its heading to the next `## `
 * heading or the end of the file) when its text changed, so re-running the configure command
 * upgrades the rules in place. Returns true when the file was written.
 */
export function appendSection(file: string, marker: string, section: string): boolean {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const start = current.indexOf(marker);
  if (start >= 0) {
    const nextHeading = current.indexOf('\n## ', start + marker.length);
    const end = nextHeading >= 0 ? nextHeading + 1 : current.length;
    const existing = current.slice(start, end);
    const fresh = section.replace(/\s*$/, '\n') + (nextHeading >= 0 ? '\n' : '');
    if (existing.replace(/\s+$/, '') === fresh.replace(/\s+$/, '')) return false;
    fs.writeFileSync(file, current.slice(0, start) + fresh + current.slice(end));
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (current ? current.replace(/\s*$/, '\n\n') : '') + section);
  return true;
}

export class AgentSurfaces implements vscode.Disposable {
  private readonly liveTerminals = new Map<AgentClientKind, vscode.Terminal>();
  private readonly disposables: vscode.Disposable[] = [];
  private confirmedSend = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
    private readonly bridge: () => BridgeServer | undefined,
    private readonly requests: RequestStore,
  ) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((t) => {
        for (const [k, v] of this.liveTerminals) if (v === t) this.liveTerminals.delete(k);
      }),
    );
    this.refreshStableCompanion();
    // Test extension hosts must not install into the developer's real user-wide skill directory.
    if (context.extensionMode !== vscode.ExtensionMode.Test && getSetting<boolean>('agent.installCodexSkill', true)) {
      this.refreshCodexSkill();
    }
  }

  preferredClient(): AgentClientKind {
    return getSetting<AgentClientKind>('agent.preferredClient', 'claude');
  }

  hasExtension(kind: AgentClientKind): boolean {
    if (kind === 'claude') return !!vscode.extensions.getExtension('anthropic.claude-code');
    if (kind === 'codex') return !!vscode.extensions.getExtension('openai.chatgpt');
    return false;
  }

  // ------------------------------------------------------------------ focus / live sessions
  /** Focus the agent's composer through its documented command; returns true if something was focused. */
  async focus(kind: AgentClientKind = this.preferredClient()): Promise<boolean> {
    if (kind === 'none') return false;
    const live = this.liveTerminals.get(kind);
    if (live) {
      live.show(false);
      return true;
    }
    const commands = await vscode.commands.getCommands(true);
    try {
      if (kind === 'claude' && commands.includes('claude-vscode.focus')) {
        await vscode.commands.executeCommand('claude-vscode.focus');
        return true;
      }
      if (kind === 'claude' && commands.includes('claude-vscode.sidebar.open')) {
        await vscode.commands.executeCommand('claude-vscode.sidebar.open');
        return true;
      }
      if (kind === 'codex' && commands.includes('chatgpt.openSidebar')) {
        await vscode.commands.executeCommand('chatgpt.openSidebar');
        return true;
      }
    } catch (e) {
      this.logger.warn(`focusing ${kind} failed: ${String(e)}`);
    }
    return false;
  }

  /** Mode C: a managed integrated terminal running the agent CLI in the workspace folder. */
  async startLive(kind: 'claude' | 'codex'): Promise<vscode.Terminal> {
    const existing = this.liveTerminals.get(kind);
    if (existing) {
      existing.show(false);
      return existing;
    }
    const command = getSetting<string>(kind === 'claude' ? 'agent.claudeCommand' : 'agent.codexCommand', kind);
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const terminal = vscode.window.createTerminal({ name: `QMD live ${kind === 'claude' ? 'Claude' : 'Codex'}`, cwd });
    terminal.show(false);
    terminal.sendText(command, true);
    this.liveTerminals.set(kind, terminal);
    this.logger.info(`started live ${kind} session in an integrated terminal`);
    return terminal;
  }

  liveSession(kind: AgentClientKind): vscode.Terminal | undefined {
    return this.liveTerminals.get(kind);
  }

  /** Send a handoff line to a live CLI session. The CLI must be idle at its prompt; we ask once per window. */
  async sendToLive(text: string, kind: AgentClientKind = this.preferredClient()): Promise<boolean> {
    const terminal = this.liveTerminals.get(kind);
    if (!terminal) {
      void vscode.window.showWarningMessage(`No live ${kind} session. Run "QMD Notebook: Start Live ${kind === 'codex' ? 'Codex' : 'Claude'} Session" first.`);
      return false;
    }
    if (!this.confirmedSend) {
      const choice = await vscode.window.showWarningMessage(
        'Send the request to the live agent terminal? The agent must be idle at its prompt (text is typed into the terminal and submitted).',
        { modal: true },
        'Send',
      );
      if (choice !== 'Send') return false;
      this.confirmedSend = true;
    }
    terminal.show(false);
    terminal.sendText(text, true);
    return true;
  }

  // ------------------------------------------------------------------ companion location
  /**
   * A copy of the bundled companion at a path that survives extension upgrades
   * (global storage, not the versioned extension folder), refreshed on activation.
   */
  private stableCompanionPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'qmd-notebook-mcp.js');
  }

  refreshStableCompanion(): void {
    try {
      const bundled = this.context.asAbsolutePath(path.join('dist', 'qmd-notebook-mcp.js'));
      if (!fs.existsSync(bundled)) return;
      const target = this.stableCompanionPath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const src = fs.readFileSync(bundled);
      if (!fs.existsSync(target) || !fs.readFileSync(target).equals(src)) {
        fs.writeFileSync(target, src);
        this.logger.info(`companion refreshed at ${target}`);
      }
    } catch (e) {
      this.logger.warn(`could not refresh the companion copy: ${String(e)}`);
    }
  }

  /** Resolve how agents should launch the MCP companion. */
  async mcpLaunch(): Promise<{ command: string; args: string[]; source: 'path' | 'stable' | 'bundled' }> {
    const onPath = await which('qmd-notebook-mcp');
    if (onPath) return { command: 'qmd-notebook-mcp', args: ['--workspace', '.'], source: 'path' };
    const nodeBin = (await which('node')) ?? 'node';
    const stable = this.stableCompanionPath();
    if (fs.existsSync(stable)) return { command: nodeBin, args: [stable, '--workspace', '.'], source: 'stable' };
    return { command: nodeBin, args: [this.context.asAbsolutePath(path.join('dist', 'qmd-notebook-mcp.js')), '--workspace', '.'], source: 'bundled' };
  }

  // ------------------------------------------------------------------ configuration
  /** Install/upgrade the bundled Codex skill without replacing user-authored or modified files. */
  private refreshCodexSkill(): void {
    try {
      const result = installCodexFocusSkill(this.context.asAbsolutePath(path.join('skills', 'focus-notebook')));
      if (result.status === 'conflict') throw new Error(`An existing or customized skill at ${result.directory} was left unchanged.`);
      if (result.status !== 'unchanged') this.logger.info(`Codex focus-notebook skill ${result.status} at ${result.directory}`);
    } catch (e) {
      this.logger.warn(`Could not install the Codex focus-notebook skill: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async configureAgents(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const scopePick = await vscode.window.showQuickPick(
      [
        { label: 'User level (recommended)', description: 'once for all projects: MCP servers, notebook rules, Claude command, and Codex skill in ~/.agents/skills', scope: 'user' as ConfigScope },
        { label: 'This project only', description: folder ? `.mcp.json, .codex/config.toml, CLAUDE.md, AGENTS.md, .claude/commands in ${path.basename(folder.uri.fsPath)}` : 'requires an open workspace folder', scope: 'project' as ConfigScope },
      ],
      { title: 'QMD Notebook: where should the agent configuration live?' },
    );
    if (!scopePick) return;
    const scope = scopePick.scope;
    if (scope === 'project' && !folder) throw new Error('Open a workspace folder first');
    this.refreshStableCompanion();
    const launch = await this.mcpLaunch();
    const launchText = `${launch.command} ${launch.args.join(' ')}`;
    const items =
      scope === 'user'
        ? [
            { label: 'Claude Code: register MCP server (user scope)', description: `claude mcp add --scope user qmd-notebook -- ${launchText}`, id: 'claude', picked: true },
            { label: 'Codex: register MCP server (user scope)', description: `codex mcp add qmd_notebook -- ${launchText} ${CODEX_MAX_WAIT_ARGS.join(' ')} + tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`, id: 'codex', picked: true },
            { label: 'Add notebook rules to ~/.claude/CLAUDE.md', description: 'the "Live QMD notebooks" section', id: 'claude-md', picked: true },
            { label: 'Add notebook rules to ~/.codex/AGENTS.md', description: 'the "Live QMD notebooks" section', id: 'agents-md', picked: true },
            { label: 'Claude Code: /focus-notebook command', description: '~/.claude/commands/focus-notebook.md (the focus_notebook MCP prompt works without it)', id: 'claude-cmd', picked: true },
            { label: 'Codex: $focus-notebook skill', description: '~/.agents/skills/focus-notebook/ (available in every project)', id: 'codex-skill', picked: true },
          ]
        : [
            { label: 'Claude Code: project .mcp.json', description: launchText, id: 'claude', picked: true },
            { label: 'Codex: project .codex/config.toml', description: 'project-scoped [mcp_servers.qmd_notebook] (loaded once you trust the project in Codex)', id: 'codex', picked: true },
            { label: 'Add notebook rules to CLAUDE.md', description: 'appends the "Live QMD notebooks" section', id: 'claude-md', picked: true },
            { label: 'Add notebook rules to AGENTS.md', description: 'appends the "Live QMD notebooks" section', id: 'agents-md', picked: true },
            { label: 'Claude Code: /focus-notebook command', description: '.claude/commands/focus-notebook.md', id: 'claude-cmd', picked: true },
            { label: 'Codex: $focus-notebook skill (user-wide)', description: '~/.agents/skills/focus-notebook/ (MCP registration still follows the selected scope)', id: 'codex-skill', picked: true },
          ];
    const picks = await vscode.window.showQuickPick(items, { canPickMany: true, title: `QMD Notebook: configure agent access (${scope} level) — nothing is written until you confirm` });
    if (!picks || picks.length === 0) return;
    const done: string[] = [];
    const problems: string[] = [];
    const home = os.homedir();
    for (const p of picks) {
      try {
        switch (p.id) {
          case 'claude': {
            if (scope === 'user') {
              const claude = await which(getSetting<string>('agent.claudeCommand', 'claude'));
              if (!claude) throw new Error('claude CLI not found on PATH; run: claude mcp add --scope user qmd-notebook -- ' + launchText);
              await run(claude, ['mcp', 'remove', '--scope', 'user', 'qmd-notebook']);
              const r = await run(claude, ['mcp', 'add', '--scope', 'user', 'qmd-notebook', '--', launch.command, ...launch.args]);
              if (r.code !== 0) throw new Error(`claude mcp add failed: ${r.stderr || r.stdout}`);
              done.push('Claude Code user-scope MCP server');
            } else {
              const file = path.join(folder!.uri.fsPath, '.mcp.json');
              let json: any = {};
              if (fs.existsSync(file)) json = JSON.parse(fs.readFileSync(file, 'utf8'));
              json.mcpServers = json.mcpServers ?? {};
              json.mcpServers['qmd-notebook'] = { command: launch.command, args: launch.args };
              fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
              done.push('.mcp.json');
            }
            break;
          }
          case 'codex': {
            if (scope === 'user') {
              const codex = await which(getSetting<string>('agent.codexCommand', 'codex'));
              if (!codex) throw new Error('codex CLI not found on PATH; run: codex mcp add qmd_notebook -- ' + launchText);
              await run(codex, ['mcp', 'remove', 'qmd_notebook']);
              const r = await run(codex, ['mcp', 'add', 'qmd_notebook', '--', launch.command, ...launch.args, ...CODEX_MAX_WAIT_ARGS]);
              if (r.code !== 0) throw new Error(`codex mcp add failed: ${r.stderr || r.stdout}`);
              const raised = ensureCodexToolTimeout(path.join(home, '.codex', 'config.toml'));
              done.push(`Codex user-scope MCP server${raised ? ' (tool_timeout_sec raised for long waits)' : ''}`);
            } else {
              const dir = path.join(folder!.uri.fsPath, '.codex');
              const file = path.join(dir, 'config.toml');
              const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
              if (/^\[mcp_servers\.qmd_notebook\]/m.test(current)) done.push('.codex/config.toml (already present)');
              else {
                fs.mkdirSync(dir, { recursive: true });
                const toml = `${current && !current.endsWith('\n') ? current + '\n' : current}${current ? '\n' : ''}[mcp_servers.qmd_notebook]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify([...launch.args, ...CODEX_MAX_WAIT_ARGS])}\ntool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}\n`;
                fs.writeFileSync(file, toml);
                done.push('.codex/config.toml');
              }
            }
            break;
          }
          case 'claude-md': {
            const file = scope === 'user' ? path.join(home, '.claude', 'CLAUDE.md') : path.join(folder!.uri.fsPath, 'CLAUDE.md');
            if (appendSection(file, '## Live QMD notebooks', AGENT_RULES_SNIPPET)) done.push(file.replace(home, '~'));
            break;
          }
          case 'agents-md': {
            const file = scope === 'user' ? path.join(home, '.codex', 'AGENTS.md') : path.join(folder!.uri.fsPath, 'AGENTS.md');
            if (appendSection(file, '## Live QMD notebooks', AGENT_RULES_SNIPPET)) done.push(file.replace(home, '~'));
            break;
          }
          case 'claude-cmd': {
            const dir = scope === 'user' ? path.join(home, '.claude', 'commands') : path.join(folder!.uri.fsPath, '.claude', 'commands');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'focus-notebook.md'), FOCUS_COMMAND_MARKDOWN);
            done.push(path.join(dir, 'focus-notebook.md').replace(home, '~'));
            break;
          }
          case 'codex-skill': {
            const result = installCodexFocusSkill(this.context.asAbsolutePath(path.join('skills', 'focus-notebook')));
            if (result.status === 'conflict') throw new Error(`Existing or customized Codex skill at ${result.directory} left unchanged`);
            done.push(`Codex $focus-notebook skill (${result.status}, ${result.directory.replace(home, '~')})`);
            break;
          }
        }
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (problems.length) this.logger.warn(`configureAgents: ${problems.join(' | ')}`);
    const summary = `QMD Notebook: configured ${done.join(', ') || 'nothing new'}.${problems.length ? ` Problems: ${problems.join(' | ')}` : ''} Restart the agent client to load the MCP server, then use $focus-notebook <name> in Codex.`;
    if (problems.length) void vscode.window.showWarningMessage(summary);
    else void vscode.window.showInformationMessage(summary);
  }

  async connectionStatus(statusText: () => string): Promise<void> {
    const bridge = this.bridge();
    const launch = await this.mcpLaunch();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const home = os.homedir();
    const hasQmd = (f: string | null, re: RegExp) => !!f && fs.existsSync(f) && re.test(fs.readFileSync(f, 'utf8'));
    const claudeUser = hasQmd(path.join(home, '.claude.json'), /qmd-notebook/);
    const claudeProject = hasQmd(folder ? path.join(folder, '.mcp.json') : null, /qmd-notebook/);
    const codexUser = hasQmd(path.join(home, '.codex', 'config.toml'), /qmd[_-]notebook/);
    const codexProject = hasQmd(folder ? path.join(folder, '.codex', 'config.toml') : null, /qmd[_-]notebook/);
    const items: vscode.QuickPickItem[] = [
      { label: bridge?.isRunning ? '$(check) Bridge running' : '$(error) Bridge not running', description: bridge?.endpoint ?? '' },
      { label: `$(plug) Connected agent clients: ${bridge?.connectedClients.length ?? 0}`, description: bridge?.connectedClients.map((c) => c.name).join(', ') ?? '' },
      { label: `$(hubot) Watching agents: ${this.requests.allAssignments().map((a) => a.agentName).join(', ') || 'none'}`, description: `${this.requests.list('pending').length} open comment(s)` },
      { label: `$(file) Discovery record`, description: bridge?.discoveryPath ?? '' },
      { label: `$(terminal) MCP companion`, description: `${launch.command} ${launch.args.join(' ')} (${launch.source})` },
      { label: claudeUser || claudeProject ? `$(check) Claude Code: registered (${[claudeUser ? 'user' : '', claudeProject ? 'project' : ''].filter(Boolean).join(' + ')})` : '$(warning) Claude Code: not registered', description: claudeUser ? '~/.claude.json' : folder ? path.join(folder, '.mcp.json') : '' },
      { label: codexUser || codexProject ? `$(check) Codex: registered (${[codexUser ? 'user' : '', codexProject ? 'project' : ''].filter(Boolean).join(' + ')})` : '$(warning) Codex: not registered', description: codexUser ? '~/.codex/config.toml' : folder ? path.join(folder, '.codex', 'config.toml') : '' },
      { label: fs.existsSync(path.join(codexFocusSkillDirectory(), 'SKILL.md')) ? '$(check) Codex: $focus-notebook skill installed' : '$(warning) Codex: $focus-notebook skill not installed', description: codexFocusSkillDirectory() },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(gear) Configure Claude Code / Codex now', detail: 'configure' },
      { label: '$(copy) Copy status report', detail: 'copy' },
      { label: '$(output) Show log', detail: 'log' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'QMD Notebook: agent connection status', matchOnDescription: true });
    if (!pick) return;
    if (pick.detail === 'configure') await this.configureAgents();
    else if (pick.detail === 'copy') await vscode.env.clipboard.writeText(statusText());
    else if (pick.detail === 'log') this.logger.show();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
