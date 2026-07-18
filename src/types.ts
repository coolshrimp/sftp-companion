import * as vscode from 'vscode';

export type AuthMode = 'password' | 'privateKey';
export type AutoSyncMode = 'manual' | 'root' | 'whitelist';
export type Protocol = 'sftp' | 'ftp';
export type SyncState = 'unknown' | 'missingRemote' | 'missingLocal' | 'synced' | 'localNewer' | 'remoteNewer';

export interface SftpProfile {
  host: string;
  port: number;
  /** Transport protocol. 'ftp' covers plain FTP and FTPS (see `secure`). */
  protocol: Protocol;
  /** Explicit TLS (FTPS) when protocol is 'ftp'. Matches sftp.json's `secure` key. */
  secure?: boolean;
  username: string;
  remotePath: string;
  context: string;
  syncFolder: string;
  ignore: string[];
  whitelist: string[];
  authMode: AuthMode;
  privateKeyPath?: string;
  passphrase?: string;
  showHiddenFiles?: boolean;
  autoSyncMode: AutoSyncMode;
}

export interface StoredSecretPayload {
  password?: string;
  passphrase?: string;
}

export interface LoadedProfile {
  profile: SftpProfile;
  password?: string;
  passphrase?: string;
  source: 'workspaceFile' | 'legacyState';
}

export interface QueueItem {
  id: string;
  direction: 'upload' | 'download';
  type: 'file' | 'folder';
  localPath: string;
  remotePath: string;
  status: 'queued' | 'held' | 'running' | 'completed' | 'failed';
  attempts: number;
  message: string;
  error?: string;
  createdAt: number;
  /** Set when the transfer finishes successfully. */
  completedAt?: number;
  /** Bytes transferred so far (file transfers only). */
  transferred?: number;
  /** Total bytes when known (file transfers only). */
  total?: number;
}

export interface LocalNode {
  kind: 'local';
  /** Account/root generation that produced this tree node. */
  contextKey: string;
  fullPath: string;
  relativePath: string;
  isDirectory: boolean;
  syncState: SyncState;
  syncLabel: string;
  isWhitelisted: boolean;
  isIgnored: boolean;
}

export interface RemoteNode {
  kind: 'remote';
  /** Account/root generation that produced this tree node. */
  contextKey?: string;
  remotePath: string;
  relativePath: string;
  isDirectory: boolean;
  size?: number;
  modifiedAt?: number;
  /** Unix permissions as octal digits, e.g. "644", when the server reports them. */
  mode?: string;
  syncState: SyncState;
  syncLabel: string;
  isWhitelisted: boolean;
  isIgnored: boolean;
}

export interface LogEntry {
  id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

export interface RemoteStat {
  isDirectory: boolean;
  size?: number;
  modifiedAt?: number;
}

export interface ServiceBundle {
  logger: LoggerLike;
  queue: QueueLike;
  sftp: SftpLike;
  config: ConfigLike;
}

export interface LoggerLike {
  entries: readonly LogEntry[];
  append(level: LogEntry['level'], message: string): void;
  onDidChange: vscode.Event<void>;
}

export interface QueueLike {
  items: readonly QueueItem[];
  enqueueUpload(localPath: string, remotePath: string, type: 'file' | 'folder'): Promise<void>;
  enqueueDownload(remotePath: string, localPath: string, type: 'file' | 'folder'): Promise<void>;
  retry(id: string): Promise<void>;
  clearCompleted(): void;
  onDidChange: vscode.Event<void>;
}

export interface SftpLike {
  readonly connected: boolean;
  connect(profile: LoadedProfile): Promise<void>;
  disconnect(): Promise<void>;
  list(remotePath: string): Promise<RemoteNode[]>;
  stat(remotePath: string): Promise<RemoteStat | undefined>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  uploadFolder(localPath: string, remotePath: string): Promise<void>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  downloadFolder(remotePath: string, localPath: string): Promise<void>;
}

export interface ConfigLike {
  loadActiveProfile(): Promise<LoadedProfile | undefined>;
  saveProfile(profile: SftpProfile, secret: StoredSecretPayload): Promise<void>;
  generateWorkspaceConfig(): Promise<vscode.Uri | undefined>;
  openWorkspaceConfig(): Promise<vscode.Uri | undefined>;
  getCurrentProfile(): LoadedProfile | undefined;
  getLocalRoot(): vscode.Uri | undefined;
  getAllowedRoots(): string[];
  getAutoSyncMode(): AutoSyncMode;
  setAutoSyncMode(mode: AutoSyncMode): Promise<void>;
  getShowHidden(): boolean;
  isWhitelisted(relativePath: string): boolean;
  toggleWhitelistEntry(relativePath: string): Promise<void>;
  resolveRemotePath(relativePath: string): string;
  resolveLocalPath(relativePath: string): string | undefined;
  toRelativeLocalPath(filePath: string): string | undefined;
}
