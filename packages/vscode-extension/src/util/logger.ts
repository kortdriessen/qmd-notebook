import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { HostLogger } from '../execution/kernelHost';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

export class Logger implements HostLogger {
  private readonly channel: vscode.OutputChannel;
  private level: LogLevel = 'info';
  private readonly recent: string[] = [];
  private filePath: string | null = null;

  constructor(name = 'QMD Notebook') {
    this.channel = vscode.window.createOutputChannel(name);
    this.refreshLevel();
  }

  refreshLevel(): void {
    const config = vscode.workspace.getConfiguration('qmdNotebook');
    this.level = config.get<LogLevel>('logging.level', 'info');
    const file = process.env.QMD_LOG_FILE || config.get<string>('logging.file', '');
    this.filePath = file ? file.replace(/^~(?=\/)/, process.env.HOME ?? '~') : null;
  }

  private write(level: LogLevel, message: string): void {
    if (ORDER[level] > ORDER[this.level]) return;
    const line = `${new Date().toISOString()} [${level}] ${message}`;
    this.channel.appendLine(line);
    if (this.filePath) {
      try {
        fs.appendFileSync(this.filePath, line + '\n');
      } catch {
        /* ignore file logging errors */
      }
    }
    if (level === 'error' || level === 'warn') {
      this.recent.push(line);
      if (this.recent.length > 40) this.recent.shift();
    }
  }

  error(message: string): void {
    this.write('error', message);
  }
  warn(message: string): void {
    this.write('warn', message);
  }
  info(message: string): void {
    this.write('info', message);
  }
  debug(message: string): void {
    this.write('debug', message);
  }
  trace(message: string): void {
    this.write('trace', message);
  }

  /** Recent warnings/errors for the diagnostic report (never contains notebook content). */
  recentProblems(): string[] {
    return [...this.recent];
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
