import * as vscode from 'vscode';
import { QueueItem } from './types';

type QueueTask = {
  item: QueueItem;
  run: (signal: AbortSignal) => Promise<void>;
  contextKey?: string;
};

type SftpOperations = {
  uploadFile(localPath: string, remotePath: string, onProgress?: (transferred: number, total?: number) => void, signal?: AbortSignal): Promise<void>;
  uploadFolder(localPath: string, remotePath: string): Promise<void>;
  downloadFile(remotePath: string, localPath: string, onProgress?: (transferred: number, total?: number) => void, signal?: AbortSignal): Promise<void>;
  downloadFolder(remotePath: string, localPath: string): Promise<void>;
};

type Logger = { append(level: 'info' | 'warn' | 'error', message: string): void };

export class TransferQueue {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly completeEmitter = new vscode.EventEmitter<QueueItem>();
  private readonly pending: QueueTask[] = [];
  private readonly transferItems: QueueItem[] = [];
  private readonly itemContextKeys = new Map<string, string>();
  private readonly approvedInternalCacheUploads = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private running = 0;
  private transferring = 0;
  private pausedAll = false;
  private contentRevision = 0;
  private contextChangeHolds = 0;
  private readonly transferIdleWaiters: Array<() => void> = [];

  public readonly onDidChange = this.changeEmitter.event;
  /** Fires once per successfully finished transfer. */
  public readonly onDidComplete = this.completeEmitter.event;

  public constructor(
    private readonly sftp: SftpOperations,
    private readonly logger: Logger,
    private concurrency: number,
    private readonly beforeRun?: () => Promise<void>,
    private readonly getContextKey?: () => string | undefined,
    private readonly validateLocalPath?: (localPath: string, requireInsideRoot: boolean) => Promise<boolean>,
    private readonly beginLocalWriteSuppression?: (localPath: string) => () => void,
    private readonly isInternalRemoteCachePath?: (localPath: string) => boolean
  ) {}

  /** Applies immediately — newly freed slots pick up queued items. */
  public setConcurrency(count: number): void {
    this.concurrency = Math.max(1, Math.min(10, Math.floor(count)));
    void this.process();
  }

  public get items(): readonly QueueItem[] {
    return this.transferItems;
  }

  public get paused(): boolean {
    return this.pausedAll;
  }

  /** Monotonic revision for transfers that can change local/server content. */
  public get revision(): number {
    return this.contentRevision;
  }

  /** Stop active work and keep pending tasks held while the account changes. */
  public async holdForContextChange(): Promise<() => void> {
    this.contextChangeHolds += 1;
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.changeEmitter.fire();
    if (this.transferring > 0) {
      await new Promise<void>((resolve) => this.transferIdleWaiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.contextChangeHolds = Math.max(0, this.contextChangeHolds - 1);
      if (this.contextChangeHolds === 0) {
        void this.process();
      }
    };
  }

  public pauseAll(): void {
    this.pausedAll = true;
    this.changeEmitter.fire();
  }

  public resumeAll(): void {
    this.pausedAll = false;
    this.changeEmitter.fire();
    void this.process();
  }

  public pauseItem(id: string): void {
    const item = this.transferItems.find((entry) => entry.id === id);
    if (item?.status === 'queued') {
      item.status = 'held';
      item.message = 'Paused';
      this.changeEmitter.fire();
    }
  }

  public resumeItem(id: string): void {
    const item = this.transferItems.find((entry) => entry.id === id);
    if (item?.status === 'held') {
      item.status = 'queued';
      item.message = 'Waiting';
      this.changeEmitter.fire();
      void this.process();
    }
  }

  /** Abort a running transfer mid-flight. */
  public stopItem(id: string): void {
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      this.logger.append('info', 'Stop requested for a running transfer.');
    }
  }

  public async enqueueUpload(
    localPath: string,
    remotePath: string,
    type: 'file' | 'folder',
    expectedContextKey?: string,
    allowInternalRemoteEditCache = false
  ): Promise<void> {
    // Hard block, independent of user-editable ignore patterns: the SFTP
    // config files hold credentials, and a .json file uploaded into a web
    // root is served as plain text — they must never leave this machine.
    const normalizedLocalPath = localPath.replace(/\\/g, '/');
    const internalRemoteEditCache = this.isInternalRemoteCachePath?.(localPath)
      ?? /\/\.vscode\/\.sftp-companion-cache\//i.test(normalizedLocalPath);
    if (internalRemoteEditCache && !allowInternalRemoteEditCache) {
      this.logger.append('warn', `Blocked upload of ${localPath} — internal compare/edit cache files only upload through their originating Remote Edit tab.`);
      return;
    }
    if (/\/\.vscode(?:\/|$)/i.test(normalizedLocalPath)
      && !(allowInternalRemoteEditCache && internalRemoteEditCache)) {
      this.logger.append('warn', `Blocked upload of ${localPath} — the .vscode folder is local-only and never uploads.`);
      return;
    }
    if (expectedContextKey && expectedContextKey !== this.getContextKey?.()) {
      this.logger.append('warn', `Skipped stale upload event for ${localPath}; the active account or sync root changed.`);
      return;
    }
    const item = this.makeItem('upload', type, localPath, remotePath, 'Queued for upload');
    if (allowInternalRemoteEditCache && internalRemoteEditCache) {
      this.approvedInternalCacheUploads.add(item.id);
    }
    this.enqueue(item, async (signal) => {
      if (type === 'folder') {
        await this.sftp.uploadFolder(localPath, remotePath);
      } else {
        await this.sftp.uploadFile(localPath, remotePath, this.progressReporter(item), signal);
      }
    }, expectedContextKey);
  }

  public async enqueueDownload(remotePath: string, localPath: string, type: 'file' | 'folder', expectedContextKey?: string): Promise<void> {
    if (expectedContextKey && expectedContextKey !== this.getContextKey?.()) {
      this.logger.append('warn', `Skipped stale download request for ${remotePath}; the active account or sync root changed.`);
      return;
    }
    const item = this.makeItem('download', type, localPath, remotePath, 'Queued for download');
    this.enqueue(item, async (signal) => {
      const releaseSuppression = this.beginLocalWriteSuppression?.(localPath);
      try {
        if (type === 'folder') {
          await this.sftp.downloadFolder(remotePath, localPath);
        } else {
          await this.sftp.downloadFile(remotePath, localPath, this.progressReporter(item), signal);
        }
      } finally {
        releaseSuppression?.();
      }
    }, expectedContextKey);
  }

  public async retry(id: string): Promise<void> {
    const existing = this.transferItems.find((item) => item.id === id);
    if (!existing) {
      return;
    }
    const expectedContext = this.itemContextKeys.get(id);
    const allowInternalRemoteEditCache = this.approvedInternalCacheUploads.has(id);
    if (this.getContextKey && (!expectedContext || expectedContext !== this.getContextKey())) {
      throw new Error('This transfer belongs to a different account or sync root and cannot be retried. Queue it again from the current file tree.');
    }
    if (existing.direction === 'upload') {
      await this.enqueueUpload(existing.localPath, existing.remotePath, existing.type, expectedContext, allowInternalRemoteEditCache);
    } else {
      await this.enqueueDownload(existing.remotePath, existing.localPath, existing.type, expectedContext);
    }
  }

  public remove(id: string): void {
    const index = this.transferItems.findIndex((item) => item.id === id);
    if (index < 0 || this.transferItems[index].status === 'running') {
      return;
    }
    const pendingIndex = this.pending.findIndex((task) => task.item.id === id);
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
    }
    this.itemContextKeys.delete(id);
    this.approvedInternalCacheUploads.delete(id);
    this.transferItems.splice(index, 1);
    this.changeEmitter.fire();
  }

  public clearCompleted(): void {
    for (const item of this.transferItems) {
      if (item.status === 'completed') {
        this.itemContextKeys.delete(item.id);
        this.approvedInternalCacheUploads.delete(item.id);
      }
    }
    const retained = this.transferItems.filter((item) => item.status !== 'completed');
    this.transferItems.length = 0;
    this.transferItems.push(...retained);
    this.changeEmitter.fire();
  }

  private makeItem(
    direction: QueueItem['direction'],
    type: QueueItem['type'],
    localPath: string,
    remotePath: string,
    message: string
  ): QueueItem {
    return {
      id: this.makeId(),
      direction,
      type,
      localPath,
      remotePath,
      status: 'queued',
      attempts: 0,
      message,
      createdAt: Date.now()
    };
  }

  /** Throttled per-item progress callback wired into file transfers. */
  private progressReporter(item: QueueItem): (transferred: number, total?: number) => void {
    let lastFire = 0;
    return (transferred, total) => {
      item.transferred = transferred;
      item.total = total ?? item.total;
      const now = Date.now();
      if (now - lastFire > 250) {
        lastFire = now;
        item.message = item.total
          ? `${Math.min(100, Math.round((transferred / item.total) * 100))}% of ${formatBytes(item.total)}`
          : `${formatBytes(transferred)} transferred`;
        this.changeEmitter.fire();
      }
    };
  }

  private enqueue(item: QueueItem, run: (signal: AbortSignal) => Promise<void>, expectedContextKey?: string): void {
    const contextKey = expectedContextKey ?? this.getContextKey?.();
    this.contentRevision += 1;
    this.transferItems.unshift(item);
    if (contextKey) {
      this.itemContextKeys.set(item.id, contextKey);
    }
    this.pending.push({ item, run, contextKey });
    this.changeEmitter.fire();
    void this.process();
  }

  private async process(): Promise<void> {
    while (!this.pausedAll && this.contextChangeHolds === 0 && this.running < this.concurrency) {
      // Held items stay in pending but are skipped until resumed.
      const index = this.pending.findIndex((task) => task.item.status === 'queued');
      if (index < 0) {
        return;
      }
      const [task] = this.pending.splice(index, 1);
      if (!this.isTaskContextCurrent(task)) {
        this.contentRevision += 1;
        task.item.status = 'failed';
        task.item.message = 'Account changed before transfer';
        task.item.error = 'Transfer was not started because its account, remote root, or local sync root changed after it was queued.';
        this.logger.append('warn', `${task.item.direction} cancelled after account change: ${task.item.remotePath}`);
        this.changeEmitter.fire();
        continue;
      }
      this.running += 1;
      task.item.status = 'running';
      task.item.attempts += 1;
      task.item.message = 'Transfer in progress';
      const controller = new AbortController();
      this.controllers.set(task.item.id, controller);
      this.changeEmitter.fire();
      void (async () => {
        if (this.beforeRun) {
          await this.beforeRun();
        }
        if (!this.isTaskContextCurrent(task)) {
          throw new Error('Account or sync root changed while preparing this transfer; nothing was transferred.');
        }
        if (this.validateLocalPath && !(await this.validateLocalPath(task.item.localPath, task.item.direction === 'download'))) {
          throw new Error('Local transfer path is no longer safe; a parent may have become a symbolic link or junction.');
        }
        if (this.contextChangeHolds > 0 || !this.isTaskContextCurrent(task) || controller.signal.aborted) {
          throw new Error('Transfer cancelled because the connection context changed before it started.');
        }
        this.transferring += 1;
        try {
          await task.run(controller.signal);
        } finally {
          this.transferring -= 1;
          if (this.transferring === 0) {
            this.transferIdleWaiters.splice(0).forEach((resolve) => resolve());
          }
        }
      })()
        .then(() => {
          this.contentRevision += 1;
          task.item.status = 'completed';
          task.item.completedAt = Date.now();
          task.item.message = `Transfer completed at ${new Date(task.item.completedAt).toLocaleTimeString()}`;
          if (task.item.total !== undefined) {
            task.item.transferred = task.item.total;
          }
          this.logger.append('info', `${task.item.direction} completed: ${task.item.remotePath}`);
          this.completeEmitter.fire(task.item);
        })
        .catch((error: unknown) => {
          this.contentRevision += 1;
          task.item.status = 'failed';
          if (controller.signal.aborted) {
            task.item.message = 'Stopped by user';
            task.item.error = 'Stopped before completion — the partial remote/local file may need cleanup.';
            this.logger.append('warn', `${task.item.direction} stopped: ${task.item.remotePath}`);
          } else {
            task.item.message = 'Transfer failed';
            task.item.error = error instanceof Error ? error.message : String(error);
            this.logger.append('error', `${task.item.direction} failed: ${task.item.remotePath} (${task.item.error})`);
          }
        })
        .finally(() => {
          this.controllers.delete(task.item.id);
          this.running -= 1;
          this.changeEmitter.fire();
          void this.process();
        });
    }
  }

  private makeId(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private isTaskContextCurrent(task: QueueTask): boolean {
    if (!this.getContextKey) {
      return true;
    }
    const current = this.getContextKey();
    return Boolean(task.contextKey) && task.contextKey === current;
  }
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}
