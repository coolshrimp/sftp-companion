import * as vscode from 'vscode';
import { SyncState } from './types';

export interface SyncDecorationInput {
  state: SyncState;
  isIgnored: boolean;
  isWhitelisted: boolean;
  containsChanges?: boolean;
  label?: string;
}

/**
 * Decorates local files/folders with sync status the same way Git decorates
 * the Explorer: a colored filename plus a badge. Used by the Local Sync tree
 * (whose rows carry real resourceUris for Explorer-identical alignment and
 * file-type icons) and, as a side effect, by the regular Explorer too.
 */
export class SyncDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  public readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly states = new Map<string, { key: string; decoration: vscode.FileDecoration | undefined }>();

  public update(fsPath: string, input: SyncDecorationInput): void {
    const key = [input.state, input.isIgnored, input.isWhitelisted, input.containsChanges === true, input.label ?? ''].join('|');
    const existing = this.states.get(fsPath);
    if (existing?.key === key) {
      return;
    }
    this.states.set(fsPath, { key, decoration: computeDecoration(input) });
    this.emitter.fire(vscode.Uri.file(fsPath));
  }

  public provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.states.get(uri.fsPath)?.decoration;
  }

  public dispose(): void {
    this.emitter.dispose();
    this.states.clear();
  }
}

function computeDecoration(input: SyncDecorationInput): vscode.FileDecoration | undefined {
  const tooltipSuffix = input.label ? ` — ${input.label}` : '';
  if (input.isIgnored) {
    return new vscode.FileDecoration('⊘', `Ignored${tooltipSuffix}`, new vscode.ThemeColor('charts.yellow'));
  }
  if (input.state === 'missingRemote') {
    return new vscode.FileDecoration('↑', `Missing on server — needs upload${tooltipSuffix}`, new vscode.ThemeColor('charts.red'));
  }
  if (input.state === 'missingLocal') {
    return new vscode.FileDecoration('↓', `Missing locally — needs download${tooltipSuffix}`, new vscode.ThemeColor('charts.red'));
  }
  if (input.state === 'localNewer') {
    return new vscode.FileDecoration('↑', `Local newer${tooltipSuffix}`, new vscode.ThemeColor('charts.orange'));
  }
  if (input.state === 'remoteNewer') {
    return new vscode.FileDecoration('↓', `Remote newer${tooltipSuffix}`, new vscode.ThemeColor('charts.orange'));
  }
  if (input.containsChanges) {
    return new vscode.FileDecoration('●', `Contains changes${tooltipSuffix}`, new vscode.ThemeColor('charts.orange'));
  }
  if (input.state === 'synced') {
    return new vscode.FileDecoration('✓', `In sync${tooltipSuffix}`, new vscode.ThemeColor('charts.green'));
  }
  if (input.isWhitelisted) {
    return new vscode.FileDecoration('◈', `On the sync list${tooltipSuffix}`, new vscode.ThemeColor('charts.purple'));
  }
  return undefined;
}
