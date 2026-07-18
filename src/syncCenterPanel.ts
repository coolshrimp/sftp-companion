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
import { QueueItem, SyncState } from './types';

type StableRemoteOperation = <T>(expectedContextKey: string, operation: () => Promise<T>) => Promise<T>;

// Each side gets its own budget so a huge local tree can never starve the
// remote walk (which previously made every file look "missing on server").
const MAX_ENTRIES_PER_SIDE = 20000;
const MAX_SCAN_DEPTH = 16;

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  return Boolean(normalized)
    && !path.posix.isAbsolute(normalized)
    && !path.win32.isAbsolute(value)
    && !normalized.split('/').includes('..');
}

interface CompareRow {
  path: string;
  localExists: boolean;
  remoteExists: boolean;
  localSize?: number;
  localMtime?: number;
  remoteSize?: number;
  remoteMtime?: number;
  state: SyncState;
  label: string;
}

interface ScanSnapshot {
  rows: CompareRow[];
  localDirectories: string[];
  remoteDirectories: string[];
  truncated: boolean;
  complete: boolean;
  status: string;
  contextKey: string;
  queueRevision: number;
  stale: boolean;
}

/**
 * Full-page webview: recursive local↔remote comparison rendered as one
 * aligned pair of file trees, plus a compact, paged transfer queue with
 * per-file progress and pause/resume/remove controls.
 */
export class SyncCenterPanel {
  private currentPanel?: vscode.WebviewPanel;
  private queueSubscription?: vscode.Disposable;
  private transferPostTimer?: ReturnType<typeof setTimeout>;
  private transfersTabActive = false;
  private transferSnapshotReady = false;
  private readonly transferSnapshot = new Map<string, string>();
  private scanning = false;
  // Last scan results, kept so the panel shows them immediately when opened
  // after a background (startup) scan instead of empty compare trees.
  private lastScan?: ScanSnapshot;

  public constructor(
    private readonly config: ConfigService,
    private readonly sftp: SftpService,
    private readonly queue: TransferQueue,
    private readonly logger: Logger,
    private readonly actions: SyncActions,
    private readonly ensureConnected: () => Promise<boolean>,
    private readonly runRemoteOperation: StableRemoteOperation,
    private readonly decorations: SyncDecorationProvider,
    private readonly suppressLocalAutoSync: (localPath: string) => void = () => undefined
  ) {}

  public reveal(): void {
    if (this.currentPanel) {
      this.currentPanel.reveal(vscode.ViewColumn.Active, true);
      if (this.transfersTabActive) {
        this.postTransfers();
      } else {
        this.postTransferSummary();
      }
      return;
    }

    this.currentPanel = vscode.window.createWebviewPanel(
      'sftpCompanionSyncCenter',
      'SFTP Sync Center',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.queueSubscription = this.queue.onDidChange(() => {
      this.invalidateScanForQueueChange();
      this.scheduleTransferPost();
    });
    this.currentPanel.onDidDispose(() => {
      this.queueSubscription?.dispose();
      this.queueSubscription = undefined;
      if (this.transferPostTimer) {
        clearTimeout(this.transferPostTimer);
        this.transferPostTimer = undefined;
      }
      this.transfersTabActive = false;
      this.transferSnapshotReady = false;
      this.transferSnapshot.clear();
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

  private scanContextKey(): string | undefined {
    const loaded = this.config.getCurrentProfile();
    const operationContextKey = this.config.getOperationContextKey();
    if (!loaded || !operationContextKey) {
      return undefined;
    }
    const profile = loaded.profile;
    return JSON.stringify([
      operationContextKey,
      profile.showHiddenFiles === true,
      [...profile.ignore].sort()
    ]);
  }

  private currentScan(): ScanSnapshot | undefined {
    const contextKey = this.scanContextKey();
    return contextKey
      && this.lastScan?.contextKey === contextKey
      && this.lastScan.queueRevision === this.queue.revision
      && !this.lastScan.stale
      ? this.lastScan
      : undefined;
  }

  private invalidateScanForQueueChange(): void {
    if (!this.lastScan || this.lastScan.stale || this.lastScan.queueRevision === this.queue.revision) {
      return;
    }
    this.lastScan.stale = true;
    this.lastScan.complete = false;
    this.lastScan.status = 'Transfers changed files after this comparison. Scan again before taking more compare actions.';
    void this.currentPanel?.webview.postMessage({ type: 'scan-invalidated' });
    this.postScanStatus(this.lastScan.status, true);
  }

  public postTransfers(): void {
    if (!this.currentPanel) {
      return;
    }
    if (!this.transferSnapshotReady) {
      this.transferSnapshot.clear();
      for (const item of this.queue.items) {
        this.transferSnapshot.set(item.id, this.transferFingerprint(item));
      }
      this.transferSnapshotReady = true;
      void this.currentPanel.webview.postMessage({
        type: 'transfers',
        paused: this.queue.paused,
        items: this.queue.items.map((item) => this.transferPayload(item))
      }).then((delivered) => {
        if (!delivered) {
          this.transferSnapshotReady = false;
          this.transferSnapshot.clear();
        }
      });
      return;
    }

    const liveIds = new Set<string>();
    const changed: ReturnType<SyncCenterPanel['transferPayload']>[] = [];
    for (const item of this.queue.items) {
      liveIds.add(item.id);
      const fingerprint = this.transferFingerprint(item);
      if (this.transferSnapshot.get(item.id) !== fingerprint) {
        this.transferSnapshot.set(item.id, fingerprint);
        changed.push(this.transferPayload(item));
      }
    }
    const removed: string[] = [];
    for (const id of this.transferSnapshot.keys()) {
      if (!liveIds.has(id)) {
        this.transferSnapshot.delete(id);
        removed.push(id);
      }
    }
    void this.currentPanel.webview.postMessage({
      type: 'transfer-patch',
      paused: this.queue.paused,
      items: changed,
      removed
    }).then((delivered) => {
      if (!delivered) {
        this.transferSnapshotReady = false;
        this.transferSnapshot.clear();
      }
    });
  }

  private transferPayload(item: QueueItem) {
    return {
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
      createdAt: item.createdAt,
      completedAt: item.completedAt
    };
  }

  private transferFingerprint(item: QueueItem): string {
    return JSON.stringify([
      item.status,
      item.message,
      item.error ?? '',
      item.transferred ?? '',
      item.total ?? '',
      item.completedAt ?? ''
    ]);
  }

  private postTransferSummary(): void {
    if (!this.currentPanel) {
      return;
    }
    const counts = { running: 0, queued: 0, held: 0, completed: 0, failed: 0 };
    for (const item of this.queue.items) {
      counts[item.status] += 1;
    }
    void this.currentPanel.webview.postMessage({
      type: 'transfer-summary',
      paused: this.queue.paused,
      total: this.queue.items.length,
      counts
    });
  }

  /** Coalesce progress events so a large queue is not serialized repeatedly. */
  private scheduleTransferPost(): void {
    if (this.transferPostTimer || !this.currentPanel) {
      return;
    }
    this.transferPostTimer = setTimeout(() => {
      this.transferPostTimer = undefined;
      if (this.transfersTabActive) {
        this.postTransfers();
      } else {
        this.postTransferSummary();
      }
    }, 120);
  }

  private async handleMessage(message: { type?: string; [key: string]: unknown }): Promise<void> {
    switch (message?.type) {
      case 'webview-ready':
        this.transfersTabActive = false;
        this.transferSnapshotReady = false;
        this.transferSnapshot.clear();
        this.postTransferSummary();
        {
          const scan = this.currentScan();
          if (!scan) {
            break;
          }
          void this.currentPanel?.webview.postMessage({
            type: 'compare-data',
            rows: scan.rows,
            truncated: scan.truncated,
            complete: scan.complete
          });
          this.postScanStatus(scan.status, true);
        }
        break;
      case 'view-tab':
        this.transfersTabActive = message.tab === 'transfers';
        if (this.transfersTabActive) {
          this.postTransfers();
        } else {
          this.transferSnapshotReady = false;
          this.transferSnapshot.clear();
          this.postTransferSummary();
        }
        break;
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
        const scan = this.currentScan();
        const operationContextKey = this.config.getOperationContextKey();
        const row = scan?.rows.find((candidate) => candidate.path === relative);
        if (!row
          || !operationContextKey
          || (action === 'upload' && !row.localExists)
          || (action === 'download' && !row.remoteExists)
          || (action === 'diff' && (!row.localExists || !row.remoteExists))) {
          return;
        }
        const localPath = await this.config.resolveSafeLocalPath(relative);
        if (!relative || !localPath) {
          vscode.window.showWarningMessage('The selected local path is outside the canonical sync root or passes through an unsafe link.');
          return;
        }
        if (this.currentScan() !== scan || this.config.getOperationContextKey() !== operationContextKey) {
          vscode.window.showWarningMessage('The account, sync root, or comparison changed. Scan again before taking this action.');
          return;
        }
        const remotePath = this.config.resolveRemotePath(relative);
        if (action === 'upload') {
          await this.queue.enqueueUpload(localPath, remotePath, 'file', operationContextKey);
        } else if (action === 'download') {
          await this.queue.enqueueDownload(remotePath, localPath, 'file', operationContextKey);
        } else if (action === 'diff') {
          await this.actions.compare(vscode.Uri.file(localPath));
        }
        break;
      }
      case 'ignore-paths': {
        const requested = Array.isArray(message.paths)
          ? [...new Set(message.paths.map(String).filter(Boolean))]
          : [];
        const scan = this.currentScan();
        const scannedRows = scan?.rows ?? [];
        const valid = requested.filter((candidate) => scannedRows.some((row) =>
          row.path === candidate || row.path.startsWith(`${candidate}/`)
        ));
        const added = await this.config.addIgnoreEntries(valid);
        if (!added.length) {
          return;
        }

        const isIgnored = (candidate: string): boolean => added.some((ignored) =>
          candidate === ignored || candidate.startsWith(`${ignored}/`)
        );
        const affected = scannedRows.filter((row) => isIgnored(row.path));
        if (scan) {
          scan.rows = scan.rows.filter((row) => !isIgnored(row.path));
          scan.status = `Ignored ${added.length} path${added.length === 1 ? '' : 's'} (${affected.length} compared file${affected.length === 1 ? '' : 's'} hidden).`;
          scan.contextKey = this.scanContextKey() ?? scan.contextKey;
        }
        for (const row of affected) {
          const localPath = this.config.resolveLocalPath(row.path);
          if (localPath && row.localMtime !== undefined) {
            this.decorations.update(localPath, {
              state: row.state,
              isIgnored: true,
              isWhitelisted: this.config.isWhitelisted(row.path),
              label: 'Ignored'
            });
          }
        }
        for (const ignored of added) {
          const localPath = this.config.resolveLocalPath(ignored);
          if (localPath) {
            this.decorations.update(localPath, {
              state: 'unknown',
              isIgnored: true,
              isWhitelisted: this.config.isWhitelisted(ignored),
              label: 'Ignored'
            });
          }
        }
        void vscode.commands.executeCommand('sftpCompanion.refreshLocal');
        void vscode.commands.executeCommand('sftpCompanion.refreshRemote');
        void this.currentPanel?.webview.postMessage({ type: 'rows-ignored', paths: added });
        this.postScanStatus(scan?.status ?? 'Ignored selected paths.', true);
        this.logger.append('info', `Sync Center ignored ${added.join(', ')}.`);
        break;
      }
      case 'make-identical': {
        // Dreamweaver-style file synchronization: one side's file set becomes
        // the mirror of the other — changed/missing files transfer and orphan
        // files are deleted. Empty directories are intentionally not mirrored.
        const scan = this.currentScan();
        if (this.scanning) {
          vscode.window.showInformationMessage('Wait for the current comparison scan to finish before using Make Identical.');
          return;
        }
        if (!scan || scan.rows.length === 0) {
          vscode.window.showInformationMessage('Run "Scan & Compare All" first — Make Identical works from the scan results.');
          return;
        }
        if (!scan.complete) {
          vscode.window.showWarningMessage('Make Identical is disabled because the last scan was incomplete or capped. Narrow the sync root, fix scan errors, and scan again.');
          return;
        }
        if (!(await this.ensureConnected())) {
          return;
        }
        const rows = scan.rows;
        const direction = await vscode.window.showQuickPick([
          { label: '$(cloud-upload) Local → Server', description: 'Upload changed/missing files, DELETE server files that no longer exist locally', dir: 'up' as const },
          { label: '$(cloud-download) Server → Local', description: 'Download changed/missing files, DELETE local files that no longer exist on the server', dir: 'down' as const }
        ], { placeHolder: 'Make both sides identical — which side is the source of truth?' });
        if (!direction) {
          return;
        }
        if (this.scanning || this.currentScan() !== scan || !scan.complete) {
          vscode.window.showWarningMessage('The comparison changed while Make Identical was open. Scan again before mirroring.');
          return;
        }
        const up = direction.dir === 'up';
        const transfers = rows.filter((row) => row.state !== 'synced' && (up ? row.localExists : row.remoteExists));
        const destinationDirectories = new Set(up ? scan.remoteDirectories : scan.localDirectories);
        const blockingDirectories = [...new Set(transfers
          .map((row) => row.path)
          .filter((relative) => destinationDirectories.has(relative)))]
          .sort((left, right) => right.split('/').length - left.split('/').length);
        const isInsideBlockingDirectory = (relative: string): boolean => blockingDirectories.some((directory) =>
          relative === directory || relative.startsWith(`${directory}/`)
        );
        const orphans = rows.filter((row) => (up ? row.state === 'missingLocal' : row.state === 'missingRemote')
          && !isInsideBlockingDirectory(row.path));
        if (transfers.length === 0 && orphans.length === 0 && blockingDirectories.length === 0) {
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
            detail: `${transfers.length} file(s) will ${verb}.\n${orphans.length} orphan file(s) will be PERMANENTLY DELETED on the ${side} side.\n${blockingDirectories.length} conflicting director${blockingDirectories.length === 1 ? 'y' : 'ies'} will be replaced by source files.\n\nEmpty directories are not mirrored. Based on the last scan — re-scan first if things changed since.`
          },
          confirmLabel
        );
        if (choice !== confirmLabel) {
          return;
        }
        if (this.scanning || this.currentScan() !== scan || !scan.complete) {
          vscode.window.showWarningMessage('The comparison changed while Make Identical was open. Scan again before mirroring.');
          return;
        }
        const operationContextKey = this.config.getOperationContextKey();
        if (!operationContextKey) {
          vscode.window.showWarningMessage('The SFTP account or sync root is no longer available. Scan again.');
          return;
        }
        scan.complete = false;
        scan.stale = true;
        scan.status = 'Make Identical is in progress. Scan again after the queue settles to verify both sides.';
        void this.currentPanel?.webview.postMessage({ type: 'scan-invalidated' });
        let deletedDirectories = 0;
        const failedBlockingDirectories = new Set<string>();
        for (const relative of blockingDirectories) {
          if (this.config.getOperationContextKey() !== operationContextKey) {
            this.logger.append('warn', 'Make Identical stopped because the account or sync root changed.');
            break;
          }
          try {
            if (up) {
              if (this.config.getOperationContextKey() !== operationContextKey) {
                throw new Error('account or sync root changed');
              }
              const remotePath = this.config.resolveRemotePath(relative);
              await this.runRemoteOperation(operationContextKey, () => this.sftp.deleteRemote(remotePath, true));
            } else {
              if (this.config.getOperationContextKey() !== operationContextKey) {
                throw new Error('account or sync root changed');
              }
              const localPath = await this.config.resolveSafeLocalPath(relative);
              if (!localPath || this.config.getOperationContextKey() !== operationContextKey) {
                throw new Error('local path leaves the canonical sync root');
              }
              await fs.rm(localPath, { recursive: true, force: true });
            }
            deletedDirectories += 1;
          } catch (error) {
            failedBlockingDirectories.add(relative);
            this.logger.append('error', `Make Identical: conflicting directory delete failed for ${relative}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        let deleted = 0;
        for (const row of orphans) {
          if (this.config.getOperationContextKey() !== operationContextKey) {
            this.logger.append('warn', 'Make Identical stopped because the account or sync root changed.');
            break;
          }
          try {
            if (up) {
              if (this.config.getOperationContextKey() !== operationContextKey) {
                throw new Error('account or sync root changed');
              }
              const remotePath = this.config.resolveRemotePath(row.path);
              await this.runRemoteOperation(operationContextKey, () => this.sftp.deleteRemote(remotePath, false));
            } else {
              if (this.config.getOperationContextKey() !== operationContextKey) {
                throw new Error('account or sync root changed');
              }
              const localPath = await this.config.resolveSafeLocalPath(row.path);
              if (!localPath || this.config.getOperationContextKey() !== operationContextKey) {
                throw new Error('local path leaves the canonical sync root');
              }
              await fs.rm(localPath, { force: true });
            }
            deleted += 1;
          } catch (error) {
            this.logger.append('error', `Make Identical: delete failed for ${row.path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        let queued = 0;
        for (const row of transfers) {
          if (this.config.getOperationContextKey() !== operationContextKey) {
            this.logger.append('warn', 'Make Identical stopped because the account or sync root changed.');
            break;
          }
          if (failedBlockingDirectories.has(row.path)) {
            continue;
          }
          const localPath = await this.config.resolveSafeLocalPath(row.path);
          if (!localPath) {
            this.logger.append('error', `Make Identical skipped unsafe local path ${row.path}.`);
            continue;
          }
          const remotePath = this.config.resolveRemotePath(row.path);
          if (up) {
            await this.queue.enqueueUpload(localPath, remotePath, 'file', operationContextKey);
          } else {
            await this.queue.enqueueDownload(remotePath, localPath, 'file', operationContextKey);
          }
          queued += 1;
        }
        this.logger.append('info', `Make Identical: ${queued} ${verb}(s) queued, ${deleted} orphan file(s) and ${deletedDirectories} conflicting director${deletedDirectories === 1 ? 'y' : 'ies'} deleted on the ${side} side.`);
        this.postScanStatus(`Make Identical: ${queued} ${verb}(s) queued, ${deleted} orphan file(s) and ${deletedDirectories} conflicting director${deletedDirectories === 1 ? 'y' : 'ies'} deleted. Re-scan once transfers finish to verify.`, true);
        break;
      }
      case 'mark-synced': {
        // Dreamweaver-style "mark as synchronized": no content moves. Re-stat
        // both sides, require the equal-size scan pair to still be unchanged,
        // then align the older timestamp to the newer side.
        const requested = Array.isArray(message.paths) ? message.paths.map(String) : [];
        const scan = this.currentScan();
        const markable = new Set((scan?.rows ?? [])
          .filter((row) => row.localExists && row.remoteExists
            && row.localSize !== undefined && row.remoteSize !== undefined
            && row.localSize === row.remoteSize
            && (row.state === 'localNewer' || row.state === 'remoteNewer'))
          .map((row) => row.path));
        const paths = [...new Set(requested.filter((relative) => markable.has(relative)))];
        const operationContextKey = this.config.getOperationContextKey();
        if (!paths.length || !operationContextKey || !(await this.ensureConnected())) {
          return;
        }
        if (this.scanning || this.currentScan() !== scan
          || this.config.getOperationContextKey() !== operationContextKey) {
          vscode.window.showWarningMessage('The comparison changed before timestamps could be aligned. Scan again and retry.');
          return;
        }
        const updated: Array<{ path: string; localMtime: number; remoteMtime: number }> = [];
        let processed = 0;
        for (const relative of paths) {
          if (this.config.getOperationContextKey() !== operationContextKey) {
            this.logger.append('warn', 'Mark in sync stopped because the account or sync root changed.');
            break;
          }
          processed += 1;
          if (processed % 20 === 0) {
            this.postScanStatus(`Marking as synced: ${processed}/${paths.length}…`);
          }
          const localPath = await this.config.resolveSafeLocalPath(relative);
          if (!localPath) {
            continue;
          }
          const cached = scan?.rows.find((row) => row.path === relative);
          const localStat = await fs.stat(localPath).catch(() => undefined);
          if (!cached || !localStat?.isFile()) {
            continue;
          }
          const remotePath = this.config.resolveRemotePath(relative);
          const remoteStat = await this.runRemoteOperation(operationContextKey, () => this.sftp.stat(remotePath));
          if (!remoteStat || remoteStat.isDirectory
            || remoteStat.size === undefined
            || localStat.size !== remoteStat.size
            || localStat.size !== cached.localSize
            || remoteStat.size !== cached.remoteSize
            || cached.localMtime === undefined
            || Math.abs(localStat.mtimeMs - cached.localMtime) >= 2000
            || (cached.remoteMtime !== undefined
              && (remoteStat.modifiedAt === undefined || Math.abs(remoteStat.modifiedAt - cached.remoteMtime) >= 2000))) {
            continue;
          }

          if (cached.state === 'remoteNewer') {
            if (remoteStat.modifiedAt === undefined
              || this.config.getOperationContextKey() !== operationContextKey) {
              continue;
            }
            this.suppressLocalAutoSync(localPath);
            const redated = await fs.utimes(localPath, new Date(), new Date(remoteStat.modifiedAt))
              .then(() => true)
              .catch(() => false);
            if (redated) {
              updated.push({ path: relative, localMtime: remoteStat.modifiedAt, remoteMtime: remoteStat.modifiedAt });
            }
            continue;
          }

          if (await this.runRemoteOperation(
            operationContextKey,
            () => this.sftp.setRemoteModifiedTime(remotePath, localStat.mtime)
          )) {
            updated.push({ path: relative, localMtime: localStat.mtimeMs, remoteMtime: localStat.mtimeMs });
            continue;
          }
          if (remoteStat.modifiedAt === undefined
            || this.config.getOperationContextKey() !== operationContextKey) {
            continue;
          }
          this.suppressLocalAutoSync(localPath);
          const redated = await fs.utimes(localPath, new Date(), new Date(remoteStat.modifiedAt))
            .then(() => true)
            .catch(() => false);
          if (!redated) {
            continue;
          }
          updated.push({ path: relative, localMtime: remoteStat.modifiedAt, remoteMtime: remoteStat.modifiedAt });
        }
        for (const entry of updated) {
          const cached = scan?.rows.find((row) => row.path === entry.path);
          if (cached) {
            cached.localMtime = entry.localMtime;
            cached.remoteMtime = entry.remoteMtime;
            cached.state = 'synced';
            cached.label = 'In sync';
          }
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
      case 'smart-bulk': {
        const scan = this.currentScan();
        const operationContextKey = this.config.getOperationContextKey();
        const rowsByPath = new Map((scan?.rows ?? []).map((row) => [row.path, row]));
        const requested = [...new Set(Array.isArray(message.paths) ? message.paths.map(String) : [])];
        const uploads: CompareRow[] = [];
        const downloads: CompareRow[] = [];
        for (const relative of requested) {
          const row = rowsByPath.get(relative);
          if (!row || row.state === 'synced' || row.state === 'unknown') {
            continue;
          }
          if ((row.state === 'localNewer' || row.state === 'missingRemote') && row.localExists) {
            uploads.push(row);
          } else if ((row.state === 'remoteNewer' || row.state === 'missingLocal') && row.remoteExists) {
            downloads.push(row);
          }
        }
        const total = uploads.length + downloads.length;
        if (!scan || !operationContextKey || !total) {
          return;
        }
        if (total >= 25) {
          const confirmLabel = `Sync ${total} Files`;
          const choice = await vscode.window.showWarningMessage(
            `Use the newer side for ${total} files?`,
            {
              modal: true,
              detail: `${uploads.length} file(s) will upload to the server.\n${downloads.length} file(s) will download to the workspace.`
            },
            confirmLabel
          );
          if (choice !== confirmLabel) {
            return;
          }
        }
        if (this.scanning || this.currentScan() !== scan
          || this.config.getOperationContextKey() !== operationContextKey) {
          vscode.window.showWarningMessage('The comparison changed before the transfer was queued. Scan again and retry.');
          return;
        }
        for (const row of uploads) {
          const localPath = await this.config.resolveSafeLocalPath(row.path);
          if (localPath && this.config.getOperationContextKey() === operationContextKey) {
            await this.queue.enqueueUpload(
              localPath,
              this.config.resolveRemotePath(row.path),
              'file',
              operationContextKey
            );
          }
        }
        for (const row of downloads) {
          const localPath = await this.config.resolveSafeLocalPath(row.path);
          if (localPath && this.config.getOperationContextKey() === operationContextKey) {
            await this.queue.enqueueDownload(
              this.config.resolveRemotePath(row.path),
              localPath,
              'file',
              operationContextKey
            );
          }
        }
        break;
      }
      case 'bulk-action': {
        const action = String(message.action ?? '');
        if (action !== 'upload' && action !== 'download') {
          return;
        }
        const scan = this.currentScan();
        const operationContextKey = this.config.getOperationContextKey();
        const rowsByPath = new Map((scan?.rows ?? []).map((row) => [row.path, row]));
        const paths = [...new Set(Array.isArray(message.paths) ? message.paths.map(String) : [])]
          .filter((relative) => {
            const row = rowsByPath.get(relative);
            return row && (action === 'upload' ? row.localExists : row.remoteExists);
          });
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
        if (!scan || !operationContextKey || this.scanning || this.currentScan() !== scan
          || this.config.getOperationContextKey() !== operationContextKey) {
          vscode.window.showWarningMessage('The comparison changed before the transfer was queued. Scan again and retry.');
          return;
        }
        for (const relative of paths) {
          const localPath = await this.config.resolveSafeLocalPath(relative);
          if (!localPath || this.config.getOperationContextKey() !== operationContextKey) {
            continue;
          }
          const remotePath = this.config.resolveRemotePath(relative);
          if (action === 'upload') {
            await this.queue.enqueueUpload(localPath, remotePath, 'file', operationContextKey);
          } else if (action === 'download') {
            await this.queue.enqueueDownload(remotePath, localPath, 'file', operationContextKey);
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
    const contextKey = this.scanContextKey();
    if (!root || !contextKey) {
      this.postScanStatus('Open a workspace and configure an account first.', true);
      return;
    }
    if (this.queue.items.some((item) => item.status === 'running' || item.status === 'queued' || item.status === 'held')) {
      this.postScanStatus('Wait for active or paused transfers to finish, then scan again.', true);
      return;
    }
    const queueRevision = this.queue.revision;

    this.scanning = true;
    this.lastScan = undefined;
    void this.currentPanel?.webview.postMessage({ type: 'scan-start' });
    try {
      if (!(await this.ensureConnected())) {
        this.postScanStatus('Not connected — check the account settings and try again.', true);
        return;
      }
      if (this.scanContextKey() !== contextKey) {
        this.postScanStatus('The active account changed while connecting. Start a new comparison scan.', true);
        return;
      }
      const rows = new Map<string, CompareRow>();
      const localDirectories = new Set<string>();
      const remoteDirectories = new Set<string>();
      const unsafeLocalPrefixes = new Set<string>();
      const ignore = this.config.getIgnoreMatcher();
      const showHidden = this.config.getShowHidden();
      let localCount = 0;
      let remoteCount = 0;
      let scanIssues = 0;
      let depthCapped = false;

      const walkLocal = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_SCAN_DEPTH) {
          depthCapped = true;
          return;
        }
        if (localCount >= MAX_ENTRIES_PER_SIDE) {
          return;
        }
        let entries: import('fs').Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
          scanIssues += 1;
          this.logger.append('error', `Sync Center could not read local folder ${dir}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        for (const entry of entries) {
          if (localCount >= MAX_ENTRIES_PER_SIDE) {
            return;
          }
          if (!showHidden && entry.name.startsWith('.')) {
            continue;
          }
          const fullPath = path.join(dir, entry.name);
          const relative = relativeTo(root.fsPath, fullPath);
          if (!isSafeRelativePath(relative) || ignore.isIgnored(relative)) {
            continue;
          }
          if (entry.isSymbolicLink()) {
            unsafeLocalPrefixes.add(relative);
            scanIssues += 1;
            this.logger.append('warn', `Sync Center skipped linked local path ${fullPath}; linked paths cannot be safely synchronized.`);
            continue;
          }
          if (entry.isDirectory()) {
            localDirectories.add(relative);
            await walkLocal(fullPath, depth + 1);
          } else {
            const stat = await fs.stat(fullPath).catch(() => undefined);
            if (stat) {
              localCount += 1;
              rows.set(relative, {
                path: relative,
                localExists: true,
                remoteExists: false,
                localSize: stat.size,
                localMtime: stat.mtimeMs,
                state: 'unknown',
                label: ''
              });
            } else {
              scanIssues += 1;
              this.logger.append('error', `Sync Center could not stat local file ${fullPath}; bulk mirror actions are disabled for this scan.`);
            }
          }
        }
      };

      const walkRemote = async (relativeDir: string, depth: number): Promise<void> => {
        if (depth > MAX_SCAN_DEPTH) {
          depthCapped = true;
          return;
        }
        if (remoteCount >= MAX_ENTRIES_PER_SIDE) {
          return;
        }
        this.postScanStatus(`Scanning server: /${relativeDir || ''}…`);
        let children: Awaited<ReturnType<SftpService['list']>>;
        try {
          children = await this.sftp.list(this.config.resolveRemotePath(relativeDir));
        } catch (error) {
          scanIssues += 1;
          this.logger.append('error', `Sync Center could not read server folder /${relativeDir}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        for (const child of children) {
          if (remoteCount >= MAX_ENTRIES_PER_SIDE) {
            return;
          }
          const name = path.posix.basename(child.remotePath);
          if (!showHidden && name.startsWith('.')) {
            continue;
          }
          const relative = child.relativePath;
          const underUnsafeLocalPath = [...unsafeLocalPrefixes].some((unsafe) =>
            relative === unsafe || relative.startsWith(`${unsafe}/`)
          );
          if (!isSafeRelativePath(relative) || ignore.isIgnored(relative) || underUnsafeLocalPath) {
            continue;
          }
          if (child.isDirectory) {
            remoteDirectories.add(relative);
            await walkRemote(relative, depth + 1);
          } else {
            remoteCount += 1;
            const existing = rows.get(relative);
            if (existing) {
              existing.remoteExists = true;
              existing.remoteSize = child.size;
              existing.remoteMtime = child.modifiedAt;
            } else {
              rows.set(relative, {
                path: relative,
                localExists: false,
                remoteExists: true,
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

      if (this.scanContextKey() !== contextKey || this.queue.revision !== queueRevision) {
        this.postScanStatus('Discarded comparison results because the account or transfer queue changed during the scan.', true);
        return;
      }

      for (const row of rows.values()) {
        if (!row.localExists || row.localMtime === undefined) {
          row.state = 'missingLocal';
          row.label = 'Server only';
        } else if (!row.remoteExists) {
          row.state = 'missingRemote';
          row.label = 'Local only';
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
        if (!row.localExists) {
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
      const truncated = localCount >= MAX_ENTRIES_PER_SIDE || remoteCount >= MAX_ENTRIES_PER_SIDE || depthCapped;
      const complete = !truncated && scanIssues === 0;
      const status = `Scan finished: ${sorted.length} file(s) compared (${localCount} local, ${remoteCount} on server)`
        + `${truncated ? ' — capped; narrow the sync folder or add ignore patterns' : ''}`
        + `${scanIssues ? ` — ${scanIssues} folder${scanIssues === 1 ? '' : 's'} could not be read; bulk mirror actions are disabled` : ''}.`;
      this.lastScan = {
        rows: sorted,
        localDirectories: [...localDirectories],
        remoteDirectories: [...remoteDirectories],
        truncated,
        complete,
        status,
        contextKey,
        queueRevision,
        stale: false
      };
      void this.currentPanel?.webview.postMessage({ type: 'compare-data', rows: sorted, truncated, complete });
      this.postScanStatus(status, true);
      this.logger.append('info', `Sync Center scan compared ${sorted.length} file(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.append('error', `Sync Center scan failed: ${message}`);
      this.postScanStatus(`Scan failed: ${message}`, true);
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
    :root {
      color-scheme: light dark;
      --c-sync: var(--vscode-charts-green, #2ea043);
      --c-lnew: var(--vscode-charts-orange, #d18616);
      --c-rnew: var(--vscode-charts-yellow, #d29922);
      --c-lonly: var(--vscode-charts-blue, #3794ff);
      --c-sonly: var(--vscode-charts-red, #f85149);
      --c-unk: var(--vscode-descriptionForeground, #8b949e);
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 10px 14px 28px;
      margin: 0;
    }
    h1 { font-size: 1.18em; font-weight: 600; margin: 0 0 8px; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3)); margin-bottom: 9px; }
    .tab {
      padding: 6px 14px; cursor: pointer; border: none; background: none;
      color: var(--vscode-foreground); opacity: 0.7; font-family: inherit; font-size: inherit;
      border-bottom: 2px solid transparent;
    }
    .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
    .toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 7px; }
    button {
      font-family: inherit; font-size: inherit; border: 1px solid transparent; border-radius: 4px;
      padding: 4px 9px; cursor: pointer;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.18));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    button.mini { padding: 2px 6px; font-size: 0.86em; }
    button:disabled { opacity: 0.4; cursor: default; }
    select {
      padding: 4px 8px; border-radius: 4px; font-family: inherit; font-size: inherit;
      background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.35));
    }
    .status-line { opacity: 0.75; margin: 4px 0 7px; min-height: 1.2em; }
    .pill { display: inline-block; padding: 1px 9px; border-radius: 10px; font-size: 0.85em; white-space: nowrap; }
    .pill.synced { background: color-mix(in srgb, var(--vscode-charts-green, #2ea043) 20%, transparent); color: var(--vscode-charts-green, #2ea043); }
    .pill.differ { background: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 20%, transparent); color: var(--vscode-charts-orange, #d18616); }
    .pill.missing { background: color-mix(in srgb, var(--vscode-charts-red, #f85149) 20%, transparent); color: var(--vscode-charts-red, #f85149); }
    .pill.unknown { background: rgba(128,128,128,0.2); }
    .pill.held { background: color-mix(in srgb, var(--vscode-charts-yellow, #d29922) 20%, transparent); color: var(--vscode-charts-yellow, #d29922); }
    .search-box {
      min-width: 180px; flex: 1 1 220px; max-width: 360px; height: 27px; padding: 3px 8px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; outline: none;
      font-family: inherit; font-size: inherit;
    }
    .search-box:focus { border-color: var(--vscode-focusBorder); }
    .filter-strip { display: flex; gap: 1px; flex-wrap: wrap; }
    .filter-strip button {
      border-radius: 2px; background: transparent; color: var(--vscode-foreground); opacity: 0.72;
    }
    .filter-strip button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.18)); opacity: 1; }
    .filter-strip button.active {
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.2));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); opacity: 1;
      box-shadow: inset 0 -2px var(--vscode-focusBorder);
    }
    .selection-bar {
      display: flex; gap: 5px; align-items: center; flex-wrap: wrap; min-height: 29px;
      padding: 3px 0; border-top: 1px solid rgba(128,128,128,0.1);
    }
    .selection-count { min-width: 72px; opacity: 0.78; }
    .toolbar-spacer { flex: 1 1 auto; }
    .compare-shell {
      min-width: 760px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
      border-radius: 4px; overflow: hidden; background: var(--vscode-editor-background);
      font-size: 0.94em;
    }
    .compare-head, .compare-line {
      display: grid;
      grid-template-columns: minmax(170px, 1fr) 84px 206px minmax(170px, 1fr) 84px;
    }
    .compare-head {
      position: sticky; top: 0; z-index: 4; min-height: 25px; align-items: stretch;
      background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
      text-transform: uppercase; font-size: 0.8em; letter-spacing: 0.06em; font-weight: 600;
    }
    .compare-head > div { display: flex; align-items: center; padding: 3px 8px; }
    .compare-head .center-head { justify-content: center; border-left: 1px solid rgba(128,128,128,0.18); }
    .compare-head .size-head { justify-content: flex-end; opacity: 0.7; }
    .compare-head .size-head.server-size { padding-right: 8px; }
    .compare-head .server-name { border-left: 1px solid rgba(128,128,128,0.18); }
    .head-caption { margin-left: 7px; opacity: 0.55; font-weight: 400; text-transform: none; letter-spacing: 0; }
    .compare-line { min-height: 22px; align-items: center; line-height: 20px; }
    .compare-line:nth-child(even) { background: rgba(128,128,128,0.04); }
    .compare-line:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
    .compare-line.folder-line { background: rgba(128,128,128,0.08); cursor: pointer; }
    .compare-line.folder-line:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.14)); }
    /* Per-state row tint + left stripe so out-of-sync files read at a glance. */
    .compare-line.st-localNewer { --act: var(--c-lnew); background: color-mix(in srgb, var(--c-lnew) 8%, transparent); box-shadow: inset 3px 0 0 var(--c-lnew); }
    .compare-line.st-localNewer:hover { background: color-mix(in srgb, var(--c-lnew) 16%, transparent); }
    .compare-line.st-remoteNewer { --act: var(--c-rnew); background: color-mix(in srgb, var(--c-rnew) 8%, transparent); box-shadow: inset 3px 0 0 var(--c-rnew); }
    .compare-line.st-remoteNewer:hover { background: color-mix(in srgb, var(--c-rnew) 16%, transparent); }
    .compare-line.st-missingRemote { --act: var(--c-lonly); background: color-mix(in srgb, var(--c-lonly) 8%, transparent); box-shadow: inset 3px 0 0 var(--c-lonly); }
    .compare-line.st-missingRemote:hover { background: color-mix(in srgb, var(--c-lonly) 16%, transparent); }
    .compare-line.st-missingLocal { --act: var(--c-sonly); background: color-mix(in srgb, var(--c-sonly) 8%, transparent); box-shadow: inset 3px 0 0 var(--c-sonly); }
    .compare-line.st-missingLocal:hover { background: color-mix(in srgb, var(--c-sonly) 16%, transparent); }
    .compare-line.st-synced { --act: var(--c-sync); box-shadow: inset 3px 0 0 color-mix(in srgb, var(--c-sync) 55%, transparent); }
    .compare-line.st-unknown { --act: var(--c-unk); }
    .compare-line.folder-line.attention { --act: var(--c-lnew); box-shadow: inset 3px 0 0 color-mix(in srgb, var(--c-lnew) 70%, transparent); }
    .side-cell {
      min-width: 0; align-self: stretch; display: flex; align-items: center; gap: 4px;
      padding: 0 6px; overflow: hidden; white-space: nowrap;
    }
    .side-cell.server { border-left: 1px solid rgba(128,128,128,0.18); }
    .side-cell.missing-side { opacity: 0.38; font-style: italic; }
    .size-cell {
      min-width: 0; padding: 0 8px 0 4px; text-align: right; white-space: nowrap;
      overflow: hidden; opacity: 0.7; font-variant-numeric: tabular-nums;
    }
    .tree-twisty { width: 11px; flex: 0 0 11px; text-align: center; opacity: 0.75; font-size: 0.85em; }
    .tree-icon { flex: 0 0 auto; font-size: 0.95em; line-height: 1; }
    .tree-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .folder-line .tree-name { font-weight: 600; }
    .center-cell {
      min-width: 0; align-self: stretch; padding: 0 4px; display: flex; align-items: center;
      gap: 2px; flex-wrap: nowrap; overflow: hidden; border-left: 1px solid rgba(128,128,128,0.18);
    }
    .row-check { flex: 0 0 auto; width: 13px; height: 13px; margin: 0 2px 0 0; }
    .status-glyph {
      flex: 0 0 auto; min-width: 20px; padding: 0 3px; text-align: center; font-weight: 700;
      cursor: default; border-radius: 3px; background: color-mix(in srgb, currentColor 14%, transparent);
    }
    .status-glyph.synced, .status-glyph.st-synced { color: var(--c-sync); }
    .status-glyph.differ, .status-glyph.st-localNewer { color: var(--c-lnew); }
    .status-glyph.st-remoteNewer { color: var(--c-rnew); }
    .status-glyph.st-missingRemote { color: var(--c-lonly); }
    .status-glyph.missing, .status-glyph.st-missingLocal { color: var(--c-sonly); }
    .status-glyph.unknown, .status-glyph.st-unknown { color: var(--c-unk); }
    .dir-group {
      display: inline-flex; align-items: center; margin: 0 2px;
      border: 1px solid rgba(128,128,128,0.35); border-radius: 4px; overflow: hidden;
    }
    button.dir-toggle {
      min-width: 18px; height: 18px; padding: 0 2px; line-height: 16px; font-size: 0.88em;
      background: transparent; border: none; border-radius: 0; color: var(--vscode-foreground); opacity: 0.45;
    }
    button.dir-toggle + button.dir-toggle { border-left: 1px solid rgba(128,128,128,0.25); }
    button.dir-toggle:hover:not(:disabled) { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.25)); }
    button.dir-toggle.active {
      opacity: 1; font-weight: 700;
      color: var(--act, var(--vscode-foreground));
      background: color-mix(in srgb, var(--act, var(--vscode-focusBorder)) 26%, transparent);
    }
    button.dir-toggle.d-skip.active { color: var(--vscode-foreground); background: rgba(128,128,128,0.28); }
    button.dir-toggle:disabled { opacity: 0.15; }
    .inline-actions { display: flex; gap: 1px; align-items: center; margin-left: auto; }
    button.icon-action {
      min-width: 21px; height: 20px; padding: 0 3px; line-height: 18px; font-size: 0.92em;
      background: transparent; border: 1px solid transparent; border-radius: 3px;
      color: var(--vscode-foreground); opacity: 0.6;
    }
    button.icon-action:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.25)); opacity: 1; }
    button.icon-action:disabled { opacity: 0.18; }
    .more-row { padding: 8px; text-align: center; border-top: 1px solid rgba(128,128,128,0.14); }
    .page-label { display: inline-block; min-width: 92px; opacity: 0.7; }

    .transfer-controls { border-bottom: 1px solid rgba(128,128,128,0.14); padding-bottom: 6px; }
    .transfer-shell { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 4px; overflow: hidden; }
    .transfer-head, .transfer-row {
      display: grid; grid-template-columns: minmax(150px, 0.75fr) minmax(220px, 1.45fr) minmax(150px, 0.8fr) auto;
      column-gap: 8px; align-items: center;
    }
    .transfer-head {
      min-height: 30px; padding: 3px 8px; background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
      text-transform: uppercase; font-size: 0.78em; letter-spacing: 0.05em; opacity: 0.78;
    }
    .transfer-row {
      position: relative; min-height: 35px; padding: 3px 8px; border-bottom: 1px solid rgba(128,128,128,0.12);
    }
    .transfer-row:last-child { border-bottom: 0; }
    .transfer-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); }
    .transfer-main, .transfer-path, .transfer-state { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .transfer-main { font-weight: 600; }
    .transfer-direction { display: inline-block; width: 17px; text-align: center; }
    .transfer-path { opacity: 0.65; font-size: 0.88em; }
    .transfer-state { font-size: 0.88em; }
    .transfer-time { opacity: 0.58; margin-left: 5px; }
    .transfer-buttons { white-space: nowrap; text-align: right; }
    .transfer-buttons button + button { margin-left: 3px; }
    .transfer-error { grid-column: 2 / 4; color: var(--vscode-charts-red, #f85149); font-size: 0.82em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(128,128,128,0.18); overflow: hidden; }
    .bar > div { height: 100%; background: var(--vscode-progressBar-background, #0e70c0); transition: width 0.2s; }
    .empty { opacity: 0.6; padding: 24px 0; text-align: center; }
    .counts { opacity: 0.85; margin-left: auto; }
    .counts .c-sync { color: var(--c-sync); }
    .counts .c-differ { color: var(--c-lnew); }
    .counts .c-lonly { color: var(--c-lonly); }
    .counts .c-sonly { color: var(--c-sonly); }
    .filter-strip .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
    .dot.d-attn { background: linear-gradient(135deg, var(--c-lnew) 50%, var(--c-sonly) 50%); }
    .dot.d-differ { background: linear-gradient(135deg, var(--c-lnew) 50%, var(--c-rnew) 50%); }
    .dot.d-lonly { background: var(--c-lonly); }
    .dot.d-sonly { background: var(--c-sonly); }
    .dot.d-sync { background: var(--c-sync); }
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
    @media (max-width: 900px) {
      .compare-head, .compare-line { grid-template-columns: minmax(160px, 1fr) 180px minmax(160px, 1fr); }
      .size-cell, .size-head { display: none; }
      .transfer-head, .transfer-row { grid-template-columns: minmax(140px, 0.8fr) minmax(170px, 1fr) minmax(130px, 0.7fr) auto; }
    }
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
      <button id="scan">Scan &amp; Compare</button>
      <input class="search-box" id="compareSearch" type="search" placeholder="Filter by path" aria-label="Filter compared files by path" />
      <span class="counts" id="compareCounts"></span>
    </div>
    <div class="toolbar">
      <div class="filter-strip" id="compareFilters" aria-label="Comparison status filters">
        <button class="active" data-filter="attention"><span class="dot d-attn"></span>Not in sync</button>
        <button data-filter="differ"><span class="dot d-differ"></span>Different</button>
        <button data-filter="missingRemote"><span class="dot d-lonly"></span>Local only</button>
        <button data-filter="missingLocal"><span class="dot d-sonly"></span>Server only</button>
        <button data-filter="synced"><span class="dot d-sync"></span>In sync</button>
        <button data-filter="all">All</button>
      </div>
      <span class="toolbar-spacer"></span>
      <button class="secondary mini" id="expandAll">Expand All</button>
      <button class="secondary mini" id="collapseAll">Collapse All</button>
    </div>
    <div class="selection-bar">
      <span class="selection-count" id="selectionCount">0 selected</span>
      <button class="secondary mini" id="selUpload" disabled>Local &rarr; Server</button>
      <button class="secondary mini" id="selDownload" disabled>Server &rarr; Local</button>
      <button class="secondary mini" id="selSync" disabled>Use newer side</button>
      <button class="secondary mini" id="selMark" disabled title="Align equal-size file timestamps only; no content is transferred or compared">Mark in sync</button>
      <button class="secondary mini" id="selIgnore" disabled title="Add selected paths to the persistent ignore list">Ignore</button>
      <span class="toolbar-spacer"></span>
      <button class="mini" id="syncShown" disabled title="Sync every shown out-of-sync file, newer side wins (⬆ upload / ⬇ download decided per file)">&#8645; Sync Shown</button>
      <button class="secondary mini" id="bulkUpload" disabled>Upload shown</button>
      <button class="secondary mini" id="bulkDownload" disabled>Download shown</button>
      <button class="secondary mini" id="makeIdentical" disabled title="Mirror one side's files to the other; orphan deletion is confirmed first and empty directories are not included">Make Identical&hellip;</button>
    </div>
    <div class="status-line" id="scanStatus">Press "Scan &amp; Compare" to walk both sides and build the full comparison.</div>
    <div class="compare-shell" id="compareTree" style="display:none">
      <div class="compare-head">
        <div>Local files <span class="head-caption">workspace</span></div>
        <div class="size-head">Size</div>
        <div class="center-head"><input type="checkbox" id="selectAll" title="Select or deselect all shown files" />&nbsp; Status / Direction</div>
        <div class="server-name">Server files <span class="head-caption">remote</span></div>
        <div class="size-head server-size">Size</div>
      </div>
      <div id="compareBody"></div>
      <div class="more-row" id="compareMore" style="display:none"><button class="secondary mini">Show more rows</button></div>
    </div>
    <div class="empty" id="compareEmpty" style="display:none">Nothing matches this filter.</div>
  </div>

  <div id="transfersPane" style="display:none">
    <div class="toolbar transfer-controls">
      <button id="pauseQueue" class="secondary">Pause Queue</button>
      <select id="transferFilter" aria-label="Filter transfers">
        <option value="recent">Recent (active and failed first)</option>
        <option value="active">Active</option>
        <option value="failed">Failed</option>
        <option value="completed">Completed</option>
        <option value="all">All</option>
      </select>
      <input class="search-box" id="transferSearch" type="search" placeholder="Filter transfers" aria-label="Filter transfers by file or path" />
      <button id="clearCompleted" class="secondary">Clear Completed</button>
      <span class="counts" id="queueCounts"></span>
    </div>
    <div class="status-line" id="transferShowing"></div>
    <div class="transfer-shell" id="transferShell" style="display:none">
      <div class="transfer-head"><div>File</div><div>Path</div><div>Status / progress</div><div>Actions</div></div>
      <div id="transferList"></div>
      <div class="more-row" id="transferMore" style="display:none">
        <button class="secondary mini" id="transferPrev">Previous</button>
        <span class="page-label" id="transferPageLabel"></span>
        <button class="secondary mini" id="transferNext">Next</button>
      </div>
    </div>
    <div class="empty" id="transfersEmpty">No transfers yet. Uploads and downloads appear here live.</div>
  </div>

  <div id="ctxMenu"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let rows = [];
    let transfers = [];
    let transferById = new Map();
    let queuePaused = false;
    let transferSummary = { running: 0, queued: 0, held: 0, completed: 0, failed: 0 };
    let expanded = new Set();
    let selected = new Set();
    let rowMap = new Map();
    let compareFilter = 'attention';
    let compareRenderLimit = 750;
    let compareRendered = 0;
    let compareHasMore = false;
    const transferPageSize = 200;
    let transferPage = 0;
    let activeTab = 'compare';
    let scanComplete = true;
    let scanAvailable = false;

    const el = (id) => document.getElementById(id);
    const fmtBytes = (n) => n === undefined || n === null ? '—' : n < 1024 ? n + ' B' : n < 1048576 ? (n/1024).toFixed(1) + ' KB' : (n/1048576).toFixed(2) + ' MB';
    const fmtDate = (ms) => ms ? new Date(ms).toLocaleString() : '';
    const fmtTime = (ms) => ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    const hasLocal = (r) => r.localExists !== undefined ? r.localExists : r.localMtime !== undefined;
    const hasRemote = (r) => r.remoteExists !== undefined ? r.remoteExists : r.remoteSize !== undefined || r.remoteMtime !== undefined;

    function stateBucket(state) {
      if (state === 'synced') return 'synced';
      if (state === 'localNewer' || state === 'remoteNewer') return 'differ';
      if (state === 'missingLocal' || state === 'missingRemote') return 'missing';
      return 'unknown';
    }

    function visibleRows() {
      const filter = compareFilter;
      const query = el('compareSearch').value.trim().toLocaleLowerCase();
      return rows.filter((row) => {
        if (query && !row.path.toLocaleLowerCase().includes(query)) return false;
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
      out = out || { synced: 0, differ: 0, missing: 0, unknown: 0, local: 0, remote: 0, uploadable: [], downloadable: [] };
      node.files.forEach((row) => {
        out[stateBucket(row.state)] += 1;
        if (hasLocal(row)) out.local += 1;
        if (hasRemote(row)) out.remote += 1;
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
        return r && (r.state === 'localNewer' || r.state === 'remoteNewer')
          && hasLocal(r) && hasRemote(r)
          && r.localSize !== undefined && r.remoteSize !== undefined
          && r.localSize === r.remoteSize;
      });
    }

    function sendMarkSynced(paths) {
      const markable = markablePaths(paths);
      if (markable.length) vscode.postMessage({ type: 'mark-synced', paths: markable });
    }

    function sendIgnore(paths) {
      const unique = [...new Set(paths.filter((p) => rowMap.has(p) || rows.some((r) => r.path.startsWith(p + '/'))))];
      if (unique.length) vscode.postMessage({ type: 'ignore-paths', paths: unique });
    }

    function runSmartSync(paths) {
      const split = smartSplit(paths);
      if (split.up.length || split.down.length) {
        vscode.postMessage({ type: 'smart-bulk', paths });
        switchTab('transfers');
      }
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
        { label: '⬆ Upload folder → server (' + agg.uploadable.length + ' file' + (agg.uploadable.length === 1 ? '' : 's') + ')', disabled: !scanAvailable || !agg.uploadable.length, run: () => { sendBulk('upload', agg.uploadable); switchTab('transfers'); } },
        { label: '⬇ Download folder ← server (' + agg.downloadable.length + ' file' + (agg.downloadable.length === 1 ? '' : 's') + ')', disabled: !scanAvailable || !agg.downloadable.length, run: () => { sendBulk('download', agg.downloadable); switchTab('transfers'); } },
        { label: '⇅ Smart sync folder (⬆ ' + split.up.length + ' / ⬇ ' + split.down.length + ')', disabled: !scanAvailable || (!split.up.length && !split.down.length), run: () => runSmartSync(all) },
        { label: '✓ Mark folder in sync (' + markablePaths(all).length + ' equal-size files; timestamps only)', disabled: !scanAvailable || !markablePaths(all).length, run: () => sendMarkSynced(all) },
        { label: '⊘ Ignore folder (persist in sftp.json)', disabled: !scanAvailable, run: () => sendIgnore([node.path]) },
        '-',
        { label: allSelected ? '☐ Deselect all in folder' : '☑ Select all in folder (' + all.length + ')', disabled: !scanAvailable || !all.length, run: () => toggleSelection(all, !allSelected) },
        { label: '📋 Copy path', run: () => copyText(node.path) }
      ]);
    }

    function openFileMenu(ev, row) {
      const split = smartSplit([row.path]);
      const isSelected = selected.has(row.path);
      showMenu(ev, [
        { label: '⬆ Upload to server', disabled: !scanAvailable || !hasLocal(row), run: () => { vscode.postMessage({ type: 'row-action', action: 'upload', path: row.path }); switchTab('transfers'); } },
        { label: '⬇ Download from server', disabled: !scanAvailable || !hasRemote(row), run: () => { vscode.postMessage({ type: 'row-action', action: 'download', path: row.path }); switchTab('transfers'); } },
        { label: '⇅ Smart sync (newer side wins)', disabled: !scanAvailable || (!split.up.length && !split.down.length), run: () => runSmartSync([row.path]) },
        { label: '✓ Mark in sync (equal size; timestamps only)', disabled: !scanAvailable || !markablePaths([row.path]).length, run: () => sendMarkSynced([row.path]) },
        { label: '🔀 Diff local ↔ server', disabled: !scanAvailable || !(hasLocal(row) && hasRemote(row)), run: () => vscode.postMessage({ type: 'row-action', action: 'diff', path: row.path }) },
        { label: '⊘ Ignore (persist in sftp.json)', disabled: !scanAvailable, run: () => sendIgnore([row.path]) },
        '-',
        { label: isSelected ? '☐ Deselect' : '☑ Select', disabled: !scanAvailable, run: () => toggleSelection([row.path], !isSelected) },
        { label: '📋 Copy path', run: () => copyText(row.path) }
      ]);
    }

    function createAction(text, title, enabled, run, recommended) {
      const button = document.createElement('button');
      button.className = 'secondary icon-action' + (recommended ? ' recommended' : '');
      button.textContent = text;
      button.title = title;
      button.setAttribute('aria-label', title);
      button.disabled = !enabled;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (enabled) run();
      });
      return button;
    }

    function createSelection(paths, title) {
      const checked = paths.filter((candidate) => selected.has(candidate)).length;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'row-check';
      input.checked = paths.length > 0 && checked === paths.length;
      input.indeterminate = checked > 0 && checked < paths.length;
      input.disabled = !scanAvailable;
      input.title = title;
      input.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleSelection(paths, checked !== paths.length);
      });
      return input;
    }

    function createSideCell(options) {
      const cell = document.createElement('div');
      cell.className = 'side-cell' + (options.server ? ' server' : '') + (options.exists ? '' : ' missing-side');
      cell.style.paddingLeft = (6 + options.depth * 14) + 'px';
      const twisty = document.createElement('span');
      twisty.className = 'tree-twisty';
      twisty.textContent = options.folder ? (options.open ? '▾' : '▸') : '';
      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = options.exists ? (options.folder ? '📁' : '📄') : '·';
      const name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = options.exists ? options.name : options.missingLabel;
      name.title = options.title ? options.path + '\\n' + options.title : options.path;
      cell.append(twisty, icon, name);
      return cell;
    }

    function createSizeCell(text, title) {
      const cell = document.createElement('div');
      cell.className = 'size-cell';
      cell.textContent = text || '';
      if (title) cell.title = title;
      return cell;
    }

    function statusGlyphChar(state) {
      if (state === 'synced') return '=';
      if (state === 'localNewer') return '›';
      if (state === 'missingRemote') return '»';
      if (state === 'remoteNewer') return '‹';
      if (state === 'missingLocal') return '«';
      return '?';
    }

    function createStatus(glyph, stateClass, title) {
      const span = document.createElement('span');
      span.className = 'status-glyph ' + stateClass;
      span.textContent = glyph;
      span.title = title;
      return span;
    }

    // GoodSync-style 3-position direction control: ←  ○  →  (download / skip /
    // upload). The recommended direction (newer / only-existing side) is
    // pre-highlighted; clicking a side immediately queues that transfer.
    function createDirGroup(options) {
      const group = document.createElement('div');
      group.className = 'dir-group';
      const make = (dir, glyph, label, enabled, active, run) => {
        const button = document.createElement('button');
        button.className = 'dir-toggle d-' + dir + (active ? ' active' : '');
        button.textContent = glyph;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.disabled = !enabled;
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          if (enabled) run();
        });
        return button;
      };
      group.appendChild(make('down', '←', options.downLabel, options.canDown, options.recommended === 'down', options.onDown));
      group.appendChild(make('skip', '○', options.skipLabel || 'No action', true, options.recommended === 'skip', options.onSkip || (() => {})));
      group.appendChild(make('up', '→', options.upLabel, options.canUp, options.recommended === 'up', options.onUp));
      return group;
    }

    function renderCompare() {
      const body = el('compareBody');
      body.textContent = '';
      const shown = visibleRows();
      el('compareTree').style.display = shown.length ? '' : 'none';
      el('compareEmpty').style.display = rows.length && !shown.length ? '' : 'none';

      const counts = { synced: 0, differ: 0, localOnly: 0, serverOnly: 0, unknown: 0 };
      rows.forEach((row) => {
        if (row.state === 'missingRemote') counts.localOnly += 1;
        else if (row.state === 'missingLocal') counts.serverOnly += 1;
        else counts[stateBucket(row.state)] += 1;
      });
      const notInSync = rows.length - counts.synced;
      el('compareCounts').textContent = '';
      if (rows.length) {
        const seg = (cls, value, label) => {
          const span = document.createElement('span');
          if (cls) span.className = cls;
          span.textContent = value + ' ' + label;
          return span;
        };
        const parts = [
          seg('c-sync', counts.synced, 'in sync'),
          seg('', notInSync, 'not in sync'),
          seg('c-differ', counts.differ, 'different'),
          seg('c-lonly', counts.localOnly, 'local only'),
          seg('c-sonly', counts.serverOnly, 'server only')
        ];
        parts.forEach((part, index) => {
          if (index) el('compareCounts').appendChild(document.createTextNode(' · '));
          el('compareCounts').appendChild(part);
        });
      }
      el('bulkUpload').disabled = !scanComplete || !shown.some((row) => hasLocal(row) && row.state !== 'synced');
      el('bulkDownload').disabled = !scanComplete || !shown.some((row) => hasRemote(row) && row.state !== 'synced');
      const shownSync = smartSplit(shown.map((row) => row.path));
      el('syncShown').disabled = !scanComplete || (!shownSync.up.length && !shownSync.down.length);
      el('syncShown').textContent = '⇅ Sync Shown (' + (shownSync.up.length + shownSync.down.length) + ')';

      selected = new Set([...selected].filter((candidate) => rowMap.has(candidate)));
      const selectedPaths = [...selected];
      const upSelected = selectedPaths.filter((candidate) => hasLocal(rowMap.get(candidate))).length;
      const downSelected = selectedPaths.filter((candidate) => hasRemote(rowMap.get(candidate))).length;
      const smartSelected = smartSplit(selectedPaths);
      const markSelected = markablePaths(selectedPaths);
      el('selectionCount').textContent = selectedPaths.length + ' selected';
      el('selUpload').textContent = 'Local → Server (' + upSelected + ')';
      el('selUpload').disabled = !scanAvailable || !upSelected;
      el('selDownload').textContent = 'Server → Local (' + downSelected + ')';
      el('selDownload').disabled = !scanAvailable || !downSelected;
      el('selSync').textContent = 'Use newer side (' + (smartSelected.up.length + smartSelected.down.length) + ')';
      el('selSync').disabled = !scanAvailable || (!smartSelected.up.length && !smartSelected.down.length);
      el('selMark').textContent = 'Mark in sync (' + markSelected.length + ')';
      el('selMark').disabled = !scanAvailable || !markSelected.length;
      el('selIgnore').textContent = 'Ignore (' + selectedPaths.length + ')';
      el('selIgnore').disabled = !scanAvailable || !selectedPaths.length;
      el('makeIdentical').disabled = !rows.length || !scanComplete;

      const shownSelected = shown.filter((row) => selected.has(row.path)).length;
      el('selectAll').checked = shown.length > 0 && shownSelected === shown.length;
      el('selectAll').indeterminate = shownSelected > 0 && shownSelected < shown.length;
      el('selectAll').disabled = !scanAvailable;

      compareRendered = 0;
      compareHasMore = false;
      const fragment = document.createDocumentFragment();
      renderPairedNode(buildTree(shown), 0, fragment, Boolean(el('compareSearch').value.trim()));
      body.appendChild(fragment);
      el('compareMore').style.display = compareHasMore ? '' : 'none';
    }

    function renderPairedNode(node, depth, body, forceOpen) {
      const folders = [...node.children.values()].sort((left, right) => left.name.localeCompare(right.name));
      for (const child of folders) {
        if (compareRendered >= compareRenderLimit) {
          compareHasMore = true;
          return;
        }
        compareRendered += 1;
        const isOpen = forceOpen || expanded.has(child.path);
        const aggregateState = aggregate(child);
        const all = filePathsUnder(child);
        const split = smartSplit(all);
        const markable = markablePaths(all);
        const changed = aggregateState.differ + aggregateState.missing + aggregateState.unknown;
        const line = document.createElement('div');
        line.className = 'compare-line folder-line' + (changed ? ' attention' : '');
        const folderDetail = child.path + '\\n' + aggregateState.synced + ' in sync · ' + changed + ' need attention';
        line.appendChild(createSideCell({
          exists: aggregateState.local > 0,
          server: false,
          folder: true,
          open: isOpen,
          depth,
          name: child.name,
          path: child.path,
          missingLabel: 'Not in local tree',
          title: aggregateState.local ? aggregateState.local + ' file' + (aggregateState.local === 1 ? '' : 's') : ''
        }));
        line.appendChild(createSizeCell(aggregateState.local ? aggregateState.local + ' file' + (aggregateState.local === 1 ? '' : 's') : '', folderDetail));

        const canUp = scanAvailable && aggregateState.uploadable.length > 0;
        const canDown = scanAvailable && aggregateState.downloadable.length > 0;
        const folderRec = !changed ? 'skip' : canUp && !canDown ? 'up' : canDown && !canUp ? 'down' : 'skip';
        const center = document.createElement('div');
        center.className = 'center-cell';
        center.appendChild(createSelection(all, 'Select all shown files under ' + child.path));
        center.appendChild(createStatus(changed ? '≠' : '=', changed ? 'differ' : 'st-synced', folderDetail));
        center.appendChild(createDirGroup({
          canDown,
          canUp,
          recommended: folderRec,
          downLabel: 'Download changed files in this folder: server → local (' + aggregateState.downloadable.length + ')',
          upLabel: 'Upload changed files in this folder: local → server (' + aggregateState.uploadable.length + ')',
          skipLabel: 'Folder needs no transfer',
          onDown: () => { sendBulk('download', aggregateState.downloadable); switchTab('transfers'); },
          onUp: () => { sendBulk('upload', aggregateState.uploadable); switchTab('transfers'); }
        }));
        const actions = document.createElement('div');
        actions.className = 'inline-actions';
        actions.appendChild(createAction('⇅', 'Smart sync folder: newer side wins (↑' + split.up.length + ' / ↓' + split.down.length + ')', scanAvailable && (split.up.length > 0 || split.down.length > 0), () => runSmartSync(all), false));
        actions.appendChild(createAction('✓', 'Mark equal-size files in sync (timestamps only)', scanAvailable && markable.length > 0, () => sendMarkSynced(all), false));
        actions.appendChild(createAction('⊘', 'Ignore this folder persistently', scanAvailable, () => sendIgnore([child.path]), false));
        center.appendChild(actions);
        line.appendChild(center);
        line.appendChild(createSideCell({
          exists: aggregateState.remote > 0,
          server: true,
          folder: true,
          open: isOpen,
          depth,
          name: child.name,
          path: child.path,
          missingLabel: 'Not in server tree',
          title: aggregateState.remote ? aggregateState.remote + ' file' + (aggregateState.remote === 1 ? '' : 's') : ''
        }));
        line.appendChild(createSizeCell(aggregateState.remote ? aggregateState.remote + ' file' + (aggregateState.remote === 1 ? '' : 's') : '', folderDetail));
        line.addEventListener('click', () => {
          if (expanded.has(child.path)) expanded.delete(child.path); else expanded.add(child.path);
          renderCompare();
        });
        line.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openFolderMenu(event, child);
        });
        body.appendChild(line);

        if (isOpen) {
          renderPairedNode(child, depth + 1, body, forceOpen);
          if (compareHasMore) return;
        }
      }

      const files = [...node.files].sort((left, right) => left.path.localeCompare(right.path));
      for (const row of files) {
        if (compareRendered >= compareRenderLimit) {
          compareHasMore = true;
          return;
        }
        compareRendered += 1;
        const name = row.path.split('/').pop();
        const attention = row.state !== 'synced';
        const line = document.createElement('div');
        line.className = 'compare-line st-' + row.state + (attention ? ' attention' : '');
        line.appendChild(createSideCell({
          exists: hasLocal(row),
          server: false,
          folder: false,
          open: false,
          depth,
          name,
          path: row.path,
          missingLabel: 'Not on local',
          title: hasLocal(row) ? fmtBytes(row.localSize) + (row.localMtime ? ' · ' + fmtDate(row.localMtime) : '') : ''
        }));
        line.appendChild(createSizeCell(
          hasLocal(row) ? fmtBytes(row.localSize) : '',
          hasLocal(row) && row.localMtime ? fmtDate(row.localMtime) : ''
        ));

        const uploadRecommended = row.state === 'localNewer' || row.state === 'missingRemote';
        const downloadRecommended = row.state === 'remoteNewer' || row.state === 'missingLocal';
        const rowRec = uploadRecommended ? 'up' : downloadRecommended ? 'down' : 'skip';
        const center = document.createElement('div');
        center.className = 'center-cell';
        center.appendChild(createSelection([row.path], 'Select ' + row.path));
        center.appendChild(createStatus(statusGlyphChar(row.state), 'st-' + row.state, (row.label || row.state) + ' — ' + row.path));
        center.appendChild(createDirGroup({
          canDown: scanAvailable && hasRemote(row),
          canUp: scanAvailable && hasLocal(row),
          recommended: rowRec,
          downLabel: 'Download server → local',
          upLabel: 'Upload local → server',
          skipLabel: row.state === 'synced' ? 'In sync — no action' : 'No action',
          onDown: () => { vscode.postMessage({ type: 'row-action', action: 'download', path: row.path }); switchTab('transfers'); },
          onUp: () => { vscode.postMessage({ type: 'row-action', action: 'upload', path: row.path }); switchTab('transfers'); }
        }));
        const actions = document.createElement('div');
        actions.className = 'inline-actions';
        actions.appendChild(createAction('Δ', 'Open local ↔ server diff', scanAvailable && hasLocal(row) && hasRemote(row), () => {
          vscode.postMessage({ type: 'row-action', action: 'diff', path: row.path });
        }, false));
        actions.appendChild(createAction('✓', 'Mark in sync (equal size; timestamps only)', scanAvailable && markablePaths([row.path]).length > 0, () => sendMarkSynced([row.path]), false));
        actions.appendChild(createAction('⊘', 'Ignore persistently in sftp.json', scanAvailable, () => sendIgnore([row.path]), false));
        center.appendChild(actions);
        line.appendChild(center);
        line.appendChild(createSideCell({
          exists: hasRemote(row),
          server: true,
          folder: false,
          open: false,
          depth,
          name,
          path: row.path,
          missingLabel: 'Not on server',
          title: hasRemote(row) ? fmtBytes(row.remoteSize) + (row.remoteMtime ? ' · ' + fmtDate(row.remoteMtime) : '') : ''
        }));
        line.appendChild(createSizeCell(
          hasRemote(row) ? fmtBytes(row.remoteSize) : '',
          hasRemote(row) && row.remoteMtime ? fmtDate(row.remoteMtime) : ''
        ));
        line.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          openFileMenu(event, row);
        });
        body.appendChild(line);
      }
    }

    function renderTransfers() {
      const list = el('transferList');
      list.textContent = '';
      transferSummary = { running: 0, queued: 0, held: 0, completed: 0, failed: 0 };
      transfers.forEach((transfer) => { transferSummary[transfer.status] += 1; });
      updateTransferSummary();

      const filter = el('transferFilter').value;
      const query = el('transferSearch').value.trim().toLocaleLowerCase();
      let filtered = transfers.filter((transfer) => {
        if (query && !(transfer.name + ' ' + transfer.remotePath + ' ' + transfer.localPath).toLocaleLowerCase().includes(query)) return false;
        if (filter === 'active') return transfer.status === 'running' || transfer.status === 'queued' || transfer.status === 'held';
        if (filter === 'failed') return transfer.status === 'failed';
        if (filter === 'completed') return transfer.status === 'completed';
        return true;
      });
      if (filter === 'recent') {
        const priority = { running: 0, queued: 1, held: 2, failed: 3, completed: 4 };
        filtered = [...filtered].sort((left, right) => priority[left.status] - priority[right.status] || (right.createdAt || 0) - (left.createdAt || 0));
      }

      const pageCount = Math.max(1, Math.ceil(filtered.length / transferPageSize));
      transferPage = Math.min(transferPage, pageCount - 1);
      const pageStart = transferPage * transferPageSize;
      const visible = filtered.slice(pageStart, pageStart + transferPageSize);
      el('transferShell').style.display = visible.length ? '' : 'none';
      el('transfersEmpty').style.display = visible.length ? 'none' : '';
      el('transfersEmpty').textContent = transfers.length ? 'No transfers match this filter.' : 'No transfers yet. Uploads and downloads appear here live.';
      el('transferShowing').textContent = filtered.length
        ? 'Showing ' + (pageStart + 1) + '–' + (pageStart + visible.length) + ' of ' + filtered.length + ' matching transfer' + (filtered.length === 1 ? '' : 's') + (transfers.length !== filtered.length ? ' (' + transfers.length + ' total)' : '') + '.'
        : '';
      el('transferMore').style.display = pageCount > 1 ? '' : 'none';
      el('transferPrev').disabled = transferPage === 0;
      el('transferNext').disabled = transferPage >= pageCount - 1;
      el('transferPageLabel').textContent = 'Page ' + (transferPage + 1) + ' of ' + pageCount;

      const fragment = document.createDocumentFragment();
      visible.forEach((transfer) => {
        const row = document.createElement('div');
        row.className = 'transfer-row';
        const main = document.createElement('div');
        main.className = 'transfer-main';
        const direction = document.createElement('span');
        direction.className = 'transfer-direction';
        direction.textContent = transfer.direction === 'upload' ? '↑' : '↓';
        direction.title = transfer.direction === 'upload' ? 'Upload: local to server' : 'Download: server to local';
        main.append(direction, document.createTextNode(transfer.name));

        const transferPath = document.createElement('div');
        transferPath.className = 'transfer-path';
        transferPath.textContent = transfer.remotePath;
        transferPath.title = transfer.remotePath;

        const state = document.createElement('div');
        state.className = 'transfer-state';
        const statusPill = document.createElement('span');
        statusPill.className = 'pill ' + (transfer.status === 'completed' ? 'synced' : transfer.status === 'failed' ? 'missing' : transfer.status === 'held' ? 'held' : transfer.status === 'running' ? 'differ' : 'unknown');
        statusPill.textContent = transfer.status;
        state.appendChild(statusPill);
        const statusText = document.createElement('span');
        statusText.className = 'transfer-time';
        const percent = transfer.total ? Math.min(100, Math.round((transfer.transferred || 0) / transfer.total * 100)) : undefined;
        if (transfer.status === 'running' && percent !== undefined) statusText.textContent = percent + '% · ' + fmtBytes(transfer.transferred || 0) + ' / ' + fmtBytes(transfer.total);
        else if (transfer.status === 'completed') statusText.textContent = fmtTime(transfer.completedAt);
        else statusText.textContent = transfer.message || '';
        statusText.title = transfer.message || '';
        state.appendChild(statusText);

        const buttons = document.createElement('div');
        buttons.className = 'transfer-buttons';
        const transferButton = (text, action) => {
          const button = document.createElement('button');
          button.className = 'mini secondary';
          button.textContent = text;
          button.title = text + ' transfer';
          button.addEventListener('click', () => vscode.postMessage({ type: 'transfer-action', action, id: transfer.id }));
          buttons.appendChild(button);
        };
        if (transfer.status === 'queued') transferButton('Pause', 'pause');
        if (transfer.status === 'held') transferButton('Resume', 'resume');
        if (transfer.status === 'failed') transferButton('Retry', 'retry');
        if (transfer.status === 'running') transferButton('Stop', 'stop');
        if (transfer.status !== 'running') transferButton('Remove', 'remove');
        row.append(main, transferPath, state, buttons);

        if (transfer.error) {
          const error = document.createElement('div');
          error.className = 'transfer-error';
          error.textContent = transfer.error;
          error.title = transfer.error;
          row.appendChild(error);
        }
        if (transfer.status === 'running' || (transfer.transferred !== undefined && transfer.status !== 'completed')) {
          const bar = document.createElement('div');
          bar.className = 'bar';
          const fill = document.createElement('div');
          fill.style.width = (percent !== undefined ? percent : transfer.status === 'running' ? 30 : 0) + '%';
          bar.appendChild(fill);
          row.appendChild(bar);
        }
        fragment.appendChild(row);
      });
      list.appendChild(fragment);
    }

    function updateTransferSummary() {
      const active = transferSummary.running + transferSummary.queued + transferSummary.held;
      el('transferCount').textContent = active ? '(' + active + ')' : '';
      el('queueCounts').textContent = transferSummary.completed + ' done · ' + transferSummary.running + ' running · ' + transferSummary.queued + ' queued · ' + transferSummary.held + ' paused · ' + transferSummary.failed + ' failed';
      el('pauseQueue').textContent = queuePaused ? 'Resume Queue' : 'Pause Queue';
    }

    function switchTab(tab) {
      const compare = tab === 'compare';
      activeTab = tab;
      el('tabCompare').classList.toggle('active', compare);
      el('tabTransfers').classList.toggle('active', !compare);
      el('comparePane').style.display = compare ? '' : 'none';
      el('transfersPane').style.display = compare ? 'none' : '';
      vscode.postMessage({ type: 'view-tab', tab });
      if (!compare) renderTransfers();
    }

    el('tabCompare').addEventListener('click', () => switchTab('compare'));
    el('tabTransfers').addEventListener('click', () => switchTab('transfers'));
    el('scan').addEventListener('click', () => {
      el('scan').disabled = true;
      scanComplete = false;
      scanAvailable = false;
      compareRenderLimit = 750;
      renderCompare();
      vscode.postMessage({ type: 'scan' });
    });
    el('compareFilters').querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        compareFilter = button.dataset.filter || 'attention';
        selected = new Set();
        el('compareFilters').querySelectorAll('button').forEach((candidate) => candidate.classList.toggle('active', candidate === button));
        compareRenderLimit = 750;
        renderCompare();
      });
    });
    let compareSearchTimer;
    el('compareSearch').addEventListener('input', () => {
      clearTimeout(compareSearchTimer);
      compareSearchTimer = setTimeout(() => {
        selected = new Set();
        compareRenderLimit = 750;
        renderCompare();
      }, 100);
    });
    el('expandAll').addEventListener('click', () => {
      expanded = new Set(allFolderPaths(buildTree(visibleRows())));
      compareRenderLimit = 750;
      renderCompare();
    });
    el('collapseAll').addEventListener('click', () => { expanded = new Set(); renderCompare(); });
    el('compareMore').querySelector('button').addEventListener('click', () => {
      compareRenderLimit += 750;
      renderCompare();
    });
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
    el('syncShown').addEventListener('click', () => runSmartSync(visibleRows().map((r) => r.path)));
    el('pauseQueue').addEventListener('click', () => vscode.postMessage({ type: 'queue-action', action: queuePaused ? 'resumeAll' : 'pauseAll' }));
    el('clearCompleted').addEventListener('click', () => vscode.postMessage({ type: 'queue-action', action: 'clearCompleted' }));
    el('transferFilter').addEventListener('change', () => { transferPage = 0; renderTransfers(); });
    let transferSearchTimer;
    el('transferSearch').addEventListener('input', () => {
      clearTimeout(transferSearchTimer);
      transferSearchTimer = setTimeout(() => { transferPage = 0; renderTransfers(); }, 100);
    });
    el('transferPrev').addEventListener('click', () => { transferPage = Math.max(0, transferPage - 1); renderTransfers(); });
    el('transferNext').addEventListener('click', () => { transferPage += 1; renderTransfers(); });
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
    el('selIgnore').addEventListener('click', () => sendIgnore([...selected]));
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
        transferById = new Map(transfers.map((transfer) => [transfer.id, transfer]));
        queuePaused = message.paused === true;
        if (activeTab === 'transfers') {
          renderTransfers();
        } else {
          transferSummary = { running: 0, queued: 0, held: 0, completed: 0, failed: 0 };
          transfers.forEach((transfer) => { transferSummary[transfer.status] += 1; });
          updateTransferSummary();
        }
      } else if (message.type === 'transfer-patch') {
        (message.items || []).forEach((transfer) => transferById.set(transfer.id, transfer));
        (message.removed || []).forEach((id) => transferById.delete(id));
        transfers = [...transferById.values()].sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
        queuePaused = message.paused === true;
        if (activeTab === 'transfers') {
          renderTransfers();
        } else {
          transferSummary = { running: 0, queued: 0, held: 0, completed: 0, failed: 0 };
          transfers.forEach((transfer) => { transferSummary[transfer.status] += 1; });
          updateTransferSummary();
        }
      } else if (message.type === 'transfer-summary') {
        transferSummary = message.counts || transferSummary;
        queuePaused = message.paused === true;
        updateTransferSummary();
      } else if (message.type === 'compare-data') {
        rows = message.rows || [];
        rowMap = new Map(rows.map((r) => [r.path, r]));
        scanComplete = message.complete !== false && message.truncated !== true;
        scanAvailable = true;
        compareRenderLimit = 750;
        expanded = new Set();
        selected = new Set();
        renderCompare();
      } else if (message.type === 'scan-start' || message.type === 'scan-invalidated') {
        scanComplete = false;
        scanAvailable = false;
        selected = new Set();
        renderCompare();
      } else if (message.type === 'rows-synced') {
        (message.updated || []).forEach((u) => {
          selected.delete(u.path);
          const r = rowMap.get(u.path);
          if (r) {
            r.localMtime = u.localMtime;
            r.remoteMtime = u.remoteMtime;
            r.state = 'synced';
            r.label = 'In sync';
          }
        });
        renderCompare();
      } else if (message.type === 'rows-ignored') {
        const ignored = message.paths || [];
        const matches = (candidate) => ignored.some((path) => candidate === path || candidate.startsWith(path + '/'));
        rows = rows.filter((row) => !matches(row.path));
        rowMap = new Map(rows.map((row) => [row.path, row]));
        selected = new Set([...selected].filter((candidate) => !matches(candidate)));
        renderCompare();
      } else if (message.type === 'scan-status') {
        el('scanStatus').textContent = message.text || '';
        if (message.done) el('scan').disabled = false;
      }
    });
    vscode.postMessage({ type: 'webview-ready' });
  </script>
</body>
</html>`;
  }
}
