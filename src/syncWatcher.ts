import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigService } from './configService';
import { Logger } from './logger';
import { TransferQueue } from './transferQueue';

export class SyncWatcher implements vscode.Disposable {
  private watcher?: vscode.FileSystemWatcher;
  private readonly debounce = new Map<string, NodeJS.Timeout>();

  public constructor(
    private readonly config: ConfigService,
    private readonly queue: TransferQueue,
    private readonly logger: Logger,
    /** Called when a file inside the auto-sync scope is deleted locally. */
    private readonly onLocalDelete: (relativePath: string) => void,
    /**
     * Conflict guard: called before each auto-upload; return false to skip
     * (e.g. the remote copy changed after the local one — don't clobber it).
     */
    private readonly confirmUpload: (relativePath: string, localPath: string, remotePath: string) => Promise<boolean>
  ) {}

  public restart(): void {
    this.disposeWatcher();
    const root = this.config.getLocalRoot();
    if (!root) {
      return;
    }

    if (this.config.getAutoSyncMode() === 'manual') {
      this.logger.append('info', 'Auto-sync is disabled. Choose Sync Root or Sync List to enable it.');
      return;
    }

    if (this.config.getAllowedRoots().length === 0) {
      this.logger.append('info', 'Auto-sync is enabled for the sync list, but the list is empty.');
      return;
    }

    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    this.watcher.onDidCreate((uri) => this.handle(uri));
    this.watcher.onDidChange((uri) => this.handle(uri));
    this.watcher.onDidDelete((uri) => this.handleDelete(uri));
    this.logger.append('info', `Watching ${root.fsPath} for auto-upload changes.`);
  }

  public dispose(): void {
    this.disposeWatcher();
    for (const timeout of this.debounce.values()) {
      clearTimeout(timeout);
    }
    this.debounce.clear();
  }

  private isAllowed(uri: vscode.Uri): boolean {
    const allowedRoots = this.config.getAllowedRoots();
    return allowedRoots.some((rootPath) => uri.fsPath === rootPath || uri.fsPath.startsWith(`${rootPath}${path.sep}`));
  }

  private handle(uri: vscode.Uri): void {
    const relativePath = this.config.toRelativeLocalPath(uri.fsPath);
    if (!relativePath || !this.isAllowed(uri)) {
      return;
    }

    const existing = this.debounce.get(uri.fsPath);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(() => {
      this.debounce.delete(uri.fsPath);
      void (async () => {
        // onDidCreate also fires for new FOLDERS — uploading one as a file
        // creates a bogus zero-byte file on the server that then blocks the
        // real folder from ever being created (553 Not a directory).
        const stat = await fs.stat(uri.fsPath).catch(() => undefined);
        if (!stat || stat.isDirectory()) {
          return;
        }
        const remotePath = this.config.resolveRemotePath(relativePath);
        if (!(await this.confirmUpload(relativePath, uri.fsPath, remotePath))) {
          return;
        }
        await this.queue.enqueueUpload(uri.fsPath, remotePath, 'file');
      })();
    }, 350);

    this.debounce.set(uri.fsPath, timeout);
  }

  private handleDelete(uri: vscode.Uri): void {
    const relativePath = this.config.toRelativeLocalPath(uri.fsPath);
    if (!relativePath || !this.isAllowed(uri)) {
      return;
    }
    // Cancel any pending upload for the now-deleted file.
    const pending = this.debounce.get(uri.fsPath);
    if (pending) {
      clearTimeout(pending);
      this.debounce.delete(uri.fsPath);
    }
    this.onLocalDelete(relativePath);
  }

  private disposeWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }
}
