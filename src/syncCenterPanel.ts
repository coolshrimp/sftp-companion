import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigService } from './configService';
import { Logger } from './logger';
import { relativeTo } from './pathUtils';
import { SftpService } from './sftpService';
import { SyncActions } from './syncActions';
import { SyncDecorationProvider } from './syncDecorations';
import { TransferQueue } from './transferQueue';
import { compareFileState } from './treeProviders';
import { SyncState } from './types';

// Each side gets its own budget so a huge local tree can never starve the
// remote walk (which previously made every file look "missing on server").
const MAX_ENTRIES_PER_SIDE = 20000;
const MAX_SCAN_DEPTH = 16;

interface CompareRow {
  path: string;
  localSize?: number;
  localMtime?: number;
  remoteSize?: number;
  remoteMtime?: number;
  state: SyncState;
  label: string;
}

/**
 * Full-page webview: recursive local↔remote comparison rendered as a
 * collapsible folder tree, plus the live transfer queue with per-file
 * progress and pause/resume/remove controls.
 */
export class SyncCenterPanel {
  private currentPanel?: vscode.WebviewPanel;
  private queueSubscription?: vscode.Disposable;
  private scanning = false;
  // Last scan results, kept so the panel shows them immediately when opened
  // after a background (startup) scan instead of an empty compare table.
  private lastScan?: { rows: CompareRow[]; truncated: boolean; status: string };

  public constructor(
    private readonly config: ConfigService,
    private readonly sftp: SftpService,
    private readonly queue: TransferQueue,
    private readonly logger: Logger,
    private readonly actions: SyncActions,
    private readonly ensureConnected: () => Promise<boolean>,
    private readonly decorations: SyncDecorationProvider
  ) {}

  public reveal(): void {
    if (this.currentPanel) {
      this.currentPanel.reveal(vscode.ViewColumn.Active, true);
      this.postTransfers();
      return;
    }

    this.currentPanel = vscode.window.createWebviewPanel(
      'sftpCompanionSyncCenter',
      'SFTP Sync Center',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.queueSubscription = this.queue.onDidChange(() => this.postTransfers());
    this.currentPanel.onDidDispose(() => {
      this.queueSubscription?.dispose();
      this.queueSubscription = undefined;
      this.currentPanel = undefined;
    });
    this.currentPanel.webview.onDidReceiveMessage(async (message) => {
      try {
        await this.handleMessage(message);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.logger.append('error', `Sync Center: ${text}`);
        vscode.window.showErrorMessage(text);
      }
    });
    this.currentPanel.webview.html = this.getHtml(this.currentPanel.webview);
    this.postTransfers();
    if (this.lastScan) {
      void this.currentPanel.webview.postMessage({ type: 'compare-data', rows: this.lastScan.rows, truncated: this.lastScan.truncated });
      this.postScanStatus(this.lastScan.status, true);
    }
  }

  /**
   * Silent startup scan: compares both sides and populates the Explorer sync
   * badges without opening the panel. Does nothing when no account is
   * configured or the connection is down — plain VS Code stays plain.
   */
  public async runScanInBackground(): Promise<void> {
    if (this.scanning || !this.sftp.connected || !this.config.getCurrentProfile()) {
      return;
    }
    this.logger.append('info', 'Comparing local ↔ server in the background — Explorer sync badges will fill in when it finishes.');
    await this.runScan();
  }

  public postTransfers(): void {
    if (!this.currentPanel) {
      return;
    }
    void this.currentPanel.webview.postMessage({
      type: 'transfers',
      paused: this.queue.paused,
      items: this.queue.items.map((item) => ({
        id: item.id,
        direction: item.direction,
        type: item.type,
        name: path.basename(item.remotePath),
        localPath: item.localPath,
        remotePath: item.remotePath,
        status: item.status,
        message: item.message,
        error: item.error,
        transferred: item.transferred,
        total: item.total,
        completedAt: item.completedAt
      }))
    });
  }

  private async handleMessage(message: { type?: string; [key: string]: unknown }): Promise<void> {
    switch (message?.type) {
      case 'scan':
        await this.runScan();
        break;
      case 'transfer-action': {
        const id = String(message.id ?? '');
        const action = String(message.action ?? '');
        if (action === 'pause') {
          this.queue.pauseItem(id);
        } else if (action === 'resume') {
          this.queue.resumeItem(id);
        } else if (action === 'remove') {
          this.queue.remove(id);
        } else if (action === 'retry') {
          await this.queue.retry(id);
        } else if (action === 'stop') {
          this.queue.stopItem(id);
        }
        break;
      }
      case 'queue-action': {
        const action = String(message.action ?? '');
        if (action === 'pauseAll') {
          this.queue.pauseAll();
        } else if (action === 'resumeAll') {
          this.queue.resumeAll();
        } else if (action === 'clearCompleted') {
          this.queue.clearCompleted();
        }
        break;
      }
      case 'row-action': {
        const relative = String(message.path ?? '');
        const action = String(message.action ?? '');
        const localPath = this.config.resolveLocalPath(relative);
        if (!relative || !localPath) {
          return;
        }
        const remotePath = this.config.resolveRemotePath(relative);
        if (action === 'upload') {
          await this.queue.enqueueUpload(localPath, remotePath, 'file');
        } else if (action === 'download') {
          await this.queue.enqueueDownload(remotePath, localPath, 'file');
        } else if (action === 'diff') {
          await this.actions.compare(vscode.Uri.file(localPath));
        }
        break;
      }
      case 'make-identical': {
        // Dreamweaver-style full synchronize: one side becomes the exact
        // mirror of the other — transfers changed/missing files AND deletes
        // orphans. The scan table is the dry-run; a modal states the counts.
        if (!this.lastScan || this.lastScan.rows.length === 0) {
          vscode.window.showInformationMessage('Run "Scan & Compare All" first — Make Identical works from the scan results.');
          return;
        }
        if (!(await this.ensureConnected())) {
          return;
        }
        const rows = this.lastScan.rows;
        const direction = await vscode.window.showQuickPick([
          { label: '$(cloud-upload) Local → Server', description: 'Upload changed/missing files, DELETE server files that no longer exist locally', dir: 'up' as const },
          { label: '$(cloud-download) Server → Local', description: 'Download changed/missing files, DELETE local files that no longer exist on the server', dir: 'down' as const }
        ], { placeHolder: 'Make both sides identical — which side is the source of truth?' });
        if (!direction) {
          return;
        }
        const up = direction.dir === 'up';
        const transfers = rows.filter((r) => up
          ? (r.state === 'localNewer' || r.state === 'missingRemote')
          : (r.state === 'remoteNewer' || r.state === 'missingLocal'));
        const orphans = rows.filter((r) => (up ? r.state === 'missingLocal' : r.state === 'missingRemote'));
        if (transfers.length === 0 && orphans.length === 0) {
          vscode.window.showInformationMessage('Both sides already match — nothing to do.');
          return;
        }
        const verb = up ? 'upload' : 'download';
        const side = up ? 'server' : 'local';
        const confirmLabel = `Mirror ${up ? 'Local → Server' : 'Server → Local'}`;
        const choice = await vscode.window.showWarningMessage(
          `Make identical: ${up ? 'Local → Server' : 'Server → Local'}?`,
          {
            modal: true,
            detail: `${transfers.length} file(s) will ${verb}.\n${orphans.length} orphan file(s) will be PERMANENTLY DELETED on the ${side} side.\n\nBased on the last scan — re-scan first if things changed since.`
          },
          confirmLabel
        );
        if (choice !== confirmLabel) {
          return;
        }
        for (const row of transfers) {
          const localPath = this.config.resolveLocalPath(row.path);
          if (!localPath) {
            continue;
          }
          const remotePath = this.config.resolveRemotePath(row.path);
          if (up) {
            await this.queue.enqueueUpload(localPath, remotePath, 'file');
          } else {
            await this.queue.enqueueDownload(remotePath, localPath, 'file');
          }
        }
        let deleted = 0;
        for (const row of orphans) {
          try {
            if (up) {
              await this.sftp.deleteRemote(this.config.resolveRemotePath(row.path), false);
            } else {
              const localPath = this.config.resolveLocalPath(row.path);
              if (localPath) {
                await fs.rm(localPath, { force: true });
              }
            }
            deleted += 1;
          } catch (error) {
            this.logger.append('error', `Make Identical: delete failed for ${row.path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        this.logger.append('info', `Make Identical: ${transfers.length} ${verb}(s) queued, ${deleted} orphan(s) deleted on the ${side} side.`);
        this.postScanStatus(`Make Identical: ${transfers.length} ${verb}(s) queued, ${deleted} orphan(s) deleted. Re-scan once transfers finish to verify.`, true);
        break;
      }
      case 'mark-synced': {
        // Dreamweaver-style "mark as synchronized": no content moves. Push the
        // local edit time onto the server file (matching how uploads stamp
        // timestamps); if the server refuses, redate the local file instead.
        const paths = Array.isArray(message.paths) ? message.paths.map(String) : [];
        if (!paths.length || !(await this.ensureConnected())) {
          return;
        }
        const updated: Array<{ path: string; localMtime: number; remoteMtime: number }> = [];
        let processed = 0;
        for (const relative of paths) {
          processed += 1;
          if (processed % 20 === 0) {
            this.postScanStatus(`Marking as synced: ${processed}/${paths.length}…`);
          }
          const localPath = this.config.resolveLocalPath(relative);
          if (!localPath) {
            continue;
          }
          const localStat = await fs.stat(localPath).catch(() => undefined);
          if (!localStat) {
            continue;
          }
          const remotePath = this.config.resolveRemotePath(relative);
          if (await this.sftp.setRemoteModifiedTime(remotePath, localStat.mtime)) {
            updated.push({ path: relative, localMtime: localStat.mtimeMs, remoteMtime: localStat.mtimeMs });
            continue;
          }
          const remoteStat = await this.sftp.stat(remotePath);
          if (!remoteStat?.modifiedAt) {
            continue;
          }
          await fs.utimes(localPath, new Date(), new Date(remoteStat.modifiedAt)).catch(() => undefined);
          updated.push({ path: relative, localMtime: remoteStat.modifiedAt, remoteMtime: remoteStat.modifiedAt });
        }
        for (const entry of updated) {
          const decoratedPath = this.config.resolveLocalPath(entry.path);
          if (decoratedPath) {
            this.decorations.update(decoratedPath, {
              state: 'synced',
              isIgnored: false,
              isWhitelisted: this.config.isWhitelisted(entry.path),
              label: 'In sync'
            });
          }
        }
        this.logger.append('info', `Marked ${updated.length} file(s) as synced (timestamps aligned, no content transferred).`);
        this.postScanStatus(`Marked ${updated.length} file(s) as synced.`, true);
        void this.currentPanel?.webview.postMessage({ type: 'rows-synced', updated });
        break;
      }
      case 'bulk-action': {
        const action = String(message.action ?? '');
        const paths = Array.isArray(message.paths) ? message.paths.map(String) : [];
        // Large bulk transfers are one misclick away from rewriting a whole
        // site — above this size, demand a modal confirmation first.
        if (paths.length >= 25 && (action === 'upload' || action === 'download')) {
          const verb = action === 'upload' ? 'Upload' : 'Download';
          const detail = action === 'upload'
            ? 'These local files will replace their copies on the server.'
            : 'These server files will replace their local copies.';
          const confirmLabel = `${verb} ${paths.length} Files`;
          const choice = await vscode.window.showWarningMessage(
            `${verb} ${paths.length} files?`,
            { modal: true, detail },
            confirmLabel
          );
          if (choice !== confirmLabel) {
            return;
          }
        }
        for (const relative of paths) {
          const localPath = this.config.resolveLocalPath(relative);
          if (!localPath) {
            continue;
          }
          const remotePath = this.config.resolveRemotePath(relative);
          if (action === 'upload') {
            await this.queue.enqueueUpload(localPath, remotePath, 'file');
          } else if (action === 'download') {
            await this.queue.enqueueDownload(remotePath, localPath, 'file');
          }
        }
        break;
      }
    }
  }

  private async runScan(): Promise<void> {
    if (this.scanning) {
      return;
    }
    const root = this.config.getLocalRoot();
    if (!root) {
      this.postScanStatus('Open a workspace and configure an account first.', true);
      return;
    }
    if (!(await this.ensureConnected())) {
      this.postScanStatus('Not connected — check the account settings and try again.', true);
      return;
    }

    this.scanning = true;
    try {
      const rows = new Map<string, CompareRow>();
      const ignore = this.config.getIgnoreMatcher();
      const showHidden = this.config.getShowHidden();
      let localCount = 0;
      let remoteCount = 0;

      const walkLocal = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_SCAN_DEPTH || localCount >= MAX_ENTRIES_PER_SIDE) {
          return;
        }
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (localCount >= MAX_ENTRIES_PER_SIDE) {
            return;
          }
          if (!showHidden && entry.name.startsWith('.')) {
            continue;
          }
          const fullPath = path.join(dir, entry.name);
          const relative = relativeTo(root.fsPath, fullPath);
          if (relative.startsWith('..') || ignore.isIgnored(relative)) {
            continue;
          }
          if (entry.isDirectory()) {
            await walkLocal(fullPath, depth + 1);
          } else {
            const stat = await fs.stat(fullPath).catch(() => undefined);
            if (stat) {
              localCount += 1;
              rows.set(relative, {
                path: relative,
                localSize: stat.size,
                localMtime: stat.mtimeMs,
                state: 'unknown',
                label: ''
              });
            }
          }
        }
      };

      const walkRemote = async (relativeDir: string, depth: number): Promise<void> => {
        if (depth > MAX_SCAN_DEPTH || remoteCount >= MAX_ENTRIES_PER_SIDE) {
          return;
        }
        this.postScanStatus(`Scanning server: /${relativeDir || ''}…`);
        const children = await this.sftp.list(this.config.resolveRemotePath(relativeDir)).catch(() => []);
        for (const child of children) {
          if (remoteCount >= MAX_ENTRIES_PER_SIDE) {
            return;
          }
          const name = path.posix.basename(child.remotePath);
          if (!showHidden && name.startsWith('.')) {
            continue;
          }
          const relative = child.relativePath;
          if (!relative || ignore.isIgnored(relative)) {
            continue;
          }
          if (child.isDirectory) {
            await walkRemote(relative, depth + 1);
          } else {
            remoteCount += 1;
            const existing = rows.get(relative);
            if (existing) {
              existing.remoteSize = child.size;
              existing.remoteMtime = child.modifiedAt;
            } else {
              rows.set(relative, {
                path: relative,
                remoteSize: child.size,
                remoteMtime: child.modifiedAt,
                state: 'unknown',
                label: ''
              });
            }
          }
        }
      };

      this.postScanStatus('Scanning local files…');
      await walkLocal(root.fsPath, 0);
      await walkRemote('', 0);

      for (const row of rows.values()) {
        if (row.localMtime === undefined) {
          row.state = 'missingLocal';
          row.label = 'Missing locally';
        } else if (row.remoteSize === undefined && row.remoteMtime === undefined) {
          row.state = 'missingRemote';
          row.label = 'Missing on server';
        } else {
          const info = compareFileState(row.localMtime, row.localSize ?? 0, row.remoteSize, row.remoteMtime);
          row.state = info.state;
          row.label = info.label;
        }
      }

      // Feed every compared file into the Explorer decoration provider, so
      // badges cover the whole tree — not just folders the Local Sync tree
      // happened to list. Folders roll up to "contains changes" / "in sync".
      const folderUnsynced = new Map<string, boolean>();
      for (const row of rows.values()) {
        const unsynced = row.state !== 'synced';
        let parent = path.posix.dirname(row.path);
        while (parent && parent !== '.' && parent !== '/') {
          folderUnsynced.set(parent, (folderUnsynced.get(parent) ?? false) || unsynced);
          parent = path.posix.dirname(parent);
        }
        if (row.localMtime === undefined) {
          continue; // No local file to decorate.
        }
        const localPath = this.config.resolveLocalPath(row.path);
        if (localPath) {
          this.decorations.update(localPath, {
            state: row.state,
            isIgnored: false,
            isWhitelisted: this.config.isWhitelisted(row.path),
            label: row.label
          });
        }
      }
      for (const [folder, unsynced] of folderUnsynced) {
        const localFolder = this.config.resolveLocalPath(folder);
        if (localFolder) {
          this.decorations.update(localFolder, {
            state: unsynced ? 'unknown' : 'synced',
            isIgnored: false,
            isWhitelisted: this.config.isWhitelisted(folder),
            containsChanges: unsynced,
            label: unsynced ? 'Contains changes' : 'In sync'
          });
        }
      }

      const sorted = [...rows.values()].sort((left, right) => left.path.localeCompare(right.path));
      const truncated = localCount >= MAX_ENTRIES_PER_SIDE || remoteCount >= MAX_ENTRIES_PER_SIDE;
      const status = `Scan finished: ${sorted.length} file(s) compared (${localCount} local, ${remoteCount} on server)`
        + `${truncated ? ' — capped; narrow the sync folder or add ignore patterns' : ''}.`;
      this.lastScan = { rows: sorted, truncated, status };
      void this.currentPanel?.webview.postMessage({ type: 'compare-data', rows: sorted, truncated });
      this.postScanStatus(status, true);
      this.logger.append('info', `Sync Center scan compared ${sorted.length} file(s).`);
    } finally {
      this.scanning = false;
    }
  }

  private postScanStatus(text: string, done = false): void {
    void this.currentPanel?.webview.postMessage({ type: 'scan-status', text, done });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 14px 18px 40px;
      margin: 0;
    }
    h1 { font-size: 1.25em; font-weight: 600; margin: 0 0 12px; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); margin-bottom: 12px; }
    .tab {
      padding: 8px 16px; cursor: pointer; border: none; background: none;
      color: var(--vscode-foreground); opacity: 0.7; font-family: inherit; font-size: inherit;
      border-bottom: 2px solid transparent;
    }
    .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
    button {
      font-family: inherit; font-size: inherit; border: 1px solid transparent; border-radius: 4px;
      padding: 5px 12px; cursor: pointer;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.18));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    button.mini { padding: 2px 8px; font-size: 0.88em; }
    button:disabled { opacity: 0.4; cursor: default; }
    select {
      padding: 4px 8px; border-radius: 4px; font-family: inherit; font-size: inherit;
      background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.35));
    }
    .status-line { opacity: 0.75; margin: 6px 0 10px; min-height: 1.2em; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid rgba(128,128,128,0.12); vertical-align: middle; }
    th { position: sticky; top: 0; background: var(--vscode-editor-background); font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.8; z-index: 1; }
    td.name { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
    td.meta { white-space: nowrap; font-size: 0.9em; opacity: 0.85; }
    tr.folder-row { cursor: pointer; background: rgba(128,128,128,0.05); }
    tr.folder-row:hover { background: rgba(128,128,128,0.12); }
    tr.folder-row td.name { font-weight: 600; font-family: inherit; }
    .twisty { display: inline-block; width: 14px; opacity: 0.8; }
    .foldercounts { opacity: 0.7; font-weight: 400; font-size: 0.9em; margin-left: 8px; }
    .pill { display: inline-block; padding: 1px 9px; border-radius: 10px; font-size: 0.85em; white-space: nowrap; }
    .pill.synced { background: color-mix(in srgb, var(--vscode-charts-green, #2ea043) 20%, transparent); color: var(--vscode-charts-green, #2ea043); }
    .pill.differ { background: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 20%, transparent); color: var(--vscode-charts-orange, #d18616); }
    .pill.missing { background: color-mix(in srgb, var(--vscode-charts-red, #f85149) 20%, transparent); color: var(--vscode-charts-red, #f85149); }
    .pill.unknown { background: rgba(128,128,128,0.2); }
    .pill.held { background: color-mix(in srgb, var(--vscode-charts-yellow, #d29922) 20%, transparent); color: var(--vscode-charts-yellow, #d29922); }
    .row-actions { white-space: nowrap; }
    .transfer {
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 6px;
      padding: 10px 12px; margin-bottom: 8px; background: var(--vscode-editorWidget-background, rgba(128,128,128,0.06));
    }
    .transfer-top { display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; }
    .transfer-name { font-weight: 600; }
    .transfer-sub { opacity: 0.7; font-size: 0.88em; margin-top: 2px; word-break: break-all; }
    .transfer-error { color: var(--vscode-charts-red, #f85149); font-size: 0.88em; margin-top: 4px; }
    .bar { height: 5px; border-radius: 3px; background: rgba(128,128,128,0.25); margin-top: 8px; overflow: hidden; }
    .bar > div { height: 100%; background: var(--vscode-progressBar-background, #0e70c0); transition: width 0.2s; }
    .empty { opacity: 0.6; padding: 24px 0; text-align: center; }
    .counts { opacity: 0.75; margin-left: auto; }
    .selcol { width: 26px; }
    input[type="checkbox"] { accent-color: var(--vscode-focusBorder); cursor: pointer; }
    #ctxMenu {
      position: fixed; z-index: 100; min-width: 230px; display: none;
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background, #252526));
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-menu-border, rgba(128,128,128,0.35));
      border-radius: 6px; padding: 4px; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }
    #ctxMenu .item { padding: 5px 12px; border-radius: 4px; cursor: pointer; white-space: nowrap; }
    #ctxMenu .item:hover { background: var(--vscode-menu-selectionBackground, rgba(128,128,128,0.25)); color: var(--vscode-menu-selectionForeground, inherit); }
    #ctxMenu .item.disabled { opacity: 0.4; cursor: default; }
    #ctxMenu .item.disabled:hover { background: none; color: inherit; }
    #ctxMenu .sep { height: 1px; margin: 4px 6px; background: rgba(128,128,128,0.25); }
  </style>
</head>
<body>
  <h1>SFTP Sync Center</h1>
  <div class="tabs">
    <button class="tab active" id="tabCompare">Compare</button>
    <button class="tab" id="tabTransfers">Transfers <span id="transferCount"></span></button>
  </div>

  <div id="comparePane">
    <div class="toolbar">
      <button id="scan">🔍 Scan &amp; Compare All</button>
      <select id="filter">
        <option value="all">Show: everything</option>
        <option value="attention" selected>Show: needs attention</option>
        <option value="differ">Show: differs</option>
        <option value="missingRemote">Show: missing on server</option>
        <option value="missingLocal">Show: missing locally</option>
        <option value="synced">Show: in sync</option>
      </select>
      <button class="secondary mini" id="expandAll">Expand All</button>
      <button class="secondary mini" id="collapseAll">Collapse All</button>
      <button class="secondary" id="bulkUpload" disabled>⬆ Upload All Shown</button>
      <button class="secondary" id="bulkDownload" disabled>⬇ Download All Shown</button>
      <button class="secondary" id="selUpload" disabled>⬆ Upload Selected</button>
      <button class="secondary" id="selDownload" disabled>⬇ Download Selected</button>
      <button class="secondary" id="selSync" disabled>⇅ Sync Selected</button>
      <button class="secondary" id="selMark" disabled title="Align timestamps only — no files are transferred">✓ Mark Selected Synced</button>
      <button class="secondary" id="makeIdentical" disabled title="One side becomes an exact mirror of the other — includes deleting orphan files (asks first)">≡ Make Identical…</button>
      <span class="counts" id="compareCounts"></span>
    </div>
    <div class="status-line" id="scanStatus">Press "Scan &amp; Compare All" to walk both sides and build the full comparison.</div>
    <table id="compareTable" style="display:none">
      <thead>
        <tr><th class="selcol"><input type="checkbox" id="selectAll" title="Select / deselect all shown" /></th><th>Name</th><th>Local</th><th>Server</th><th>Status</th><th></th></tr>
      </thead>
      <tbody id="compareBody"></tbody>
    </table>
    <div class="empty" id="compareEmpty" style="display:none">Nothing matches this filter.</div>
  </div>

  <div id="transfersPane" style="display:none">
    <div class="toolbar">
      <button id="pauseQueue" class="secondary">⏸ Pause Queue</button>
      <button id="clearCompleted" class="secondary">Clear Completed</button>
      <span class="counts" id="queueCounts"></span>
    </div>
    <div id="transferList"></div>
    <div class="empty" id="transfersEmpty">No transfers yet. Uploads and downloads appear here live.</div>
  </div>

  <div id="ctxMenu"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let rows = [];
    let transfers = [];
    let queuePaused = false;
    let expanded = new Set();
    let selected = new Set();
    let rowMap = new Map();

    const el = (id) => document.getElementById(id);
    const fmtBytes = (n) => n === undefined || n === null ? '—' : n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(1) + ' KB' : (n/1048576).toFixed(2) + ' MB';
    const fmtDate = (ms) => ms ? new Date(ms).toLocaleString() : '';
    const hasLocal = (r) => r.localMtime !== undefined;
    const hasRemote = (r) => r.remoteSize !== undefined || r.remoteMtime !== undefined;

    function stateBucket(state) {
      if (state === 'synced') return 'synced';
      if (state === 'localNewer' || state === 'remoteNewer') return 'differ';
      if (state === 'missingLocal' || state === 'missingRemote') return 'missing';
      return 'unknown';
    }

    function visibleRows() {
      const filter = el('filter').value;
      return rows.filter((row) => {
        if (filter === 'all') return true;
        if (filter === 'attention') return row.state !== 'synced';
        if (filter === 'differ') return row.state === 'localNewer' || row.state === 'remoteNewer';
        if (filter === 'synced') return row.state === 'synced';
        return row.state === filter;
      });
    }

    function buildTree(shown) {
      const root = { name: '', path: '', children: new Map(), files: [] };
      shown.forEach((row) => {
        const parts = row.path.split('/');
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const childPath = node.path ? node.path + '/' + parts[i] : parts[i];
          if (!node.children.has(parts[i])) {
            node.children.set(parts[i], { name: parts[i], path: childPath, children: new Map(), files: [] });
          }
          node = node.children.get(parts[i]);
        }
        node.files.push(row);
      });
      return root;
    }

    function aggregate(node, out) {
      out = out || { synced: 0, differ: 0, missing: 0, unknown: 0, uploadable: [], downloadable: [] };
      node.files.forEach((row) => {
        out[stateBucket(row.state)] += 1;
        if (row.state !== 'synced') {
          if (hasLocal(row)) out.uploadable.push(row.path);
          if (hasRemote(row)) out.downloadable.push(row.path);
        }
      });
      node.children.forEach((child) => aggregate(child, out));
      return out;
    }

    function allFolderPaths(node, list) {
      list = list || [];
      node.children.forEach((child) => { list.push(child.path); allFolderPaths(child, list); });
      return list;
    }

    function filePathsUnder(node, list) {
      list = list || [];
      node.files.forEach((row) => list.push(row.path));
      node.children.forEach((child) => filePathsUnder(child, list));
      return list;
    }

    // Decide a direction per file: the newer / only-existing side wins.
    function smartSplit(paths) {
      const up = [], down = [];
      paths.forEach((p) => {
        const r = rowMap.get(p);
        if (!r || r.state === 'synced') return;
        if ((r.state === 'localNewer' || r.state === 'missingRemote') && hasLocal(r)) up.push(p);
        else if ((r.state === 'remoteNewer' || r.state === 'missingLocal') && hasRemote(r)) down.push(p);
      });
      return { up, down };
    }

    function sendBulk(action, paths) {
      if (paths.length) vscode.postMessage({ type: 'bulk-action', action, paths });
    }

    // Files that exist on both sides but differ only by date — the ones
    // "Mark as Synced" applies to.
    function markablePaths(paths) {
      return paths.filter((p) => {
        const r = rowMap.get(p);
        return r && (r.state === 'localNewer' || r.state === 'remoteNewer');
      });
    }

    function sendMarkSynced(paths) {
      const markable = markablePaths(paths);
      if (markable.length) vscode.postMessage({ type: 'mark-synced', paths: markable });
    }

    function runSmartSync(paths) {
      const split = smartSplit(paths);
      sendBulk('upload', split.up);
      sendBulk('download', split.down);
      if (split.up.length || split.down.length) switchTab('transfers');
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
    }

    function toggleSelection(paths, select) {
      paths.forEach((p) => select ? selected.add(p) : selected.delete(p));
      renderCompare();
    }

    function hideMenu() { el('ctxMenu').style.display = 'none'; }

    function showMenu(ev, items) {
      const menu = el('ctxMenu');
      menu.textContent = '';
      items.forEach((it) => {
        if (it === '-') {
          const sep = document.createElement('div');
          sep.className = 'sep';
          menu.appendChild(sep);
          return;
        }
        const item = document.createElement('div');
        item.className = 'item' + (it.disabled ? ' disabled' : '');
        item.textContent = it.label;
        if (!it.disabled) {
          item.addEventListener('click', () => { hideMenu(); it.run(); });
        }
        menu.appendChild(item);
      });
      menu.style.left = '0px'; menu.style.top = '0px';
      menu.style.display = 'block';
      const rect = menu.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(ev.clientX, window.innerWidth - rect.width - 8)) + 'px';
      menu.style.top = Math.max(4, Math.min(ev.clientY, window.innerHeight - rect.height - 8)) + 'px';
    }

    function openFolderMenu(ev, node) {
      const agg = aggregate(node);
      const all = filePathsUnder(node);
      const split = smartSplit(all);
      const selCount = all.filter((p) => selected.has(p)).length;
      const allSelected = selCount === all.length && all.length > 0;
      showMenu(ev, [
        { label: '⬆ Upload folder → server (' + agg.uploadable.length + ' file' + (agg.uploadable.length === 1 ? '' : 's') + ')', disabled: !agg.uploadable.length, run: () => { sendBulk('upload', agg.uploadable); switchTab('transfers'); } },
        { label: '⬇ Download folder ← server (' + agg.downloadable.length + ' file' + (agg.downloadable.length === 1 ? '' : 's') + ')', disabled: !agg.downloadable.length, run: () => { sendBulk('download', agg.downloadable); switchTab('transfers'); } },
        { label: '⇅ Smart sync folder (⬆ ' + split.up.length + ' / ⬇ ' + split.down.length + ')', disabled: !split.up.length && !split.down.length, run: () => runSmartSync(all) },
        { label: '✓ Mark folder as synced (' + markablePaths(all).length + ' — dates only)', disabled: !markablePaths(all).length, run: () => sendMarkSynced(all) },
        '-',
        { label: allSelected ? '☐ Deselect all in folder' : '☑ Select all in folder (' + all.length + ')', disabled: !all.length, run: () => toggleSelection(all, !allSelected) },
        { label: '📋 Copy path', run: () => copyText(node.path) }
      ]);
    }

    function openFileMenu(ev, row) {
      const split = smartSplit([row.path]);
      const isSelected = selected.has(row.path);
      showMenu(ev, [
        { label: '⬆ Upload to server', disabled: !hasLocal(row), run: () => { vscode.postMessage({ type: 'row-action', action: 'upload', path: row.path }); switchTab('transfers'); } },
        { label: '⬇ Download from server', disabled: !hasRemote(row), run: () => { vscode.postMessage({ type: 'row-action', action: 'download', path: row.path }); switchTab('transfers'); } },
        { label: '⇅ Smart sync (newer side wins)', disabled: !split.up.length && !split.down.length, run: () => runSmartSync([row.path]) },
        { label: '✓ Mark as synced (align dates, no transfer)', disabled: !markablePaths([row.path]).length, run: () => sendMarkSynced([row.path]) },
        { label: '🔀 Diff local ↔ server', disabled: !(hasLocal(row) && hasRemote(row)), run: () => vscode.postMessage({ type: 'row-action', action: 'diff', path: row.path }) },
        '-',
        { label: isSelected ? '☐ Deselect' : '☑ Select', run: () => toggleSelection([row.path], !isSelected) },
        { label: '📋 Copy path', run: () => copyText(row.path) }
      ]);
    }

    function renderCompare() {
      const body = el('compareBody');
      body.textContent = '';
      const shown = visibleRows();
      el('compareTable').style.display = rows.length ? '' : 'none';
      el('compareEmpty').style.display = rows.length && !shown.length ? '' : 'none';
      const counts = { synced: 0, differ: 0, missing: 0, unknown: 0 };
      rows.forEach((row) => { counts[stateBucket(row.state)] += 1; });
      el('compareCounts').textContent = rows.length
        ? counts.synced + ' synced • ' + counts.differ + ' differ • ' + counts.missing + ' missing'
        : '';
      el('bulkUpload').disabled = !shown.some((r) => hasLocal(r) && r.state !== 'synced');
      el('bulkDownload').disabled = !shown.some((r) => hasRemote(r) && r.state !== 'synced');

      // Drop selections that no longer exist after a rescan, then update the
      // selected-actions toolbar and the header select-all checkbox.
      selected = new Set([...selected].filter((p) => rowMap.has(p)));
      const selArr = [...selected];
      const upSel = selArr.filter((p) => hasLocal(rowMap.get(p))).length;
      const downSel = selArr.filter((p) => hasRemote(rowMap.get(p))).length;
      const smartSel = smartSplit(selArr);
      el('selUpload').textContent = '⬆ Upload Selected (' + upSel + ')';
      el('selUpload').disabled = !upSel;
      el('selDownload').textContent = '⬇ Download Selected (' + downSel + ')';
      el('selDownload').disabled = !downSel;
      el('selSync').textContent = '⇅ Sync Selected (⬆ ' + smartSel.up.length + ' / ⬇ ' + smartSel.down.length + ')';
      el('selSync').disabled = !smartSel.up.length && !smartSel.down.length;
      const markSel = markablePaths(selArr);
      el('selMark').textContent = '✓ Mark Selected Synced (' + markSel.length + ')';
      el('selMark').disabled = !markSel.length;
      el('makeIdentical').disabled = !rows.length;
      const selectAll = el('selectAll');
      const shownSelected = shown.filter((r) => selected.has(r.path)).length;
      selectAll.checked = shown.length > 0 && shownSelected === shown.length;
      selectAll.indeterminate = shownSelected > 0 && shownSelected < shown.length;

      const tree = buildTree(shown);
      renderNode(tree, 0, body);
    }

    function renderNode(node, depth, body) {
      const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
      folders.forEach((child) => {
        const isOpen = expanded.has(child.path);
        const agg = aggregate(child);
        const tr = document.createElement('tr');
        tr.className = 'folder-row';

        const selTd = document.createElement('td');
        selTd.className = 'selcol';
        const under = filePathsUnder(child);
        const underSelected = under.filter((p) => selected.has(p)).length;
        const folderCb = document.createElement('input');
        folderCb.type = 'checkbox';
        folderCb.checked = under.length > 0 && underSelected === under.length;
        folderCb.indeterminate = underSelected > 0 && underSelected < under.length;
        folderCb.title = 'Select all files in this folder';
        folderCb.addEventListener('click', (ev) => {
          ev.stopPropagation();
          toggleSelection(under, underSelected !== under.length);
        });
        selTd.appendChild(folderCb);

        const nameTd = document.createElement('td');
        nameTd.className = 'name';
        nameTd.style.paddingLeft = (8 + depth * 18) + 'px';
        const twisty = document.createElement('span');
        twisty.className = 'twisty';
        twisty.textContent = isOpen ? '▾' : '▸';
        nameTd.appendChild(twisty);
        nameTd.appendChild(document.createTextNode('📁 ' + child.name));
        const fc = document.createElement('span');
        fc.className = 'foldercounts';
        const bits = [];
        if (agg.synced) bits.push(agg.synced + ' synced');
        if (agg.differ) bits.push(agg.differ + ' differ');
        if (agg.missing) bits.push(agg.missing + ' missing');
        fc.textContent = bits.join(' • ');
        nameTd.appendChild(fc);

        const localTd = document.createElement('td');
        const remoteTd = document.createElement('td');
        const stateTd = document.createElement('td');
        const pill = document.createElement('span');
        const bucket = agg.differ + agg.missing > 0 ? 'differ' : 'synced';
        pill.className = 'pill ' + bucket;
        pill.textContent = agg.differ + agg.missing > 0 ? 'contains changes' : 'all synced';
        stateTd.appendChild(pill);

        const actionsTd = document.createElement('td');
        actionsTd.className = 'row-actions';
        const mkBtn = (text, action, paths) => {
          const b = document.createElement('button');
          b.className = 'mini secondary';
          b.textContent = text;
          b.disabled = paths.length === 0;
          b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            vscode.postMessage({ type: 'bulk-action', action, paths });
          });
          actionsTd.appendChild(b);
          actionsTd.appendChild(document.createTextNode(' '));
        };
        mkBtn('⬆ ' + agg.uploadable.length, 'upload', agg.uploadable);
        mkBtn('⬇ ' + agg.downloadable.length, 'download', agg.downloadable);

        tr.addEventListener('click', () => {
          if (expanded.has(child.path)) expanded.delete(child.path); else expanded.add(child.path);
          renderCompare();
        });
        tr.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openFolderMenu(ev, child);
        });
        tr.append(selTd, nameTd, localTd, remoteTd, stateTd, actionsTd);
        body.appendChild(tr);

        if (isOpen) {
          renderNode(child, depth + 1, body);
        }
      });

      node.files.sort((a, b) => a.path.localeCompare(b.path)).forEach((row) => {
        const tr = document.createElement('tr');
        const selTd = document.createElement('td');
        selTd.className = 'selcol';
        const fileCb = document.createElement('input');
        fileCb.type = 'checkbox';
        fileCb.checked = selected.has(row.path);
        fileCb.addEventListener('click', (ev) => {
          ev.stopPropagation();
          toggleSelection([row.path], !selected.has(row.path));
        });
        selTd.appendChild(fileCb);
        const nameTd = document.createElement('td');
        nameTd.className = 'name';
        nameTd.style.paddingLeft = (8 + depth * 18 + 14) + 'px';
        nameTd.textContent = row.path.split('/').pop();
        nameTd.title = row.path;
        const localTd = document.createElement('td');
        localTd.className = 'meta';
        localTd.textContent = hasLocal(row) ? fmtBytes(row.localSize) + ' · ' + fmtDate(row.localMtime) : '—';
        const remoteTd = document.createElement('td');
        remoteTd.className = 'meta';
        remoteTd.textContent = hasRemote(row) ? fmtBytes(row.remoteSize) + (row.remoteMtime ? ' · ' + fmtDate(row.remoteMtime) : '') : '—';
        const stateTd = document.createElement('td');
        const pill = document.createElement('span');
        pill.className = 'pill ' + stateBucket(row.state);
        pill.textContent = row.label || row.state;
        stateTd.appendChild(pill);
        const actionsTd = document.createElement('td');
        actionsTd.className = 'row-actions';
        const mkBtn = (text, action, enabled) => {
          const b = document.createElement('button');
          b.className = 'mini secondary';
          b.textContent = text;
          b.disabled = !enabled;
          b.addEventListener('click', () => vscode.postMessage({ type: 'row-action', action, path: row.path }));
          actionsTd.appendChild(b);
          actionsTd.appendChild(document.createTextNode(' '));
        };
        mkBtn('⬆', 'upload', hasLocal(row));
        mkBtn('⬇', 'download', hasRemote(row));
        mkBtn('Diff', 'diff', hasLocal(row) && hasRemote(row));
        tr.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openFileMenu(ev, row);
        });
        tr.append(selTd, nameTd, localTd, remoteTd, stateTd, actionsTd);
        body.appendChild(tr);
      });
    }

    function renderTransfers() {
      const list = el('transferList');
      list.textContent = '';
      el('transfersEmpty').style.display = transfers.length ? 'none' : '';
      const active = transfers.filter((t) => t.status === 'running' || t.status === 'queued').length;
      el('transferCount').textContent = active ? '(' + active + ')' : '';
      el('queueCounts').textContent = transfers.length
        ? transfers.filter((t) => t.status === 'completed').length + ' done • ' + active + ' active • ' + transfers.filter((t) => t.status === 'failed').length + ' failed'
        : '';
      el('pauseQueue').textContent = queuePaused ? '▶ Resume Queue' : '⏸ Pause Queue';

      transfers.forEach((t) => {
        const card = document.createElement('div');
        card.className = 'transfer';
        const top = document.createElement('div');
        top.className = 'transfer-top';
        const left = document.createElement('div');
        const name = document.createElement('span');
        name.className = 'transfer-name';
        name.textContent = (t.direction === 'upload' ? '⬆ ' : '⬇ ') + t.name;
        const pill = document.createElement('span');
        pill.className = 'pill ' + (t.status === 'completed' ? 'synced' : t.status === 'failed' ? 'missing' : t.status === 'held' ? 'held' : t.status === 'running' ? 'differ' : 'unknown');
        pill.style.marginLeft = '8px';
        pill.textContent = t.status;
        left.append(name, pill);
        const buttons = document.createElement('div');
        const mkBtn = (text, action) => {
          const b = document.createElement('button');
          b.className = 'mini secondary';
          b.textContent = text;
          b.addEventListener('click', () => vscode.postMessage({ type: 'transfer-action', action, id: t.id }));
          buttons.appendChild(b);
          buttons.appendChild(document.createTextNode(' '));
        };
        if (t.status === 'queued') mkBtn('⏸ Pause', 'pause');
        if (t.status === 'held') mkBtn('▶ Resume', 'resume');
        if (t.status === 'failed') mkBtn('↻ Retry', 'retry');
        if (t.status === 'running') mkBtn('⏹ Stop', 'stop');
        if (t.status !== 'running') mkBtn('✕ Remove', 'remove');
        top.append(left, buttons);
        card.appendChild(top);
        const sub = document.createElement('div');
        sub.className = 'transfer-sub';
        sub.textContent = t.remotePath + ' • ' + t.message;
        card.appendChild(sub);
        if (t.error) {
          const err = document.createElement('div');
          err.className = 'transfer-error';
          err.textContent = t.error;
          card.appendChild(err);
        }
        if (t.status === 'running' || (t.transferred !== undefined && t.status !== 'completed')) {
          const bar = document.createElement('div');
          bar.className = 'bar';
          const fill = document.createElement('div');
          const pct = t.total ? Math.min(100, Math.round((t.transferred || 0) / t.total * 100)) : (t.status === 'running' ? 30 : 0);
          fill.style.width = pct + '%';
          bar.appendChild(fill);
          card.appendChild(bar);
        }
        list.appendChild(card);
      });
    }

    function switchTab(tab) {
      const compare = tab === 'compare';
      el('tabCompare').classList.toggle('active', compare);
      el('tabTransfers').classList.toggle('active', !compare);
      el('comparePane').style.display = compare ? '' : 'none';
      el('transfersPane').style.display = compare ? 'none' : '';
    }

    el('tabCompare').addEventListener('click', () => switchTab('compare'));
    el('tabTransfers').addEventListener('click', () => switchTab('transfers'));
    el('scan').addEventListener('click', () => {
      el('scan').disabled = true;
      vscode.postMessage({ type: 'scan' });
    });
    el('filter').addEventListener('change', renderCompare);
    el('expandAll').addEventListener('click', () => {
      expanded = new Set(allFolderPaths(buildTree(visibleRows())));
      renderCompare();
    });
    el('collapseAll').addEventListener('click', () => { expanded = new Set(); renderCompare(); });
    el('bulkUpload').addEventListener('click', () => {
      const paths = visibleRows().filter((r) => hasLocal(r) && r.state !== 'synced').map((r) => r.path);
      vscode.postMessage({ type: 'bulk-action', action: 'upload', paths });
      switchTab('transfers');
    });
    el('bulkDownload').addEventListener('click', () => {
      const paths = visibleRows().filter((r) => hasRemote(r) && r.state !== 'synced').map((r) => r.path);
      vscode.postMessage({ type: 'bulk-action', action: 'download', paths });
      switchTab('transfers');
    });
    el('pauseQueue').addEventListener('click', () => vscode.postMessage({ type: 'queue-action', action: queuePaused ? 'resumeAll' : 'pauseAll' }));
    el('clearCompleted').addEventListener('click', () => vscode.postMessage({ type: 'queue-action', action: 'clearCompleted' }));
    el('selectAll').addEventListener('change', () => {
      toggleSelection(visibleRows().map((r) => r.path), el('selectAll').checked);
    });
    el('selUpload').addEventListener('click', () => {
      sendBulk('upload', [...selected].filter((p) => rowMap.has(p) && hasLocal(rowMap.get(p))));
      switchTab('transfers');
    });
    el('selDownload').addEventListener('click', () => {
      sendBulk('download', [...selected].filter((p) => rowMap.has(p) && hasRemote(rowMap.get(p))));
      switchTab('transfers');
    });
    el('selSync').addEventListener('click', () => runSmartSync([...selected]));
    el('selMark').addEventListener('click', () => sendMarkSynced([...selected]));
    el('makeIdentical').addEventListener('click', () => vscode.postMessage({ type: 'make-identical' }));

    // Replace the useless default cut/copy/paste menu everywhere in the panel;
    // rows open their own menu via their contextmenu handlers above.
    document.addEventListener('contextmenu', (ev) => { ev.preventDefault(); hideMenu(); });
    document.addEventListener('click', hideMenu);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideMenu(); });
    document.addEventListener('scroll', hideMenu, true);
    window.addEventListener('blur', hideMenu);

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message) return;
      if (message.type === 'transfers') {
        transfers = message.items || [];
        queuePaused = message.paused === true;
        renderTransfers();
      } else if (message.type === 'compare-data') {
        rows = message.rows || [];
        rowMap = new Map(rows.map((r) => [r.path, r]));
        expanded = new Set();
        selected = new Set();
        renderCompare();
      } else if (message.type === 'rows-synced') {
        (message.updated || []).forEach((u) => {
          const r = rowMap.get(u.path);
          if (r) {
            r.localMtime = u.localMtime;
            r.remoteMtime = u.remoteMtime;
            r.state = 'synced';
            r.label = 'In sync';
          }
        });
        renderCompare();
      } else if (message.type === 'scan-status') {
        el('scanStatus').textContent = message.text || '';
        if (message.done) el('scan').disabled = false;
      }
    });
  </script>
</body>
</html>`;
  }
}
