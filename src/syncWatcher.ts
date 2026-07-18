import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigService } from './configService';
import { Logger } from './logger';
import { TransferQueue } from './transferQueue';

export class SyncWatcher implements vscode.Disposable {
  private watcher?: vscode.FileSystemWatcher;
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private readonly suppressedUntil = new Map<string, number>();
  private readonly activeSuppressions = new Map<string, number>();
  private generation = 0;

  public constructor(
    private readonly config: ConfigService,
    private readonly queue: TransferQueue,
    private readonly logger: Logger,
    /** Called when a file inside the auto-sync scope is deleted locally. */
    private readonly onLocalDelete: (relativePath: string, contextKey: string, remotePath: string) => void,
    /**
     * Conflict guard: called before each auto-upload; return false to skip
     * (e.g. the remote copy changed after the local one — don't clobber it).
     */
    private readonly confirmUpload: (relativePath: string, localPath: string, remotePath: string, contextKey: string) => Promise<boolean>
  ) {}

  public restart(): void {
    this.suspend();
    const root = this.config.getLocalRoot();
    const contextKey = this.config.getOperationContextKey();
    if (!root || !contextKey) {
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

    const generation = this.generation;
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    this.watcher.onDidCreate((uri) => this.handle(uri, generation, contextKey));
    this.watcher.onDidChange((uri) => this.handle(uri, generation, contextKey));
    this.watcher.onDidDelete((uri) => this.handleDelete(uri, generation, contextKey));
    this.logger.append('info', `Watching ${root.fsPath} for auto-upload changes.`);
  }

  /** Invalidate callbacks/debounces from the previous account before switching. */
  public suspend(): void {
    this.generation += 1;
    this.disposeWatcher();
    this.clearPendingDebounces();
  }

  /**
   * Ignore file-system notifications caused by a deliberate metadata-only
   * change. Mark-in-sync uses this before touching a local timestamp so the
   * watcher cannot turn that operation into an unintended content upload.
   */
  public suppressLocalChange(filePath: string, durationMs = 2000): void {
    const key = this.pathKey(filePath);
    const pending = this.debounce.get(key);
    if (pending) {
      clearTimeout(pending);
      this.debounce.delete(key);
    }
    this.suppressedUntil.set(key, Date.now() + durationMs);
  }

  /** Suppress watcher uploads for the full duration of a local download. */
  public beginLocalChangeSuppression(filePath: string): () => void {
    const key = this.pathKey(filePath);
    const pending = this.debounce.get(key);
    if (pending) {
      clearTimeout(pending);
      this.debounce.delete(key);
    }
    this.activeSuppressions.set(key, (this.activeSuppressions.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const remaining = (this.activeSuppressions.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.activeSuppressions.set(key, remaining);
      } else {
        this.activeSuppressions.delete(key);
        this.suppressedUntil.set(key, Date.now() + 2000);
      }
    };
  }

  public dispose(): void {
    this.suspend();
    this.suppressedUntil.clear();
    this.activeSuppressions.clear();
  }

  private isAllowed(uri: vscode.Uri): boolean {
    const allowedRoots = this.config.getAllowedRoots();
    return allowedRoots.some((rootPath) => uri.fsPath === rootPath || uri.fsPath.startsWith(`${rootPath}${path.sep}`));
  }

  private handle(uri: vscode.Uri, generation: number, contextKey: string): void {
    if (generation !== this.generation || this.config.getOperationContextKey() !== contextKey) {
      return;
    }
    if (this.config.isInternalRemoteCachePath(uri.fsPath)) {
      return;
    }
    const relativePath = this.config.toRelativeLocalPath(uri.fsPath);
    if (!relativePath || !this.isAllowed(uri)) {
      return;
    }
    const remotePath = this.config.resolveRemotePath(relativePath);

    const key = this.pathKey(uri.fsPath);
    if (this.activeSuppressions.has(key)) {
      return;
    }
    const suppressedUntil = this.suppressedUntil.get(key);
    if (suppressedUntil !== undefined) {
      if (suppressedUntil >= Date.now()) {
        return;
      }
      this.suppressedUntil.delete(key);
    }

    const existing = this.debounce.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(() => {
      this.debounce.delete(key);
      void (async () => {
        if (generation !== this.generation || this.config.getOperationContextKey() !== contextKey) {
          this.logger.append('info', `Skipped stale auto-upload event for ${relativePath}; the account or sync root changed.`);
          return;
        }
        // onDidCreate also fires for new FOLDERS — uploading one as a file
        // creates a bogus zero-byte file on the server that then blocks the
        // real folder from ever being created (553 Not a directory).
        const safeLocalPath = await this.config.resolveSafeLocalPath(relativePath);
        if (!safeLocalPath) {
          return;
        }
        const stat = await fs.stat(safeLocalPath).catch(() => undefined);
        if (!stat || stat.isDirectory()) {
          return;
        }
        if (!(await this.confirmUpload(relativePath, safeLocalPath, remotePath, contextKey))) {
          return;
        }
        if (generation !== this.generation || this.config.getOperationContextKey() !== contextKey) {
          this.logger.append('info', `Skipped stale auto-upload event for ${relativePath}; the account or sync root changed.`);
          return;
        }
        await this.queue.enqueueUpload(safeLocalPath, remotePath, 'file', contextKey);
      })();
    }, 350);

    this.debounce.set(key, timeout);
  }

  private handleDelete(uri: vscode.Uri, generation: number, contextKey: string): void {
    if (generation !== this.generation || this.config.getOperationContextKey() !== contextKey) {
      return;
    }
    if (this.config.isInternalRemoteCachePath(uri.fsPath)) {
      return;
    }
    const relativePath = this.config.toRelativeLocalPath(uri.fsPath);
    if (!relativePath || !this.isAllowed(uri)) {
      return;
    }
    // Cancel any pending upload for the now-deleted file.
    const key = this.pathKey(uri.fsPath);
    const pending = this.debounce.get(key);
    if (pending) {
      clearTimeout(pending);
      this.debounce.delete(key);
    }
    const suppressedUntil = this.suppressedUntil.get(key);
    if (this.activeSuppressions.has(key) || (suppressedUntil !== undefined && suppressedUntil >= Date.now())) {
      return;
    }
    this.onLocalDelete(relativePath, contextKey, this.config.resolveRemotePath(relativePath));
  }

  private pathKey(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  private disposeWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  private clearPendingDebounces(): void {
    for (const timeout of this.debounce.values()) {
      clearTimeout(timeout);
    }
    this.debounce.clear();
  }
}
