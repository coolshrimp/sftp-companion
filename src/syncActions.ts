import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigService } from './configService';
import { Logger } from './logger';
import { relativeTo } from './pathUtils';
import { SftpService } from './sftpService';
import { TransferQueue } from './transferQueue';
import { LocalNode, RemoteNode } from './types';

export interface SyncTarget {
  relativePath: string;
  localPath: string;
  remotePath: string;
  isDirectory: boolean;
  name: string;
}

type CommandInput = LocalNode | RemoteNode | vscode.Uri | undefined;

export class SyncActions {
  public constructor(
    private readonly config: ConfigService,
    private readonly sftp: SftpService,
    private readonly queue: TransferQueue,
    private readonly logger: Logger,
    private readonly ensureConnected: () => Promise<boolean>
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

    if (input instanceof vscode.Uri) {
      const root = this.config.getLocalRoot();
      if (!root) {
        vscode.window.showWarningMessage('Configure an SFTP account first (open the SFTP Sync panel).');
        return undefined;
      }
      const relativePath = relativeTo(root.fsPath, input.fsPath);
      if (relativePath.startsWith('..')) {
        vscode.window.showWarningMessage('This file is outside the configured sync folder.');
        return undefined;
      }
      let isDirectory = false;
      try {
        isDirectory = (await fs.stat(input.fsPath)).isDirectory();
      } catch {
        // Local file missing; treat as file so remote-only flows still work.
      }
      return {
        relativePath,
        localPath: input.fsPath,
        remotePath: this.config.resolveRemotePath(relativePath),
        isDirectory,
        name: path.basename(input.fsPath)
      };
    }

    if (input.kind === 'local') {
      return {
        relativePath: input.relativePath,
        localPath: input.fullPath,
        remotePath: this.config.resolveRemotePath(input.relativePath),
        isDirectory: input.isDirectory,
        name: path.basename(input.fullPath)
      };
    }

    const localPath = this.config.resolveLocalPath(input.relativePath);
    if (!localPath) {
      vscode.window.showWarningMessage('The selected remote item does not map into the configured sync folder.');
      return undefined;
    }
    return {
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
    if (!target.isDirectory) {
      await this.queue.enqueueUpload(target.localPath, target.remotePath, 'file');
      return;
    }
    const files = await this.collectLocalFiles(target);
    if (files.length === 0) {
      vscode.window.showInformationMessage(`No files to upload in "${target.name}" (empty or fully ignored).`);
      return;
    }
    for (const file of files) {
      await this.queue.enqueueUpload(file.localPath, file.remotePath, 'file');
    }
    this.logger.append('info', `Queued ${files.length} file(s) from folder "${target.relativePath || target.name}" for upload.`);
  }

  private async downloadResolved(target: SyncTarget): Promise<void> {
    if (!target.isDirectory) {
      await this.queue.enqueueDownload(target.remotePath, target.localPath, 'file');
      return;
    }
    if (!(await this.ensureConnected())) {
      return;
    }
    const files = await this.collectRemoteFiles(target);
    if (files.length === 0) {
      vscode.window.showInformationMessage(`No files to download in "${target.name}" (empty or fully ignored).`);
      return;
    }
    for (const file of files) {
      await this.queue.enqueueDownload(file.remotePath, file.localPath, 'file');
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
        const fullPath = path.join(dir, entry.name);
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (ignore.isIgnored(childRelative)) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(fullPath, childRelative, depth + 1);
        } else {
          results.push({ localPath: fullPath, remotePath: this.config.resolveRemotePath(childRelative) });
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
      if (depth > 16 || results.length >= 20000) {
        return;
      }
      const children = await this.sftp.list(remoteDir).catch(() => []);
      for (const child of children) {
        const relative = child.relativePath;
        if (!relative || ignore.isIgnored(relative)) {
          continue;
        }
        if (child.isDirectory) {
          await walk(child.remotePath, depth + 1);
        } else {
          const localPath = this.config.resolveLocalPath(relative);
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
    if (!(await this.ensureConnected())) {
      return;
    }
    await this.compareResolved(target);
  }

  public async smartSync(input: CommandInput): Promise<void> {
    const target = await this.resolveTarget(input);
    if (!target) {
      return;
    }
    if (!(await this.ensureConnected())) {
      return;
    }

    if (target.isDirectory) {
      const pick = await vscode.window.showQuickPick([
        { label: '$(cloud-upload) Upload Folder → Server', action: 'upload' as const, detail: `${target.localPath} → ${target.remotePath}` },
        { label: '$(cloud-download) Download Folder ← Server', action: 'download' as const, detail: `${target.remotePath} → ${target.localPath}` }
      ], { placeHolder: `Sync direction for folder "${target.name}"` });
      if (pick?.action === 'upload') {
        await this.uploadResolved(target);
      } else if (pick?.action === 'download') {
        await this.downloadResolved(target);
      }
      return;
    }

    const remoteStat = await this.sftp.stat(target.remotePath);
    const localStat = await fs.stat(target.localPath).catch(() => undefined);

    if (!remoteStat && !localStat) {
      vscode.window.showInformationMessage(`"${target.name}" does not exist locally or on the server.`);
      return;
    }
    if (!remoteStat) {
      await this.queue.enqueueUpload(target.localPath, target.remotePath, 'file');
      vscode.window.showInformationMessage(`"${target.name}" is missing on the server — uploading.`);
      return;
    }
    if (!localStat) {
      await this.queue.enqueueDownload(target.remotePath, target.localPath, 'file');
      vscode.window.showInformationMessage(`"${target.name}" is missing locally — downloading.`);
      return;
    }

    const sizeKnown = remoteStat.size !== undefined;
    const sizeMatch = !sizeKnown || remoteStat.size === localStat.size;
    const delta = remoteStat.modifiedAt === undefined ? undefined : localStat.mtimeMs - remoteStat.modifiedAt;
    const stampsClose = delta !== undefined && Math.abs(delta) < 2000;
    // Same size with a newer server stamp = an earlier upload that did not
    // preserve timestamps. Treat as in sync but let the user override.
    const uploadedCopy = delta !== undefined && delta < 0 && sizeKnown && sizeMatch;
    if (sizeMatch && (stampsClose || uploadedCopy)) {
      const detail = stampsClose ? 'edit times match' : 'same size — server stamp is just the upload time';
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

    if (pick?.action === 'upload') {
      await this.queue.enqueueUpload(target.localPath, target.remotePath, 'file');
    } else if (pick?.action === 'download') {
      await this.queue.enqueueDownload(target.remotePath, target.localPath, 'file');
    } else if (pick?.action === 'compare') {
      await this.compareResolved(target);
    }
  }

  public async openRemoteForEdit(item?: RemoteNode): Promise<void> {
    if (!item || item.isDirectory) {
      return;
    }
    if (!(await this.ensureConnected())) {
      return;
    }
    const editRoot = this.getCacheRoot('edit');
    if (!editRoot) {
      vscode.window.showWarningMessage('Open a workspace folder before editing remote files.');
      return;
    }
    const relativePath = item.relativePath || path.basename(item.remotePath);
    const cachePath = path.join(editRoot, relativePath);
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await this.sftp.downloadFile(item.remotePath, cachePath);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(cachePath));
    await vscode.window.showTextDocument(document, { preview: false });
    this.logger.append('info', `Editing remote copy of ${item.remotePath} — saving uploads it back to the server.`);
    vscode.window.setStatusBarMessage(`$(cloud) Remote edit: saving "${path.basename(cachePath)}" uploads back to the server.`, 6000);
  }

  public handleSavedDocument(document: vscode.TextDocument): void {
    const editRoot = this.getCacheRoot('edit');
    if (!editRoot || document.uri.scheme !== 'file') {
      return;
    }
    const relativePath = relativeTo(editRoot, document.uri.fsPath);
    if (!relativePath || relativePath.startsWith('..')) {
      return;
    }
    const remotePath = this.config.resolveRemotePath(relativePath);
    void this.queue.enqueueUpload(document.uri.fsPath, remotePath, 'file');
  }

  private async compareResolved(target: SyncTarget): Promise<void> {
    const remoteStat = await this.sftp.stat(target.remotePath);
    const localStat = await fs.stat(target.localPath).catch(() => undefined);

    if (!remoteStat && !localStat) {
      vscode.window.showInformationMessage(`"${target.name}" does not exist locally or on the server.`);
      return;
    }
    if (!remoteStat) {
      const choice = await vscode.window.showInformationMessage(
        `"${target.name}" does not exist on the server yet.`,
        'Upload Local → Server'
      );
      if (choice) {
        await this.queue.enqueueUpload(target.localPath, target.remotePath, 'file');
      }
      return;
    }
    if (!localStat) {
      const choice = await vscode.window.showInformationMessage(
        `"${target.name}" does not exist locally.`,
        'Download Server → Local'
      );
      if (choice) {
        await this.queue.enqueueDownload(target.remotePath, target.localPath, 'file');
      }
      return;
    }

    const cacheRoot = this.getCacheRoot('compare');
    if (!cacheRoot) {
      vscode.window.showWarningMessage('Open a workspace folder before comparing files.');
      return;
    }
    const cachePath = path.join(cacheRoot, target.relativePath || target.name);
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await this.sftp.downloadFile(target.remotePath, cachePath);

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
    if (choice === 'Upload Local → Server') {
      await this.queue.enqueueUpload(target.localPath, target.remotePath, 'file');
    } else if (choice === 'Download Server → Local') {
      await this.queue.enqueueDownload(target.remotePath, target.localPath, 'file');
    }
  }

  private getCacheRoot(kind: 'compare' | 'edit'): string | undefined {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      return undefined;
    }
    const base = vscode.workspace.getConfiguration('sftpCompanion').get<string>('tempRemoteCachePath', '.vscode/.sftp-companion-cache');
    return path.join(workspace.uri.fsPath, base, kind);
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
