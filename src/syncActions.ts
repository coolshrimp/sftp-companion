import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigService } from './configService';
import { Logger } from './logger';
import { joinRemote, normalizeRelative, relativeTo } from './pathUtils';
import { SftpService } from './sftpService';
import { TransferQueue } from './transferQueue';
import { LocalNode, RemoteNode } from './types';

export interface SyncTarget {
  contextKey: string;
  localRoot: string;
  remoteRoot: string;
  relativePath: string;
  localPath: string;
  remotePath: string;
  isDirectory: boolean;
  name: string;
}

type CommandInput = LocalNode | RemoteNode | vscode.Uri | undefined;
type StableRemoteOperation = <T>(expectedContextKey: string, operation: () => Promise<T>) => Promise<T>;

function safeRelativePath(value: string): string | undefined {
  const posix = value.replace(/\\/g, '/');
  if (!posix || path.posix.isAbsolute(posix) || path.win32.isAbsolute(value) || posix.split('/').includes('..')) {
    return undefined;
  }
  return normalizeRelative(posix);
}

export class SyncActions {
  /** Remote edit cache files stay bound to the account/path they came from. */
  private readonly remoteEditOrigins = new Map<string, { contextKey: string; remotePath: string }>();

  public constructor(
    private readonly config: ConfigService,
    private readonly sftp: SftpService,
    private readonly queue: TransferQueue,
    private readonly logger: Logger,
    private readonly runRemoteOperation: StableRemoteOperation
  ) {}

  public async resolveTarget(input: CommandInput): Promise<SyncTarget | undefined> {
    if (!input) {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active?.scheme === 'file') {
        input = active;
      } else {
        vscode.window.showWarningMessage('Select a file in the SFTP tree or Explorer first.');
        return undefined;
      }
    }

    const loaded = this.config.getCurrentProfile();
    const root = this.config.getLocalRoot();
    const contextKey = this.config.getOperationContextKey();
    if (!loaded || !root || !contextKey) {
      vscode.window.showWarningMessage('Configure an SFTP account first (open the SFTP Sync panel).');
      return undefined;
    }
    const targetContext = {
      contextKey,
      localRoot: root.fsPath,
      remoteRoot: loaded.profile.remotePath || '/'
    };

    if (input instanceof vscode.Uri) {
      const relativePath = relativeTo(root.fsPath, input.fsPath);
      if (relativePath.startsWith('..')) {
        vscode.window.showWarningMessage('This file is outside the configured sync folder.');
        return undefined;
      }
      const safeLocalPath = await this.config.resolveSafeLocalPath(relativePath);
      if (!safeLocalPath) {
        vscode.window.showWarningMessage('This path leaves the canonical sync root through a symbolic link or junction.');
        return undefined;
      }
      if (!this.isContextCurrent(contextKey)) {
        this.showStaleContextWarning();
        return undefined;
      }
      let isDirectory = false;
      try {
        isDirectory = (await fs.stat(safeLocalPath)).isDirectory();
      } catch {
        // Local file missing; treat as file so remote-only flows still work.
      }
      return {
        ...targetContext,
        relativePath,
        localPath: safeLocalPath,
        remotePath: joinRemote(targetContext.remoteRoot, relativePath),
        isDirectory,
        name: path.basename(input.fsPath)
      };
    }

    if (input.kind === 'local') {
      if (input.contextKey !== contextKey) {
        this.showStaleContextWarning();
        return undefined;
      }
      const safeLocalPath = await this.config.resolveSafeLocalPath(input.relativePath);
      if (!safeLocalPath || this.pathKey(safeLocalPath) !== this.pathKey(input.fullPath)) {
        vscode.window.showWarningMessage('This path leaves the canonical sync root through a symbolic link or junction.');
        return undefined;
      }
      if (!this.isContextCurrent(contextKey)) {
        this.showStaleContextWarning();
        return undefined;
      }
      return {
        ...targetContext,
        relativePath: input.relativePath,
        localPath: safeLocalPath,
        remotePath: joinRemote(targetContext.remoteRoot, input.relativePath),
        isDirectory: input.isDirectory,
        name: path.basename(input.fullPath)
      };
    }

    if (input.contextKey !== contextKey
      || joinRemote(input.remotePath) !== joinRemote(targetContext.remoteRoot, input.relativePath)) {
      this.showStaleContextWarning();
      return undefined;
    }
    const localPath = await this.config.resolveSafeLocalPath(input.relativePath);
    if (!localPath) {
      vscode.window.showWarningMessage('The selected remote item does not map into the configured sync folder.');
      return undefined;
    }
    if (!this.isContextCurrent(contextKey)) {
      this.showStaleContextWarning();
      return undefined;
    }
    return {
      ...targetContext,
      relativePath: input.relativePath,
      localPath,
      remotePath: input.remotePath,
      isDirectory: input.isDirectory,
      name: path.basename(input.remotePath)
    };
  }

  public async upload(input: CommandInput): Promise<void> {
    const target = await this.resolveTarget(input);
    if (!target) {
      return;
    }
    await this.uploadResolved(target);
  }

  public async download(input: CommandInput): Promise<void> {
    const target = await this.resolveTarget(input);
    if (!target) {
      return;
    }
    await this.downloadResolved(target);
  }

  /**
   * Folders are expanded into individual file transfers so the queue shows
   * every file with its own progress, pause, and retry controls.
   */
  private async uploadResolved(target: SyncTarget): Promise<void> {
    if (!this.isContextCurrent(target.contextKey)) {
      this.showStaleContextWarning();
      return;
    }
    if (!target.isDirectory) {
      await this.queue.enqueueUpload(target.localPath, target.remotePath, 'file', target.contextKey);
      return;
    }
    let files: Array<{ localPath: string; remotePath: string }>;
    try {
      files = await this.collectLocalFiles(target);
    } catch (error) {
      this.showRemoteOperationError('Could not inspect the local folder', error);
      return;
    }
    if (!this.isContextCurrent(target.contextKey)) {
      this.showStaleContextWarning();
      return;
    }
    if (files.length === 0) {
      vscode.window.showInformationMessage(`No files to upload in "${target.name}" (empty or fully ignored).`);
      return;
    }
    for (const file of files) {
      await this.queue.enqueueUpload(file.localPath, file.remotePath, 'file', target.contextKey);
    }
    this.logger.append('info', `Queued ${files.length} file(s) from folder "${target.relativePath || target.name}" for upload.`);
  }

  private async downloadResolved(target: SyncTarget): Promise<void> {
    if (!this.isContextCurrent(target.contextKey)) {
      this.showStaleContextWarning();
      return;
    }
    if (!target.isDirectory) {
      await this.queue.enqueueDownload(target.remotePath, target.localPath, 'file', target.contextKey);
      return;
    }
    let files: Array<{ remotePath: string; localPath: string }>;
    try {
      files = await this.runRemoteOperation(target.contextKey, () => this.collectRemoteFiles(target));
    } catch (error) {
      this.showRemoteOperationError('Could not inspect the server folder', error);
      return;
    }
    if (!this.isContextCurrent(target.contextKey)) {
      this.showStaleContextWarning();
      return;
    }
    if (files.length === 0) {
      vscode.window.showInformationMessage(`No files to download in "${target.name}" (empty or fully ignored).`);
      return;
    }
    for (const file of files) {
      await this.queue.enqueueDownload(file.remotePath, file.localPath, 'file', target.contextKey);
    }
    this.logger.append('info', `Queued ${files.length} file(s) from folder "${target.relativePath || target.name}" for download.`);
  }

  private async collectLocalFiles(target: SyncTarget): Promise<Array<{ localPath: string; remotePath: string }>> {
    const results: Array<{ localPath: string; remotePath: string }> = [];
    const ignore = this.config.getIgnoreMatcher();
    const walk = async (dir: string, relative: string, depth: number): Promise<void> => {
      if (depth > 16 || results.length >= 20000) {
        return;
      }
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!this.isContextCurrent(target.contextKey)) {
          throw new Error('The account or sync root changed while the folder was being inspected.');
        }
        const fullPath = path.join(dir, entry.name);
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (ignore.isIgnored(childRelative)) {
          continue;
        }
        if (entry.isSymbolicLink()) {
          this.logger.append('warn', `Skipped linked local path ${fullPath}; linked paths cannot be safely synchronized.`);
          continue;
        }
        const safeLocalPath = await this.config.resolveSafeLocalPath(childRelative);
        if (!safeLocalPath) {
          this.logger.append('warn', `Skipped unsafe local path ${fullPath}.`);
          continue;
        }
        if (entry.isDirectory()) {
          await walk(safeLocalPath, childRelative, depth + 1);
        } else {
          results.push({ localPath: safeLocalPath, remotePath: joinRemote(target.remoteRoot, childRelative) });
        }
      }
    };
    await walk(target.localPath, target.relativePath, 0);
    return results;
  }

  private async collectRemoteFiles(target: SyncTarget): Promise<Array<{ remotePath: string; localPath: string }>> {
    const results: Array<{ remotePath: string; localPath: string }> = [];
    const ignore = this.config.getIgnoreMatcher();
    const walk = async (remoteDir: string, depth: number): Promise<void> => {
      if (!this.isContextCurrent(target.contextKey)) {
        throw new Error('The account or sync root changed while the server folder was being inspected.');
      }
      if (depth > 16 || results.length >= 20000) {
        return;
      }
      const children = await this.sftp.list(remoteDir);
      for (const child of children) {
        if (!this.isContextCurrent(target.contextKey)) {
          throw new Error('The account or sync root changed while the server folder was being inspected.');
        }
        const relative = child.relativePath;
        if (!relative || ignore.isIgnored(relative)) {
          continue;
        }
        if (child.isDirectory) {
          await walk(child.remotePath, depth + 1);
        } else {
          const localPath = await this.config.resolveSafeLocalPath(relative);
          if (localPath) {
            results.push({ remotePath: child.remotePath, localPath });
          }
        }
      }
    };
    await walk(target.remotePath, 0);
    return results;
  }

  public async compare(input: CommandInput): Promise<void> {
    const target = await this.resolveTarget(input);
    if (!target) {
      return;
    }
    if (target.isDirectory) {
      vscode.window.showInformationMessage('Compare works on single files. Use Smart Sync on folders.');
      return;
    }
    await this.compareResolved(target);
  }

  public async smartSync(input: CommandInput): Promise<void> {
    const target = await this.resolveTarget(input);
    if (!target) {
      return;
    }
    if (target.isDirectory) {
      const pick = await vscode.window.showQuickPick([
        { label: '$(cloud-upload) Upload Folder → Server', action: 'upload' as const, detail: `${target.localPath} → ${target.remotePath}` },
        { label: '$(cloud-download) Download Folder ← Server', action: 'download' as const, detail: `${target.remotePath} → ${target.localPath}` }
      ], { placeHolder: `Sync direction for folder "${target.name}"` });
      if (!this.isContextCurrent(target.contextKey)) {
        this.showStaleContextWarning();
        return;
      }
      if (pick?.action === 'upload') {
        await this.uploadResolved(target);
      } else if (pick?.action === 'download') {
        await this.downloadResolved(target);
      }
      return;
    }

    let remoteStat;
    try {
      remoteStat = await this.runRemoteOperation(target.contextKey, () => this.sftp.stat(target.remotePath));
    } catch (error) {
      this.showRemoteOperationError('Could not inspect the server file', error);
      return;
    }
    const localStat = await fs.stat(target.localPath).catch(() => undefined);
    if (!this.isContextCurrent(target.contextKey)) {
      this.showStaleContextWarning();
      return;
    }

    if (!remoteStat && !localStat) {
      vscode.window.showInformationMessage(`"${target.name}" does not exist locally or on the server.`);
      return;
    }
    if (!remoteStat) {
      await this.queue.enqueueUpload(target.localPath, target.remotePath, 'file', target.contextKey);
      vscode.window.showInformationMessage(`"${target.name}" is missing on the server — uploading.`);
      return;
    }
    if (!localStat) {
      await this.queue.enqueueDownload(target.remotePath, target.localPath, 'file', target.contextKey);
      vscode.window.showInformationMessage(`"${target.name}" is missing locally — downloading.`);
      return;
    }

    const sizeKnown = remoteStat.size !== undefined;
    const sizeMatch = !sizeKnown || remoteStat.size === localStat.size;
    const delta = remoteStat.modifiedAt === undefined ? undefined : localStat.mtimeMs - remoteStat.modifiedAt;
    const stampsClose = delta !== undefined && Math.abs(delta) < 2000;
    if (sizeMatch && stampsClose) {
      const detail = 'edit times and sizes match';
      const choice = await vscode.window.showInformationMessage(
        `"${target.name}" looks in sync (${detail}).`,
        'Choose Direction Anyway…'
      );
      if (!choice) {
        return;
      }
    }

    const newerSide = delta === undefined ? 'timestamps unavailable' : delta > 0 ? 'local copy is newer' : 'server copy is newer';
    const pick = await vscode.window.showQuickPick([
      {
        label: '$(cloud-upload) Upload Local → Server',
        action: 'upload' as const,
        detail: `Local: ${formatSize(localStat.size)} • ${new Date(localStat.mtimeMs).toLocaleString()}`
      },
      {
        label: '$(cloud-download) Download Server → Local',
        action: 'download' as const,
        detail: `Server: ${formatSize(remoteStat.size)} • ${remoteStat.modifiedAt ? new Date(remoteStat.modifiedAt).toLocaleString() : 'unknown time'}`
      },
      {
        label: '$(diff) Compare Side by Side First',
        action: 'compare' as const,
        detail: 'Open a diff view before deciding which side wins.'
      }
    ], { placeHolder: `"${target.name}" differs (${newerSide}). What do you want to do?` });

    if (!this.isContextCurrent(target.contextKey)) {
      this.showStaleContextWarning();
      return;
    }

    if (pick?.action === 'upload') {
      await this.queue.enqueueUpload(target.localPath, target.remotePath, 'file', target.contextKey);
    } else if (pick?.action === 'download') {
      await this.queue.enqueueDownload(target.remotePath, target.localPath, 'file', target.contextKey);
    } else if (pick?.action === 'compare') {
      await this.compareResolved(target);
    }
  }

  public async openRemoteForEdit(item?: RemoteNode): Promise<void> {
    if (!item || item.isDirectory) {
      return;
    }
    const contextKey = this.config.getOperationContextKey();
    if (!contextKey || item.contextKey !== contextKey) {
      this.showStaleContextWarning();
      return;
    }
    const relativePath = safeRelativePath(item.relativePath || path.basename(item.remotePath));
    if (!relativePath) {
      vscode.window.showWarningMessage('The remote path cannot be mapped safely into the edit cache.');
      return;
    }
    const cachePath = await this.getCachePath('edit', contextKey, relativePath);
    if (!cachePath) {
      vscode.window.showWarningMessage('The remote edit cache is outside the workspace or passes through an unsafe link.');
      return;
    }
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const revalidatedCachePath = await this.getCachePath('edit', contextKey, relativePath);
    if (!revalidatedCachePath || this.pathKey(revalidatedCachePath) !== this.pathKey(cachePath)) {
      vscode.window.showWarningMessage('The remote edit cache path changed or became unsafe.');
      return;
    }
    try {
      await this.runRemoteOperation(contextKey, () => this.sftp.downloadFile(item.remotePath, cachePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.append('error', `Could not open remote file for editing: ${item.remotePath} (${message})`);
      vscode.window.showErrorMessage(`Could not open remote file for editing: ${message}`);
      return;
    }
    this.remoteEditOrigins.set(this.pathKey(cachePath), { contextKey, remotePath: item.remotePath });
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(cachePath));
    await vscode.window.showTextDocument(document, { preview: false });
    this.logger.append('info', `Editing remote copy of ${item.remotePath} — saving uploads it back to the server.`);
    vscode.window.setStatusBarMessage(`$(cloud) Remote edit: saving "${path.basename(cachePath)}" uploads back to the server.`, 6000);
  }

  public handleSavedDocument(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file') {
      return;
    }
    const origin = this.remoteEditOrigins.get(this.pathKey(document.uri.fsPath));
    if (!origin) {
      return;
    }
    if (this.config.getOperationContextKey() !== origin.contextKey) {
      this.logger.append('warn', `Skipped remote-edit upload for ${origin.remotePath}; its originating account or sync root is no longer active.`);
      vscode.window.showWarningMessage('This remote-edit tab belongs to a different SFTP account or sync root. Switch back to that account before saving it to the server.');
      return;
    }
    void this.queue.enqueueUpload(document.uri.fsPath, origin.remotePath, 'file', origin.contextKey, true);
  }

  private async compareResolved(target: SyncTarget): Promise<void> {
    let remoteStat;
    try {
      remoteStat = await this.runRemoteOperation(target.contextKey, () => this.sftp.stat(target.remotePath));
    } catch (error) {
      this.showRemoteOperationError('Could not inspect the server file', error);
      return;
    }
    const localStat = await fs.stat(target.localPath).catch(() => undefined);
    if (!this.isContextCurrent(target.contextKey)) {
      this.showStaleContextWarning();
      return;
    }

    if (!remoteStat && !localStat) {
      vscode.window.showInformationMessage(`"${target.name}" does not exist locally or on the server.`);
      return;
    }
    if (!remoteStat) {
      const choice = await vscode.window.showInformationMessage(
        `"${target.name}" does not exist on the server yet.`,
        'Upload Local → Server'
      );
      if (choice && this.isContextCurrent(target.contextKey)) {
        await this.queue.enqueueUpload(target.localPath, target.remotePath, 'file', target.contextKey);
      }
      return;
    }
    if (!localStat) {
      const choice = await vscode.window.showInformationMessage(
        `"${target.name}" does not exist locally.`,
        'Download Server → Local'
      );
      if (choice && this.isContextCurrent(target.contextKey)) {
        await this.queue.enqueueDownload(target.remotePath, target.localPath, 'file', target.contextKey);
      }
      return;
    }

    const cacheRelative = safeRelativePath(target.relativePath || target.name);
    if (!cacheRelative) {
      vscode.window.showWarningMessage('The remote path cannot be mapped safely into the compare cache.');
      return;
    }
    const cachePath = await this.getCachePath('compare', target.contextKey, cacheRelative);
    if (!cachePath) {
      vscode.window.showWarningMessage('The compare cache is outside the workspace or passes through an unsafe link.');
      return;
    }
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const revalidatedCachePath = await this.getCachePath('compare', target.contextKey, cacheRelative);
    if (!revalidatedCachePath || this.pathKey(revalidatedCachePath) !== this.pathKey(cachePath)) {
      vscode.window.showWarningMessage('The compare cache path changed or became unsafe.');
      return;
    }
    try {
      await this.runRemoteOperation(target.contextKey, () => this.sftp.downloadFile(target.remotePath, cachePath));
    } catch (error) {
      this.showRemoteOperationError('Could not download the server copy for comparison', error);
      return;
    }

    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(target.localPath),
      vscode.Uri.file(cachePath),
      `${target.name}: Local ↔ Remote`
    );

    const choice = await vscode.window.showInformationMessage(
      `Reviewed the diff for "${target.name}". Which side should win?`,
      'Upload Local → Server',
      'Download Server → Local'
    );
    if (!this.isContextCurrent(target.contextKey)) {
      this.showStaleContextWarning();
      return;
    }
    if (choice === 'Upload Local → Server') {
      await this.queue.enqueueUpload(target.localPath, target.remotePath, 'file', target.contextKey);
    } else if (choice === 'Download Server → Local') {
      await this.queue.enqueueDownload(target.remotePath, target.localPath, 'file', target.contextKey);
    }
  }

  private getCachePath(kind: 'compare' | 'edit', contextKey: string, relativePath: string): Promise<string | undefined> {
    const base = vscode.workspace.getConfiguration('sftpCompanion').get<string>('tempRemoteCachePath', '.vscode/.sftp-companion-cache');
    return this.config.resolveSafeWorkspacePath(path.join(base, kind, this.contextNamespace(contextKey), relativePath));
  }

  private pathKey(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  private contextNamespace(contextKey: string): string {
    return createHash('sha256').update(contextKey).digest('hex').slice(0, 16);
  }

  private isContextCurrent(contextKey: string): boolean {
    return this.config.getOperationContextKey() === contextKey;
  }

  private showStaleContextWarning(): void {
    vscode.window.showWarningMessage('The SFTP account or sync root changed. Choose the item again from the refreshed tree.');
  }

  private showRemoteOperationError(action: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.append('error', `${action}: ${message}`);
    vscode.window.showErrorMessage(`${action}: ${message}`);
  }
}

function formatSize(size?: number): string {
  if (size === undefined) {
    return 'unknown size';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}
