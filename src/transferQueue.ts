import * as vscode from 'vscode';
import { QueueItem } from './types';

type QueueTask = {
  item: QueueItem;
  run: (signal: AbortSignal) => Promise<void>;
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
  private readonly controllers = new Map<string, AbortController>();
  private running = 0;
  private pausedAll = false;

  public readonly onDidChange = this.changeEmitter.event;
  /** Fires once per successfully finished transfer. */
  public readonly onDidComplete = this.completeEmitter.event;

  public constructor(
    private readonly sftp: SftpOperations,
    private readonly logger: Logger,
    private concurrency: number,
    private readonly beforeRun?: () => Promise<void>
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

  public async enqueueUpload(localPath: string, remotePath: string, type: 'file' | 'folder'): Promise<void> {
    // Hard block, independent of user-editable ignore patterns: the SFTP
    // config files hold credentials, and a .json file uploaded into a web
    // root is served as plain text — they must never leave this machine.
    if (/[\\/]\.vscode[\\/]sftp(-companion)?\.json$/i.test(localPath)) {
      this.logger.append('warn', `Blocked upload of ${localPath} — SFTP config files contain credentials and never upload.`);
      return;
    }
    const item = this.makeItem('upload', type, localPath, remotePath, 'Queued for upload');
    this.enqueue(item, async (signal) => {
      if (type === 'folder') {
        await this.sftp.uploadFolder(localPath, remotePath);
      } else {
        await this.sftp.uploadFile(localPath, remotePath, this.progressReporter(item), signal);
      }
    });
  }

  public async enqueueDownload(remotePath: string, localPath: string, type: 'file' | 'folder'): Promise<void> {
    const item = this.makeItem('download', type, localPath, remotePath, 'Queued for download');
    this.enqueue(item, async (signal) => {
      if (type === 'folder') {
        await this.sftp.downloadFolder(remotePath, localPath);
      } else {
        await this.sftp.downloadFile(remotePath, localPath, this.progressReporter(item), signal);
      }
    });
  }

  public async retry(id: string): Promise<void> {
    const existing = this.transferItems.find((item) => item.id === id);
    if (!existing) {
      return;
    }
    if (existing.direction === 'upload') {
      await this.enqueueUpload(existing.localPath, existing.remotePath, existing.type);
    } else {
      await this.enqueueDownload(existing.remotePath, existing.localPath, existing.type);
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
    this.transferItems.splice(index, 1);
    this.changeEmitter.fire();
  }

  public clearCompleted(): void {
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

  private enqueue(item: QueueItem, run: (signal: AbortSignal) => Promise<void>): void {
    this.transferItems.unshift(item);
    this.pending.push({ item, run });
    this.changeEmitter.fire();
    void this.process();
  }

  private async process(): Promise<void> {
    while (!this.pausedAll && this.running < this.concurrency) {
      // Held items stay in pending but are skipped until resumed.
      const index = this.pending.findIndex((task) => task.item.status === 'queued');
      if (index < 0) {
        return;
      }
      const [task] = this.pending.splice(index, 1);
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
        await task.run(controller.signal);
      })()
        .then(() => {
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
