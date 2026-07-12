import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigService } from './configService';
import { Logger } from './logger';
import { relativeTo } from './pathUtils';
import { SftpService } from './sftpService';
import { SyncDecorationProvider } from './syncDecorations';
import { LocalNode, QueueItem, RemoteNode, RemoteStat, SyncState } from './types';

const GREEN = new vscode.ThemeColor('testing.iconPassed');
const YELLOW = new vscode.ThemeColor('charts.yellow');
const RED = new vscode.ThemeColor('testing.iconFailed');
const BLUE = new vscode.ThemeColor('gitDecoration.modifiedResourceForeground');
const ORANGE = new vscode.ThemeColor('charts.orange');
const PURPLE = new vscode.ThemeColor('charts.purple');

class ButtonItem extends vscode.TreeItem {
  public constructor(label: string, command: string, icon: vscode.ThemeIcon, tooltip: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = { command, title: label };
    this.iconPath = icon;
    this.tooltip = tooltip;
    this.description = description;
  }
}

export class MainTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(
    private readonly config: ConfigService,
    private readonly sftp: SftpService
  ) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) {
      return [];
    }

    const profile = this.config.getCurrentProfile()?.profile;
    const autoSyncMode = profile?.autoSyncMode ?? 'manual';
    const syncDescription = autoSyncMode === 'manual'
      ? 'Manual only'
      : autoSyncMode === 'root'
        ? 'Everything'
        : profile && profile.whitelist.length > 0
          ? `${profile.whitelist.length} item(s) on sync list`
          : 'Sync list is empty';

    const connected = this.sftp.connected;

    // Compact rows: status lives in the colored icon + description, and the
    // secondary actions (test, edit json, …) are inline hover buttons declared
    // in package.json (view/item/context, group "inline") — not extra rows.
    const connection = new ButtonItem(
      profile ? profile.host : 'No account yet',
      connected ? 'sftpCompanion.disconnect' : 'sftpCompanion.connect',
      new vscode.ThemeIcon('circle-filled', connected ? GREEN : RED),
      connected
        ? 'Connected — click to disconnect. Hover buttons: test connection, disconnect.'
        : 'Disconnected — click to connect. Hover buttons: connect, test connection.',
      connected ? 'Connected' : 'Disconnected'
    );
    connection.contextValue = connected ? 'main-connection-on' : 'main-connection-off';

    const activeProfileName = this.config.getActiveProfileName();
    const account = new ButtonItem(
      'Account',
      'sftpCompanion.accounts.open',
      new vscode.ThemeIcon('account', PURPLE),
      'Open the account manager. Hover buttons: edit sftp.json, rewrite sftp.json, switch server profile.',
      profile
        ? [activeProfileName ? `[${activeProfileName}]` : undefined, profile.username, profile.protocol === 'ftp' ? (profile.secure ? 'FTPS' : 'FTP') : 'SFTP'].filter(Boolean).join(' • ')
        : 'Set up your server'
    );
    account.contextValue = 'main-account';

    const autoSync = new ButtonItem(
      'Auto Sync',
      'sftpCompanion.setAutoSyncMode',
      autoSyncMode === 'manual'
        ? new vscode.ThemeIcon('sync-ignored')
        : new vscode.ThemeIcon('sync', autoSyncMode === 'root' ? ORANGE : BLUE),
      'Choose whether changes upload automatically: manual only, everything, or sync list only.',
      syncDescription
    );
    autoSync.contextValue = 'main-autosync';

    const syncCenter = new ButtonItem(
      'Sync Center',
      'sftpCompanion.openSyncCenter',
      new vscode.ThemeIcon('checklist', BLUE),
      'Full-page compare of every file on both sides plus the live transfer queue with progress, pause, and resume.'
    );

    const guide = new ButtonItem(
      'Setup Guide',
      'sftpCompanion.openSetupGuide',
      new vscode.ThemeIcon('book', GREEN),
      'Step-by-step guide: first-time setup, protocols, syncing, and troubleshooting.'
    );

    return [connection, account, autoSync, syncCenter, guide];
  }
}

export class LocalTreeProvider implements vscode.TreeDataProvider<LocalNode> {
  private readonly emitter = new vscode.EventEmitter<LocalNode | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(
    private readonly config: ConfigService,
    private readonly sftp: SftpService,
    private readonly decorations: SyncDecorationProvider
  ) {}

  private view?: vscode.TreeView<LocalNode>;
  // relativePath → whether the folder's (previously listed) children include
  // unsynced items. Drives the orange "contains changes" folder indicator.
  private readonly folderChanges = new Map<string, boolean>();

  public attachView(view: vscode.TreeView<LocalNode>): void {
    this.view = view;
  }

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public async getChildren(element?: LocalNode): Promise<LocalNode[]> {
    const root = this.config.getLocalRoot();
    if (!root) {
      return [];
    }

    const basePath = element?.fullPath ?? root.fsPath;
    try {
      const entries = await fs.readdir(basePath, { withFileTypes: true });
      const showHidden = this.config.getShowHidden();

      // One remote listing per folder instead of a stat round-trip per child —
      // dramatically fewer requests and no concurrent-operation collisions.
      // Skipped inside ignored folders: their children are all ignored anyway.
      let remoteMap: Map<string, RemoteStat> | undefined;
      if (this.sftp.connected && element?.isIgnored !== true) {
        try {
          const remoteChildren = await this.sftp.list(this.config.resolveRemotePath(element?.relativePath ?? ''));
          remoteMap = new Map(remoteChildren.map((child) => [
            path.posix.basename(child.remotePath),
            { isDirectory: child.isDirectory, size: child.size, modifiedAt: child.modifiedAt }
          ]));
        } catch {
          // Folder does not exist remotely (or listing failed): everything is missing.
          remoteMap = new Map();
        }
      }

      const output: LocalNode[] = [];
      const ignoreMatcher = this.config.getIgnoreMatcher();
      for (const entry of entries) {
        if (!showHidden && entry.name.startsWith('.')) {
          continue;
        }
        const fullPath = path.join(basePath, entry.name);
        const relativePath = relativeTo(root.fsPath, fullPath);
        if (relativePath.startsWith('..')) {
          continue;
        }
        // Ignored items stay visible (yellow) but never join sync comparisons.
        const isIgnored = element?.isIgnored === true || ignoreMatcher.isIgnored(relativePath);
        const isWhitelisted = this.config.isWhitelisted(relativePath);
        const syncInfo = isIgnored
          ? { state: 'unknown' as SyncState, label: 'Ignored' }
          : await getLocalSyncInfo(remoteMap, fullPath, entry.name, entry.isDirectory());
        this.decorations.update(fullPath, {
          state: syncInfo.state,
          isIgnored,
          isWhitelisted,
          containsChanges: entry.isDirectory() && this.folderChanges.get(relativePath) === true,
          label: syncInfo.label
        });
        output.push({
          kind: 'local',
          fullPath,
          relativePath,
          isDirectory: entry.isDirectory(),
          syncState: syncInfo.state,
          syncLabel: syncInfo.label,
          isWhitelisted,
          isIgnored
        });
      }
      const sorted = output.sort(sortNodes);
      this.recordFolderState(element, sorted);
      if (!element && this.view) {
        this.view.message = this.sftp.connected ? summarizeSyncStates(sorted) : undefined;
      }
      return sorted;
    } catch {
      return [];
    }
  }

  private recordFolderState(element: LocalNode | undefined, children: LocalNode[]): void {
    const key = element?.relativePath ?? '';
    const hasUnsynced = children.some((child) => !child.isIgnored && (
      child.syncState === 'localNewer' || child.syncState === 'remoteNewer'
      || child.syncState === 'missingRemote' || child.syncState === 'missingLocal'
      || (child.isDirectory && this.folderChanges.get(child.relativePath) === true)
    ));
    const previous = this.folderChanges.get(key);
    this.folderChanges.set(key, hasUnsynced);
    if (element) {
      this.decorations.update(element.fullPath, {
        state: element.syncState,
        isIgnored: element.isIgnored,
        isWhitelisted: element.isWhitelisted,
        containsChanges: hasUnsynced,
        label: element.syncLabel
      });
    }
    // Re-render the folder row once its "contains changes" state is known/changed.
    if (element && previous !== hasUnsynced && (previous !== undefined || hasUnsynced)) {
      this.emitter.fire(element);
    }
  }

  public getTreeItem(element: LocalNode): vscode.TreeItem {
    const root = this.config.getLocalRoot();
    const label = !element.relativePath ? path.basename(root?.fsPath ?? element.fullPath) : path.basename(element.fullPath);
    const item = new vscode.TreeItem(label, element.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const containsChanges = element.isDirectory && !element.isIgnored && this.folderChanges.get(element.relativePath) === true;
    const syncLabel = containsChanges ? `${element.syncLabel} • contains changes` : element.syncLabel;
    const autoSynced = !element.isIgnored && this.config.isAutoSynced(element.relativePath);
    // Description shows status only — repeating the relative path on every row
    // visually flattens the tree (the hierarchy already shows the location).
    item.description = [autoSynced ? '⚡' : undefined, syncLabel].filter(Boolean).join(' ');
    item.contextValue = element.isDirectory ? 'folder' : 'file';
    // Real resourceUri + theme icons = Explorer-identical alignment and file
    // type icons; sync state colors the filename via SyncDecorationProvider.
    // Folders need an explicit codicon: icon themes like Seti ship no folder
    // icons, so deferring to the theme leaves folders icon-less.
    item.resourceUri = vscode.Uri.file(element.fullPath);
    item.iconPath = element.isDirectory
      ? new vscode.ThemeIcon('symbol-folder', colorForNode(element, containsChanges))
      : vscode.ThemeIcon.File;
    item.tooltip = `${element.fullPath}\n${syncLabel}${autoSynced ? '\n⚡ Auto-sync uploads changes to this item' : ''}${element.isWhitelisted ? '\nOn the sync list' : ''}${element.isIgnored ? '\nIgnored by pattern' : ''}`;
    if (!element.isDirectory) {
      item.command = {
        command: 'vscode.open',
        title: 'Open Local File',
        arguments: [vscode.Uri.file(element.fullPath)]
      };
    }
    return item;
  }
}

export class RemoteTreeProvider implements vscode.TreeDataProvider<RemoteNode> {
  private readonly emitter = new vscode.EventEmitter<RemoteNode | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;
  private view?: vscode.TreeView<RemoteNode>;
  // Set after a failed auto-connect or an explicit disconnect so refreshes do
  // not hammer the server (or spam error popups) until the user retries.
  private autoConnectBlocked = false;
  private summary?: string;
  private readonly folderChanges = new Map<string, boolean>();

  public constructor(
    private readonly config: ConfigService,
    private readonly sftp: SftpService,
    private readonly logger: Logger,
    private readonly ensureConnected: () => Promise<boolean>
  ) {}

  public attachView(view: vscode.TreeView<RemoteNode>): void {
    this.view = view;
    this.updateMessage();
  }

  public allowAutoConnect(): void {
    this.autoConnectBlocked = false;
  }

  public blockAutoConnect(): void {
    this.autoConnectBlocked = true;
  }

  public refresh(): void {
    this.emitter.fire(undefined);
    this.updateMessage();
  }

  public async getChildren(element?: RemoteNode): Promise<RemoteNode[]> {
    if (!this.sftp.connected) {
      if (element || this.autoConnectBlocked || !this.config.getCurrentProfile()) {
        this.updateMessage();
        return [];
      }
      // First load with a configured account: connect automatically instead of
      // showing an empty view that waits for a manual Connect click.
      if (!(await this.ensureConnected())) {
        this.autoConnectBlocked = true;
        this.updateMessage();
        return [];
      }
      this.updateMessage();
    }
    const target = element?.remotePath ?? this.config.resolveRemotePath('');
    try {
      const children = await this.sftp.list(target);
      const showHidden = this.config.getShowHidden();
      const ignoreMatcher = this.config.getIgnoreMatcher();
      const parentIgnored = element?.isIgnored === true;
      const filtered = children.filter((child) => showHidden || !path.basename(child.remotePath).startsWith('.'));
      const enriched = await Promise.all(filtered.map(async (child) => {
        const localPath = this.config.resolveLocalPath(child.relativePath);
        const isWhitelisted = this.config.isWhitelisted(child.relativePath);
        const isIgnored = parentIgnored || (child.relativePath ? ignoreMatcher.isIgnored(child.relativePath) : false);
        const syncInfo = isIgnored
          ? { state: 'unknown' as SyncState, label: 'Ignored' }
          : await getRemoteSyncInfo(localPath, child);
        return {
          ...child,
          syncState: syncInfo.state,
          syncLabel: syncInfo.label,
          isWhitelisted,
          isIgnored
        };
      }));
      const sorted = enriched.sort(sortNodes);
      this.recordFolderState(element, sorted);
      if (!element) {
        this.summary = summarizeSyncStates(sorted);
        this.updateMessage();
      }
      return sorted;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.append('error', `Listing ${target} failed: ${message}`);
      if (!element) {
        vscode.window.showErrorMessage(`Could not list ${target}: ${message}`);
      }
      return [];
    }
  }

  private updateMessage(): void {
    if (!this.view) {
      return;
    }
    // Only show "Connecting…" while an auto-connect can still happen; the
    // disconnected/unconfigured states get welcome views with action buttons.
    if (this.sftp.connected) {
      this.view.message = this.summary;
    } else {
      this.summary = undefined;
      this.view.message = !this.autoConnectBlocked && this.config.getCurrentProfile() ? 'Connecting…' : undefined;
    }
  }

  private recordFolderState(element: RemoteNode | undefined, children: RemoteNode[]): void {
    const key = element?.relativePath ?? '';
    const hasUnsynced = children.some((child) => !child.isIgnored && (
      child.syncState === 'localNewer' || child.syncState === 'remoteNewer'
      || child.syncState === 'missingRemote' || child.syncState === 'missingLocal'
      || (child.isDirectory && this.folderChanges.get(child.relativePath) === true)
    ));
    const previous = this.folderChanges.get(key);
    this.folderChanges.set(key, hasUnsynced);
    if (element && previous !== hasUnsynced && (previous !== undefined || hasUnsynced)) {
      this.emitter.fire(element);
    }
  }

  public getTreeItem(element: RemoteNode): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(element.remotePath), element.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const sizeLabel = element.isDirectory ? undefined : formatBytes(element.size);
    const containsChanges = element.isDirectory && !element.isIgnored && this.folderChanges.get(element.relativePath) === true;
    const syncLabel = containsChanges ? `${element.syncLabel} • contains changes` : element.syncLabel;
    const autoSynced = !element.isIgnored && this.config.isAutoSynced(element.relativePath);
    item.description = [autoSynced ? '⚡' : undefined, [sizeLabel, syncLabel].filter(Boolean).join(' • ')].filter(Boolean).join(' ');
    item.tooltip = `${element.remotePath}\n${syncLabel}${autoSynced ? '\n⚡ Auto-sync uploads changes to this item' : ''}${element.isWhitelisted ? '\nOn the sync list' : ''}${element.isIgnored ? '\nIgnored by pattern' : ''}${element.modifiedAt ? `\nModified ${new Date(element.modifiedAt).toLocaleString()}` : ''}${element.mode ? `\nPermissions ${element.mode} (right-click → Change Permissions)` : ''}`;
    item.contextValue = element.isDirectory ? 'remote-folder' : 'remote-file';
    item.iconPath = new vscode.ThemeIcon(element.isDirectory ? 'folder-opened' : 'file', colorForNode(element, containsChanges));
    if (!element.isDirectory) {
      item.command = {
        command: 'sftpCompanion.openRemoteFile',
        title: 'Open Remote File for Edit',
        arguments: [element]
      };
    }
    return item;
  }
}

export class QueueTreeProvider implements vscode.TreeDataProvider<QueueItem> {
  private readonly emitter = new vscode.EventEmitter<QueueItem | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly getItems: () => readonly QueueItem[]) {}

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public getChildren(): QueueItem[] {
    return [...this.getItems()];
  }

  public getTreeItem(element: QueueItem): vscode.TreeItem {
    const item = new vscode.TreeItem(`${element.direction.toUpperCase()} ${path.basename(element.remotePath)}`, vscode.TreeItemCollapsibleState.None);
    const percent = element.status === 'running' && element.total && element.transferred !== undefined
      ? ` ${Math.min(100, Math.round((element.transferred / element.total) * 100))}%`
      : '';
    item.description = `${element.status}${percent} • ${element.message}`;
    item.tooltip = `${element.localPath}\n${element.remotePath}${element.error ? `\nError: ${element.error}` : ''}`;
    item.contextValue = element.status === 'failed'
      ? 'transfer-failed'
      : element.status === 'running'
        ? 'transfer-running'
        : element.status === 'queued'
          ? 'transfer-queued'
          : element.status === 'held'
            ? 'transfer-held'
            : 'transfer-item';
    item.iconPath = new vscode.ThemeIcon(
      element.direction === 'upload' ? 'cloud-upload' : 'cloud-download',
      queueColor(element.status)
    );
    return item;
  }
}

export class LogTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  public readonly onDidChangeTreeData = this.emitter.event;

  public constructor(private readonly logger: Logger) {}

  public refresh(): void {
    this.emitter.fire(undefined);
  }

  public getChildren(): vscode.TreeItem[] {
    return this.logger.entries.map((entry) => {
      const item = new vscode.TreeItem(`${entry.level.toUpperCase()} ${entry.message}`, vscode.TreeItemCollapsibleState.None);
      item.description = new Date(entry.timestamp).toLocaleTimeString();
      item.contextValue = 'log-entry';
      return item;
    });
  }

  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }
}

function sortNodes<T extends { isDirectory: boolean; remotePath?: string; fullPath?: string }>(left: T, right: T): number {
  if (left.isDirectory !== right.isDirectory) {
    return left.isDirectory ? -1 : 1;
  }
  const leftName = left.remotePath ?? left.fullPath ?? '';
  const rightName = right.remotePath ?? right.fullPath ?? '';
  return leftName.localeCompare(rightName);
}

/**
 * Compact tally shown above the Local Sync and Remote Files trees. Folders are
 * only counted when missing on one side — an existing folder's contents have
 * not been compared, so it must not inflate the synced number.
 */
function summarizeSyncStates(nodes: ReadonlyArray<{ syncState: SyncState; isDirectory: boolean; isIgnored: boolean }>): string | undefined {
  let total = 0;
  let synced = 0;
  let differ = 0;
  let missing = 0;
  let unknown = 0;
  for (const node of nodes) {
    if (node.isIgnored) {
      continue;
    }
    const isMissing = node.syncState === 'missingLocal' || node.syncState === 'missingRemote';
    if (node.isDirectory && !isMissing) {
      continue;
    }
    total += 1;
    switch (node.syncState) {
      case 'synced': synced += 1; break;
      case 'localNewer':
      case 'remoteNewer': differ += 1; break;
      case 'missingLocal':
      case 'missingRemote': missing += 1; break;
      default: unknown += 1; break;
    }
  }
  if (total === 0) {
    return undefined;
  }
  const parts = [`Files: ${synced}/${total} synced`];
  if (differ > 0) {
    parts.push(`${differ} differ`);
  }
  if (missing > 0) {
    parts.push(`${missing} missing`);
  }
  if (unknown > 0) {
    parts.push(`${unknown} not compared`);
  }
  return parts.join(' • ');
}

function formatBytes(size?: number): string | undefined {
  if (size === undefined) {
    return undefined;
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Icon colors: yellow = ignored, red = missing on either side, orange = out of
 * sync (or folder containing changes), green = in sync, purple = on sync list.
 */
function colorForNode(node: { syncState: SyncState; isWhitelisted: boolean; isIgnored: boolean }, containsChanges = false): vscode.ThemeColor | undefined {
  if (node.isIgnored) {
    return YELLOW;
  }
  if (node.syncState === 'missingLocal' || node.syncState === 'missingRemote') {
    return RED;
  }
  if (node.syncState === 'localNewer' || node.syncState === 'remoteNewer' || containsChanges) {
    return ORANGE;
  }
  if (node.syncState === 'synced') {
    return GREEN;
  }
  if (node.isWhitelisted) {
    return PURPLE;
  }
  return undefined;
}

function queueColor(status: QueueItem['status']): vscode.ThemeColor | undefined {
  if (status === 'failed') {
    return RED;
  }
  if (status === 'running') {
    return BLUE;
  }
  if (status === 'completed') {
    return GREEN;
  }
  if (status === 'held') {
    return ORANGE;
  }
  return YELLOW;
}

async function getLocalSyncInfo(
  remoteMap: Map<string, RemoteStat> | undefined,
  localPath: string,
  name: string,
  isDirectory: boolean
): Promise<{ state: SyncState; label: string }> {
  if (!remoteMap) {
    return { state: 'unknown', label: 'Not compared' };
  }

  const remoteStat = remoteMap.get(name);
  if (!remoteStat) {
    return { state: 'missingRemote', label: 'Remote missing' };
  }

  if (isDirectory || remoteStat.isDirectory) {
    // Folder exists on both sides = green; the orange "contains changes"
    // indicator takes over once its children have been compared.
    return { state: 'synced', label: 'Present on both sides' };
  }

  const localStat = await fs.stat(localPath);
  return compareFileState(localStat.mtimeMs, localStat.size, remoteStat.size, remoteStat.modifiedAt);
}

async function getRemoteSyncInfo(
  localPath: string | undefined,
  remoteNode: RemoteNode
): Promise<{ state: SyncState; label: string }> {
  if (!localPath) {
    return { state: 'missingLocal', label: 'Outside sync root' };
  }

  try {
    const localStat = await fs.stat(localPath);
    if (remoteNode.isDirectory || localStat.isDirectory()) {
      return { state: 'synced', label: 'Present on both sides' };
    }
    return compareFileState(localStat.mtimeMs, localStat.size, remoteNode.size, remoteNode.modifiedAt);
  } catch {
    return { state: 'missingLocal', label: 'Local missing' };
  }
}

/**
 * Decide sync status from edit times AND sizes. Uploads/downloads preserve
 * modification times, so time comparison means edit-time vs edit-time; size is
 * the tie-breaker for servers that return no timestamps, and a same-size file
 * whose server stamp is newer is treated as an uploaded copy (in sync).
 */
export function compareFileState(
  localMtimeMs: number,
  localSize: number,
  remoteSize: number | undefined,
  remoteModifiedAt: number | undefined
): { state: SyncState; label: string } {
  const sizeKnown = remoteSize !== undefined;
  const sizeMatch = !sizeKnown || remoteSize === localSize;

  if (remoteModifiedAt === undefined) {
    if (!sizeKnown) {
      return { state: 'unknown', label: 'No timestamp or size' };
    }
    return sizeMatch
      ? { state: 'synced', label: 'Same size' }
      : { state: 'localNewer', label: 'Size differs' };
  }

  const delta = localMtimeMs - remoteModifiedAt;
  if (Math.abs(delta) < 2000) {
    return sizeMatch
      ? { state: 'synced', label: 'In sync' }
      : { state: 'localNewer', label: 'Size differs' };
  }
  if (delta < 0 && sizeKnown && sizeMatch) {
    // Server stamp is newer but content size matches — the typical signature of
    // an earlier upload that did not preserve timestamps.
    return { state: 'synced', label: 'Same size (stamped at upload)' };
  }
  if (delta > 0) {
    return { state: 'localNewer', label: sizeMatch ? 'Local newer' : 'Local newer • size differs' };
  }
  return { state: 'remoteNewer', label: sizeMatch ? 'Remote newer' : 'Remote newer • size differs' };
}
