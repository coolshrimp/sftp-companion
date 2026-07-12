import * as vscode from 'vscode';
import { LogEntry } from './types';

export class Logger {
  private readonly output = vscode.window.createOutputChannel('SFTP Companion');
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly logEntries: LogEntry[] = [];

  public readonly onDidChange = this.changeEmitter.event;

  public get entries(): readonly LogEntry[] {
    return this.logEntries;
  }

  public append(level: LogEntry['level'], message: string): void {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      level,
      message,
      timestamp: Date.now()
    };
    this.logEntries.unshift(entry);
    if (this.logEntries.length > 200) {
      this.logEntries.length = 200;
    }
    const prefix = level.toUpperCase().padEnd(5);
    this.output.appendLine(`[${new Date(entry.timestamp).toLocaleTimeString()}] ${prefix} ${message}`);
    this.changeEmitter.fire();
  }

  public reveal(): void {
    this.output.show(true);
  }

  public dispose(): void {
    this.changeEmitter.dispose();
    this.output.dispose();
  }
}
