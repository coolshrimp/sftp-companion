import * as ftp from 'basic-ftp';
import { createReadStream, createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import SftpClient from 'ssh2-sftp-client';
import { joinRemote, normalizeRelative } from './pathUtils';
import { LoadedProfile, RemoteNode, RemoteStat } from './types';

type Logger = { append(level: 'info' | 'warn' | 'error', message: string): void };

/** Persists one trusted SSH host key fingerprint per host:port. */
export interface HostKeyStore {
  get(hostId: string): string | undefined;
  set(hostId: string, fingerprint: string): Promise<void> | void;
}

/**
 * The server presented a different SSH host key than the one pinned on a
 * previous connect. Surfaced as its own error type so the UI can offer an
 * explicit "trust the new key" decision instead of failing opaquely.
 */
export class HostKeyMismatchError extends Error {
  public constructor(
    public readonly hostId: string,
    public readonly knownFingerprint: string,
    public readonly presentedFingerprint: string
  ) {
    super(
      `Host key verification failed for ${hostId}: the server presented SSH key SHA256:${presentedFingerprint}, `
      + `but SHA256:${knownFingerprint} was trusted on an earlier connect. `
      + 'This usually means the server was reinstalled or migrated — but it can also mean the connection is being intercepted. '
      + 'Use the Connect action to review and trust the new key.'
    );
    this.name = 'HostKeyMismatchError';
  }
}

export class SftpService {
  private readonly client = new SftpClient();
  private ftpClient?: ftp.Client;
  private ftpAccess?: ftp.AccessOptions;
  // basic-ftp allows only one command at a time on the control connection, so
  // every FTP operation is chained through this mutex.
  private ftpChain: Promise<unknown> = Promise.resolve();
  // ssh2-sftp-client also misbehaves under concurrent calls on one connection
  // (the local and remote trees refresh at the same time), so SFTP operations
  // are serialized the same way.
  private sftpChain: Promise<unknown> = Promise.resolve();
  // FTP has no cheap stat: we list the parent directory instead. The tree views
  // stat every sibling in a row, so cache listings briefly to avoid N identical
  // LIST round-trips per folder expand.
  private readonly ftpListCache = new Map<string, { at: number; listing: ftp.FileInfo[] }>();
  private mode: 'sftp' | 'ftp' = 'sftp';
  private currentProfile?: LoadedProfile;
  private isConnected = false;
  private ignoreFilter?: (relativePath: string) => boolean;
  // File transfers run on a pool of dedicated connections so several files
  // move in parallel while the primary connection keeps serving list/stat.
  private maxTransferConnections = 5;
  private readonly sftpPool: Array<{ client: SftpClient; busy: boolean }> = [];
  private readonly ftpPool: Array<{ client: ftp.Client; busy: boolean }> = [];
  private readonly poolWaiters: Array<() => void> = [];
  // Set by the host verifier when the pinned key does not match, so the
  // generic ssh2 "verification failed" error can be replaced with a rich one.
  private hostKeyError?: HostKeyMismatchError;

  public constructor(
    private readonly logger: Logger,
    private readonly hostKeys?: HostKeyStore
  ) {}

  /** How many parallel transfer connections may be opened. */
  public setTransferConcurrency(count: number): void {
    this.maxTransferConnections = Math.max(1, Math.min(10, Math.floor(count)));
  }

  /** Paths matching this filter are skipped during recursive folder downloads. */
  public setIgnoreFilter(filter: (relativePath: string) => boolean): void {
    this.ignoreFilter = filter;
  }

  public get connected(): boolean {
    return this.isConnected;
  }

  /** True only when the live session represents the currently loaded account. */
  public isConnectedTo(loaded: LoadedProfile): boolean {
    const current = this.currentProfile;
    if (!this.isConnected || !current) {
      return false;
    }
    const left = current.profile;
    const right = loaded.profile;
    return left.protocol === right.protocol
      && Boolean(left.secure) === Boolean(right.secure)
      && left.host === right.host
      && left.port === right.port
      && left.username === right.username
      && joinRemote(left.remotePath || '/') === joinRemote(right.remotePath || '/')
      && left.authMode === right.authMode
      && (left.privateKeyPath ?? '') === (right.privateKeyPath ?? '')
      && (current.password ?? '') === (loaded.password ?? '')
      && (current.passphrase ?? '') === (loaded.passphrase ?? '');
  }

  public async connect(loaded: LoadedProfile): Promise<void> {
    await this.disconnect();
    this.mode = loaded.profile.protocol === 'ftp' ? 'ftp' : 'sftp';
    if (this.mode === 'ftp') {
      await this.connectFtp(loaded);
    } else {
      await this.connectSftp(loaded);
    }
    this.currentProfile = loaded;
    this.isConnected = true;
    this.logger.append('info', `Connected to ${loaded.profile.host}.`);
  }

  public async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }
    if (this.mode === 'ftp') {
      this.ftpClient?.close();
      this.ftpClient = undefined;
      this.ftpAccess = undefined;
      this.ftpListCache.clear();
    } else {
      await this.client.end();
    }
    for (const entry of this.ftpPool) {
      entry.client.close();
    }
    this.ftpPool.length = 0;
    await Promise.all(this.sftpPool.map((entry) => entry.client.end().catch(() => undefined)));
    this.sftpPool.length = 0;
    this.poolWaiters.splice(0).forEach((wake) => wake());
    this.isConnected = false;
    this.currentProfile = undefined;
    this.logger.append('info', 'Disconnected from server.');
  }

  public async list(remotePath: string): Promise<RemoteNode[]> {
    this.ensureConnected();
    if (this.mode === 'ftp') {
      const listing = await this.ftpList(remotePath);
      return listing
        .filter((entry) => entry.name !== '.' && entry.name !== '..')
        .map((entry) => ({
          kind: 'remote' as const,
          remotePath: joinRemote(remotePath, entry.name),
          relativePath: this.toRelative(entry.name, remotePath),
          isDirectory: entry.isDirectory,
          size: entry.isDirectory ? undefined : entry.size,
          modifiedAt: entry.modifiedAt ? entry.modifiedAt.getTime() : undefined,
          mode: entry.permissions ? `${entry.permissions.user}${entry.permissions.group}${entry.permissions.world}` : undefined,
          syncState: 'unknown' as const,
          syncLabel: 'Not compared',
          isWhitelisted: false,
          isIgnored: false
        }));
    }

    const listing = await this.runSftp(() => this.client.list(remotePath));
    return listing.map((entry) => ({
      kind: 'remote' as const,
      remotePath: joinRemote(remotePath, entry.name),
      relativePath: this.toRelative(entry.name, remotePath),
      isDirectory: entry.type === 'd',
      size: typeof entry.size === 'number' ? entry.size : undefined,
      modifiedAt: typeof entry.modifyTime === 'number' ? entry.modifyTime : undefined,
      mode: rightsToOctal(entry.rights),
      syncState: 'unknown',
      syncLabel: 'Not compared',
      isWhitelisted: false,
      isIgnored: false
    }));
  }

  public async stat(remotePath: string): Promise<RemoteStat | undefined> {
    this.ensureConnected();
    if (this.mode === 'ftp') {
      const normalized = joinRemote(remotePath);
      if (normalized === '/') {
        return { isDirectory: true };
      }
      const parent = path.posix.dirname(normalized);
      const name = path.posix.basename(normalized);
      try {
        const listing = await this.ftpList(parent);
        const entry = listing.find((item) => item.name === name);
        if (!entry) {
          return undefined;
        }
        return {
          isDirectory: entry.isDirectory,
          size: entry.isDirectory ? undefined : entry.size,
          modifiedAt: entry.modifiedAt ? entry.modifiedAt.getTime() : undefined
        };
      } catch {
        return undefined;
      }
    }

    try {
      const stat = await this.runSftp(() => this.client.stat(remotePath));
      return {
        isDirectory: stat.isDirectory,
        size: typeof stat.size === 'number' ? stat.size : undefined,
        modifiedAt: typeof stat.modifyTime === 'number' ? stat.modifyTime : undefined
      };
    } catch {
      return undefined;
    }
  }

  public async uploadFile(
    localPath: string,
    remotePath: string,
    onProgress?: (transferred: number, total?: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    this.ensureConnected();
    throwIfAborted(signal);
    // Preserve the local modified time on the server so sync comparisons keep
    // matching edit time against edit time instead of against upload time.
    const localStat = await fs.stat(localPath).catch(() => undefined);
    if (localStat?.isDirectory()) {
      // STOR/put on a directory path creates a bogus zero-byte remote FILE
      // before the local read fails, permanently blocking that folder name.
      throw new Error(`"${localPath}" is a folder — use the folder upload action so its files are queued individually.`);
    }
    if (this.mode === 'ftp') {
      const lease = await this.acquireFtpTransfer();
      const client = lease.client;
      try {
        // Aborting closes this pooled connection; it reconnects on next lease.
        const onAbort = (): void => client.close();
        signal?.addEventListener('abort', onAbort);
        if (onProgress) {
          client.trackProgress((info) => onProgress(info.bytes, localStat?.size));
        }
        try {
          try {
            await ensureFtpDirectory(client, path.posix.dirname(remotePath));
            await client.uploadFrom(localPath, remotePath);
          } catch (error) {
            if (!isBlockedPathError(error)) {
              throw error;
            }
            // A path segment exists as a FILE on the server (usually a junk
            // zero-byte file left by an aborted upload) and blocks folder
            // creation. Repair the path, then retry the upload once.
            await healBlockedFtpPath(client, path.posix.dirname(remotePath), this.logger, error);
            await client.uploadFrom(localPath, remotePath);
          }
          if (localStat) {
            try {
              await client.send(`MFMT ${toMfmtStamp(localStat.mtime)} ${remotePath}`);
            } catch {
              // Server does not support MFMT — timestamp preservation is best-effort.
            }
          }
        } finally {
          signal?.removeEventListener('abort', onAbort);
          if (onProgress) {
            client.trackProgress();
          }
        }
      } finally {
        lease.release();
      }
      this.ftpListCache.clear();
    } else {
      const lease = await this.acquireSftpTransfer();
      try {
        await this.ensureRemoteDirectoryOn(lease.client, path.posix.dirname(remotePath));
        if (signal || onProgress) {
          await this.streamSftpUpload(lease.client, localPath, remotePath, localStat?.size, onProgress, signal);
        } else {
          await lease.client.put(localPath, remotePath);
        }
        if (localStat) {
          await this.setSftpTimes(lease.client, remotePath, localStat.mtime);
        }
      } finally {
        lease.release();
      }
    }
    this.logger.append('info', `Uploaded file ${normalizeRelative(localPath)} -> ${remotePath}`);
  }

  public async uploadFolder(localPath: string, remotePath: string): Promise<void> {
    this.ensureConnected();
    if (this.mode === 'ftp') {
      await this.runFtp((client) => client.uploadFromDir(localPath, remotePath));
      this.ftpListCache.clear();
    } else {
      await this.runSftp(async () => {
        await this.ensureRemoteDirectory(remotePath);
        await this.client.uploadDir(localPath, remotePath);
      });
    }
    this.logger.append('info', `Uploaded folder ${normalizeRelative(localPath)} -> ${remotePath}`);
  }

  public async downloadFile(
    remotePath: string,
    localPath: string,
    onProgress?: (transferred: number, total?: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    this.ensureConnected();
    throwIfAborted(signal);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    const remoteStat = await this.stat(remotePath);
    if (this.mode === 'ftp') {
      const lease = await this.acquireFtpTransfer();
      const client = lease.client;
      try {
        const onAbort = (): void => client.close();
        signal?.addEventListener('abort', onAbort);
        if (onProgress) {
          client.trackProgress((info) => onProgress(info.bytes, remoteStat?.size));
        }
        try {
          await client.downloadTo(localPath, remotePath);
        } finally {
          signal?.removeEventListener('abort', onAbort);
          if (onProgress) {
            client.trackProgress();
          }
        }
      } finally {
        lease.release();
      }
    } else {
      const lease = await this.acquireSftpTransfer();
      try {
        if (signal || onProgress) {
          await this.streamSftpDownload(lease.client, remotePath, localPath, remoteStat?.size, onProgress, signal);
        } else {
          await lease.client.get(remotePath, localPath);
        }
      } finally {
        lease.release();
      }
    }
    // Mirror the remote modified time locally so the pair compares as in sync.
    if (remoteStat?.modifiedAt) {
      try {
        await fs.utimes(localPath, new Date(), new Date(remoteStat.modifiedAt));
      } catch {
        // Best-effort only.
      }
    }
    this.logger.append('info', `Downloaded file ${remotePath} -> ${normalizeRelative(localPath)}`);
  }

  public async downloadFolder(remotePath: string, localPath: string): Promise<void> {
    this.ensureConnected();
    await fs.mkdir(localPath, { recursive: true });
    if (this.mode === 'ftp') {
      await this.runFtp((client) => client.downloadToDir(localPath, remotePath));
    } else {
      await this.runSftp(() => this.client.downloadDir(remotePath, localPath, {
        filter: (entryPath: string) => !this.isIgnoredRemote(entryPath)
      }));
    }
    this.logger.append('info', `Downloaded folder ${remotePath} -> ${normalizeRelative(localPath)}`);
  }

  /** Delete a remote file, or a folder (recursively) when the file delete fails. */
  public async deleteRemote(remotePath: string, isDirectory?: boolean): Promise<void> {
    this.ensureConnected();
    if (this.mode === 'ftp') {
      await this.runFtp(async (client) => {
        if (isDirectory === true) {
          await client.removeDir(remotePath);
          return;
        }
        try {
          await client.remove(remotePath);
        } catch (error) {
          if (isDirectory === false) {
            throw error;
          }
          await client.removeDir(remotePath);
        }
      });
      this.ftpListCache.clear();
    } else {
      await this.runSftp(async () => {
        if (isDirectory === true) {
          await this.client.rmdir(remotePath, true);
          return;
        }
        try {
          await this.client.delete(remotePath);
        } catch (error) {
          if (isDirectory === false) {
            throw error;
          }
          await this.client.rmdir(remotePath, true);
        }
      });
    }
    this.logger.append('info', `Deleted ${remotePath} from the server.`);
  }

  public async readFile(remotePath: string): Promise<Buffer> {
    this.ensureConnected();
    if (this.mode === 'ftp') {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        }
      });
      await this.runFtp((client) => client.downloadTo(sink, remotePath));
      return Buffer.concat(chunks);
    }
    const result = await this.runSftp(() => this.client.get(remotePath));
    if (Buffer.isBuffer(result)) {
      return result;
    }
    throw new Error('Remote file did not return a Buffer payload.');
  }

  /** Rename or move a remote file/folder (destination is a full remote path). */
  public async renameRemote(fromPath: string, toPath: string): Promise<void> {
    this.ensureConnected();
    if (this.mode === 'ftp') {
      await this.runFtp((client) => client.rename(fromPath, toPath));
      this.ftpListCache.clear();
    } else {
      await this.runSftp(() => this.client.rename(fromPath, toPath));
    }
    this.logger.append('info', `Renamed ${fromPath} -> ${toPath}`);
  }

  public async createRemoteFolder(remotePath: string): Promise<void> {
    this.ensureConnected();
    if (this.mode === 'ftp') {
      await this.runFtp((client) => ensureFtpDirectory(client, remotePath));
      this.ftpListCache.clear();
    } else {
      await this.runSftp(() => this.client.mkdir(remotePath, true));
    }
    this.logger.append('info', `Created remote folder ${remotePath}`);
  }

  public async createRemoteFile(remotePath: string): Promise<void> {
    this.ensureConnected();
    if (this.mode === 'ftp') {
      await this.runFtp(async (client) => {
        await ensureFtpDirectory(client, path.posix.dirname(remotePath));
        await client.uploadFrom(Readable.from([]), remotePath);
      });
      this.ftpListCache.clear();
    } else {
      await this.runSftp(async () => {
        await this.client.mkdir(path.posix.dirname(remotePath), true).catch(() => undefined);
        await this.client.put(Buffer.alloc(0), remotePath);
      });
    }
    this.logger.append('info', `Created remote file ${remotePath}`);
  }

  /** chmod, e.g. mode "644" / "755". FTP uses SITE CHMOD (most Unix hosts). */
  public async chmodRemote(remotePath: string, mode: string): Promise<void> {
    this.ensureConnected();
    if (this.mode === 'ftp') {
      await this.runFtp((client) => client.send(`SITE CHMOD ${mode} ${remotePath}`));
      this.ftpListCache.clear();
    } else {
      await this.runSftp(() => this.client.chmod(remotePath, parseInt(mode, 8)));
    }
    this.logger.append('info', `Changed permissions of ${remotePath} to ${mode}`);
  }

  /**
   * Set the server file's modified time (no content transfer). Returns false
   * when the server does not support it, so callers can fall back to redating
   * the local file instead. Used by "Mark as Synced".
   */
  public async setRemoteModifiedTime(remotePath: string, mtime: Date): Promise<boolean> {
    this.ensureConnected();
    if (this.mode === 'ftp') {
      try {
        await this.runFtp((client) => client.send(`MFMT ${toMfmtStamp(mtime)} ${remotePath}`));
        this.ftpListCache.clear();
        return true;
      } catch {
        return false;
      }
    }
    try {
      return await this.runSftp(async () => {
        const wrapper = (this.client as unknown as {
          sftp?: { utimes(p: string, atime: number, mtime: number, cb: (err: Error | null | undefined) => void): void };
        }).sftp;
        if (!wrapper?.utimes) {
          return false;
        }
        const seconds = Math.floor(mtime.getTime() / 1000);
        await new Promise<void>((resolve, reject) => {
          wrapper.utimes(remotePath, seconds, seconds, (err) => (err ? reject(err) : resolve()));
        });
        return true;
      });
    } catch {
      return false;
    }
  }

  private async connectSftp(loaded: LoadedProfile): Promise<void> {
    this.logger.append('info', `Connecting to ${loaded.profile.username}@${loaded.profile.host}:${loaded.profile.port} (SFTP, ${loaded.profile.authMode} auth)…`);
    await this.connectSftpClient(this.client, loaded);
  }

  private async buildSftpConfig(loaded: LoadedProfile): Promise<Record<string, unknown>> {
    const connectionConfig: Record<string, unknown> = {
      host: loaded.profile.host,
      port: loaded.profile.port,
      username: loaded.profile.username,
      readyTimeout: 15000
    };

    // Pin the server's SSH host key (trust on first use, like OpenSSH's
    // known_hosts): without this, any machine answering on that address could
    // impersonate the server and capture the credentials.
    if (this.hostKeys) {
      const hostId = `${loaded.profile.host}:${loaded.profile.port}`;
      connectionConfig.hostHash = 'sha256';
      connectionConfig.hostVerifier = (hexHash: string): boolean => {
        // Unpadded base64, matching how OpenSSH prints SHA256 fingerprints so
        // users can compare against `ssh-keygen -lf` output directly.
        const presented = Buffer.from(hexHash, 'hex').toString('base64').replace(/=+$/, '');
        const known = this.hostKeys?.get(hostId);
        if (!known) {
          void this.hostKeys?.set(hostId, presented);
          this.logger.append('info', `Pinned SSH host key for ${hostId} on first connect (SHA256:${presented}).`);
          return true;
        }
        if (known === presented) {
          return true;
        }
        this.hostKeyError = new HostKeyMismatchError(hostId, known, presented);
        return false;
      };
    }

    if (loaded.profile.authMode === 'privateKey') {
      if (!loaded.profile.privateKeyPath) {
        throw new Error('Private key auth selected but no private key path is configured.');
      }
      connectionConfig.privateKey = await fs.readFile(loaded.profile.privateKeyPath, 'utf8');
      if (loaded.passphrase) {
        connectionConfig.passphrase = loaded.passphrase;
      }
    } else {
      if (!loaded.password) {
        throw new Error('Password auth selected but no password is saved. Open the account manager and enter one.');
      }
      connectionConfig.password = loaded.password;
      // Many shared-hosting servers only accept keyboard-interactive auth;
      // answer its prompts with the same password.
      connectionConfig.tryKeyboard = true;
    }
    return connectionConfig;
  }

  private async connectSftpClient(client: SftpClient, loaded: LoadedProfile): Promise<void> {
    const connectionConfig = await this.buildSftpConfig(loaded);
    const rawClient = (client as unknown as { client?: NodeJS.EventEmitter }).client;
    const answerKeyboardInteractive = (
      _name: string,
      _instructions: string,
      _lang: string,
      prompts: unknown[],
      finish: (responses: string[]) => void
    ): void => {
      finish((Array.isArray(prompts) ? prompts : []).map(() => loaded.password ?? ''));
    };
    rawClient?.on('keyboard-interactive', answerKeyboardInteractive);
    this.hostKeyError = undefined;
    try {
      await client.connect(connectionConfig);
    } catch (error) {
      if (this.hostKeyError) {
        const mismatch = this.hostKeyError;
        this.hostKeyError = undefined;
        throw mismatch;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/authentication methods failed/i.test(message)) {
        throw new Error(`${message} — double-check the username and password for ${loaded.profile.username}@${loaded.profile.host}. If they are correct, the server may restrict SFTP logins for this account.`);
      }
      if (/before handshake|handshake failed|not an ssh/i.test(message)) {
        const portHint = loaded.profile.port === 21
          ? ' Port 21 is the FTP port. If your host only offers FTP, switch Protocol to FTP in the account manager. For SFTP, use port 22 (or the SSH port your host provides).'
          : ` The server on ${loaded.profile.host}:${loaded.profile.port} did not answer with an SSH handshake — it may be an FTP or web server port. SFTP usually runs on port 22; for plain FTP switch Protocol to FTP in the account manager.`;
        throw new Error(`${message} —${portHint}`);
      }
      throw error;
    } finally {
      rawClient?.removeListener('keyboard-interactive', answerKeyboardInteractive);
    }
  }

  private async connectFtp(loaded: LoadedProfile): Promise<void> {
    if (!loaded.password) {
      throw new Error('FTP requires a password. Open the account manager and enter one.');
    }
    const access: ftp.AccessOptions = {
      host: loaded.profile.host,
      port: loaded.profile.port || 21,
      user: loaded.profile.username,
      password: loaded.password,
      secure: loaded.profile.secure === true
    };
    this.logger.append('info', `Connecting to ${loaded.profile.username}@${loaded.profile.host}:${access.port} (${access.secure ? 'FTPS' : 'FTP'})…`);
    const client = new ftp.Client(15000);
    try {
      await client.access(access);
    } catch (error) {
      client.close();
      const message = error instanceof Error ? error.message : String(error);
      if (/530|login|password/i.test(message)) {
        throw new Error(`${message} — double-check the FTP username and password for ${loaded.profile.username}@${loaded.profile.host}.`);
      }
      throw new Error(message);
    }
    this.ftpClient = client;
    this.ftpAccess = access;
    this.ftpChain = Promise.resolve();
    this.ftpListCache.clear();
  }

  /** Lease a dedicated SFTP connection for a file transfer. */
  private async acquireSftpTransfer(): Promise<{ client: SftpClient; release(): void }> {
    for (;;) {
      if (!this.isConnected || !this.currentProfile) {
        throw new Error('Connect to the server first.');
      }
      const free = this.sftpPool.find((entry) => !entry.busy);
      if (free) {
        free.busy = true;
        return this.leaseOf(free);
      }
      if (this.sftpPool.length < this.maxTransferConnections) {
        const entry = { client: new SftpClient(), busy: true };
        this.sftpPool.push(entry);
        try {
          await this.connectSftpClient(entry.client, this.currentProfile);
        } catch (error) {
          this.sftpPool.splice(this.sftpPool.indexOf(entry), 1);
          this.poolWaiters.shift()?.();
          throw error;
        }
        return this.leaseOf(entry);
      }
      await new Promise<void>((resolve) => this.poolWaiters.push(resolve));
    }
  }

  /** Lease a dedicated FTP connection for a file transfer. */
  private async acquireFtpTransfer(): Promise<{ client: ftp.Client; release(): void }> {
    for (;;) {
      if (!this.isConnected || !this.ftpAccess) {
        throw new Error('Connect to the server first.');
      }
      const free = this.ftpPool.find((entry) => !entry.busy);
      if (free) {
        free.busy = true;
        if (free.client.closed) {
          free.client = new ftp.Client(15000);
          try {
            await free.client.access(this.ftpAccess);
          } catch (error) {
            this.ftpPool.splice(this.ftpPool.indexOf(free), 1);
            this.poolWaiters.shift()?.();
            throw error;
          }
        }
        return this.leaseOf(free);
      }
      if (this.ftpPool.length < this.maxTransferConnections) {
        const entry = { client: new ftp.Client(15000), busy: true };
        this.ftpPool.push(entry);
        try {
          await entry.client.access(this.ftpAccess);
        } catch (error) {
          this.ftpPool.splice(this.ftpPool.indexOf(entry), 1);
          this.poolWaiters.shift()?.();
          throw error;
        }
        return this.leaseOf(entry);
      }
      await new Promise<void>((resolve) => this.poolWaiters.push(resolve));
    }
  }

  private leaseOf<T>(entry: { client: T; busy: boolean }): { client: T; release(): void } {
    let released = false;
    return {
      client: entry.client,
      release: () => {
        if (!released) {
          released = true;
          entry.busy = false;
          this.poolWaiters.shift()?.();
        }
      }
    };
  }

  /** Serialize SFTP operations — one command at a time on the connection. */
  private runSftp<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.sftpChain.then(operation, operation);
    this.sftpChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Serialize an FTP operation and transparently reconnect if the server
   * closed the idle control connection (shared hosts do this aggressively).
   */
  private runFtp<T>(operation: (client: ftp.Client) => Promise<T>): Promise<T> {
    const next = this.ftpChain.then(async () => {
      if (!this.ftpClient || !this.ftpAccess) {
        throw new Error('Connect to the FTP server first.');
      }
      if (this.ftpClient.closed) {
        this.logger.append('info', 'FTP connection was closed by the server — reconnecting…');
        this.ftpClient.close();
        this.ftpClient = new ftp.Client(15000);
        await this.ftpClient.access(this.ftpAccess);
      }
      return operation(this.ftpClient);
    });
    this.ftpChain = next.catch(() => undefined);
    return next;
  }

  private async ftpList(remotePath: string): Promise<ftp.FileInfo[]> {
    const key = joinRemote(remotePath);
    const cached = this.ftpListCache.get(key);
    if (cached && Date.now() - cached.at < 4000) {
      return cached.listing;
    }
    const listing = await this.runFtp((client) => client.list(key));
    this.ftpListCache.set(key, { at: Date.now(), listing });
    return listing;
  }

  private ensureConnected(): void {
    if (!this.isConnected) {
      throw new Error('Connect to the server first.');
    }
  }

  private async ensureRemoteDirectory(remoteDirectory: string): Promise<void> {
    return this.ensureRemoteDirectoryOn(this.client, remoteDirectory);
  }

  private async ensureRemoteDirectoryOn(client: SftpClient, remoteDirectory: string): Promise<void> {
    if (!remoteDirectory || remoteDirectory === '/') {
      return;
    }
    await client.mkdir(remoteDirectory, true);
  }

  private toRelative(name: string, parent: string): string {
    const remoteBase = this.currentProfile?.profile.remotePath ?? '/';
    return normalizeRelative(joinRemote(parent.replace(remoteBase, ''), name));
  }

  /** Abortable SFTP upload with byte progress via streams. */
  private async streamSftpUpload(
    client: SftpClient,
    localPath: string,
    remotePath: string,
    total: number | undefined,
    onProgress?: (transferred: number, total?: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const streams = client as unknown as {
      createWriteStream(p: string, options?: unknown): NodeJS.WritableStream;
    };
    const source = createReadStream(localPath);
    if (onProgress) {
      let transferred = 0;
      source.on('data', (chunk: string | Buffer) => {
        transferred += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        onProgress(transferred, total);
      });
    }
    const destination = streams.createWriteStream(remotePath);
    if (signal) {
      await pipeline(source, destination, { signal });
    } else {
      await pipeline(source, destination);
    }
  }

  /** Abortable SFTP download with byte progress via streams. */
  private async streamSftpDownload(
    client: SftpClient,
    remotePath: string,
    localPath: string,
    total: number | undefined,
    onProgress?: (transferred: number, total?: number) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const streams = client as unknown as {
      createReadStream(p: string, options?: unknown): NodeJS.ReadableStream;
    };
    const source = streams.createReadStream(remotePath);
    if (onProgress) {
      let transferred = 0;
      source.on('data', (chunk: string | Buffer) => {
        transferred += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        onProgress(transferred, total);
      });
    }
    const destination = createWriteStream(localPath);
    if (signal) {
      await pipeline(source, destination, { signal });
    } else {
      await pipeline(source, destination);
    }
  }

  /** Set the remote file's mtime to match the local edit time (best-effort). */
  private async setSftpTimes(client: SftpClient, remotePath: string, mtime: Date): Promise<void> {
    try {
      const wrapper = (client as unknown as {
        sftp?: { utimes(p: string, atime: number, mtime: number, cb: (err: Error | null | undefined) => void): void };
      }).sftp;
      if (!wrapper?.utimes) {
        return;
      }
      const seconds = Math.floor(mtime.getTime() / 1000);
      await new Promise<void>((resolve) => wrapper.utimes(remotePath, seconds, seconds, () => resolve()));
    } catch {
      // Timestamp preservation must never fail the upload itself.
    }
  }

  private isIgnoredRemote(remoteEntryPath: string): boolean {
    if (!this.ignoreFilter) {
      return false;
    }
    const relative = this.toRelative('', remoteEntryPath);
    return relative ? this.ignoreFilter(relative) : false;
  }
}

/**
 * Create every missing segment of a remote directory using absolute MKD
 * commands. basic-ftp's ensureDir walks with cwd changes, which fails with
 * "550 Not a directory" errors on some servers; this variant never cds.
 */
async function ensureFtpDirectory(client: ftp.Client, remoteDirectory: string): Promise<void> {
  const normalized = joinRemote(remoteDirectory);
  if (normalized === '/') {
    return;
  }
  let current = '';
  for (const segment of normalized.split('/').filter(Boolean)) {
    current += `/${segment}`;
    try {
      await client.send(`MKD ${current}`);
    } catch {
      // Already exists (or a race with another pooled connection) — fine.
    }
  }
}

/** True when an upload failed because a path segment is not a usable directory. */
function isBlockedPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not a directory|553|550/i.test(message);
}

/**
 * Walk every segment of a remote directory path and repair the one that is
 * blocked by a FILE with the folder's name: junk zero-byte files (left behind
 * when a directory path was STORed as a file) are deleted and replaced with a
 * real directory; non-empty files raise a clear error instead of silently
 * destroying data.
 */
async function healBlockedFtpPath(
  client: ftp.Client,
  remoteDirectory: string,
  logger: Logger,
  originalError: unknown
): Promise<void> {
  const normalized = joinRemote(remoteDirectory);
  if (normalized === '/') {
    throw originalError instanceof Error ? originalError : new Error(String(originalError));
  }
  let current = '';
  for (const segment of normalized.split('/').filter(Boolean)) {
    current += `/${segment}`;
    try {
      await client.send(`MKD ${current}`);
      continue; // Freshly created — nothing was blocking this segment.
    } catch {
      // Exists (as directory or file) — inspect below.
    }
    try {
      await client.cd(current);
      await client.cd('/');
      continue; // Healthy directory.
    } catch {
      // Not enterable — a file occupies this name.
    }
    let size: number | undefined;
    try {
      size = await client.size(current);
    } catch {
      size = undefined;
    }
    if (size === 0) {
      logger.append('warn', `Removing zero-byte file ${current} that was blocking folder creation on the server.`);
      await client.remove(current);
      await client.send(`MKD ${current}`);
      continue;
    }
    throw new Error(`Cannot create folder ${current}: a FILE with that name exists on the server${size ? ` (${size} bytes)` : ''}. Delete or rename it, then retry the upload.`);
  }
}

/** "rwx" triplets from SFTP listings → octal digits ("644"). */
function rightsToOctal(rights?: { user?: string; group?: string; other?: string }): string | undefined {
  if (!rights) {
    return undefined;
  }
  const digit = (part?: string): number =>
    (part?.includes('r') ? 4 : 0) + (part?.includes('w') ? 2 : 0) + (part?.includes('x') ? 1 : 0);
  return `${digit(rights.user)}${digit(rights.group)}${digit(rights.other)}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Transfer stopped before it started.');
  }
}

/** UTC timestamp in the YYYYMMDDHHMMSS format the FTP MFMT command expects. */
function toMfmtStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}
