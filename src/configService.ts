import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { escape as escapeMinimatch } from 'minimatch';
import { IgnoreMatcher } from './ignoreMatcher';
import { isChildOrSame, joinRemote, normalizeRelative, relativeTo } from './pathUtils';
import { AutoSyncMode, LoadedProfile, SftpProfile, StoredSecretPayload } from './types';

const PROFILE_KEY = 'sftpCompanion.profile';
const SECRET_KEY = 'sftpCompanion.secret';
// Which named profile (sftp.json "profiles" key) is active — per workspace.
const ACTIVE_PROFILE_NAME_KEY = 'sftpCompanion.activeProfileName';

/** Conservative defaults for a brand-new account's auto-sync boundary. */
export const DEFAULT_SECURITY_IGNORE_PATTERNS = [
  '.git',
  '.gitignore',
  '.vscode',
  '.env',
  '.env.*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.docker/config.json',
  '.composer/auth.json',
  'auth.json',
  '.htpasswd',
  '.secrets',
  'secrets.*',
  'credentials',
  'credentials.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.ppk',
  '*.jks',
  '*.keystore',
  '*.kdbx',
  'service-account*.json',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  '_notes'
] as const;

/** Root-anchored minimatch pattern that represents one literal path. */
function literalIgnorePattern(relativePath: string): string {
  const normalized = normalizeRelative(relativePath);
  const escaped = escapeMinimatch(normalized)
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
  return `/${escaped}`;
}

/** Secrets are keyed per server+user so profiles and projects share them. */
function secretKeyFor(host: string, username: string): string {
  return `${SECRET_KEY}:${host}:${username}`;
}

function hasPlaintextSecret(value: Partial<SftpJsonShape>): boolean {
  return (typeof value.password === 'string' && value.password.length > 0)
    || (typeof value.passphrase === 'string' && value.passphrase.length > 0);
}

// .vscode/sftp.json must stay a valid config for the Natizyskunk/liximomo SFTP
// extension (it validates its schema), so companion-only metadata lives in
// .vscode/sftp-companion.json instead of being mixed into sftp.json.
interface SftpJsonShape {
  [key: string]: unknown;
  name?: string;
  host?: string;
  protocol?: string;
  secure?: boolean | string;
  port?: number;
  username?: string;
  password?: string;
  passphrase?: string | boolean;
  privateKeyPath?: string;
  remotePath?: string;
  context?: string;
  uploadOnSave?: boolean;
  ignore?: string[];
  watcher?: {
    files?: string | string[];
    autoUpload?: boolean;
    autoDelete?: boolean;
  };
  // Named connection profiles (Natizyskunk-compatible): each entry overrides
  // the top-level connection fields. Hand-edited; switched via the picker.
  profiles?: Record<string, Partial<SftpJsonShape>>;
  defaultProfile?: string;
  // Legacy keys written by older SFTP Companion builds; read for migration only.
  syncFolder?: string;
  syncWhitelist?: string[];
  showHiddenFiles?: boolean;
  autoSyncMode?: AutoSyncMode;
}

interface CompanionJsonShape {
  [key: string]: unknown;
  context?: string;
  syncFolder?: string;
  autoSyncMode?: AutoSyncMode;
  syncWhitelist?: string[];
  showHiddenFiles?: boolean;
}

export class ConfigService {
  private ignoreMatcher = new IgnoreMatcher([], []);
  private activeProfile?: LoadedProfile;
  private filePassword?: string;
  private filePassphrase?: string;
  private hasWorkspacePlaintextSecrets = false;
  private availableProfileNames: string[] = [];
  private activeProfileName?: string;
  private workspaceMutationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: { append(level: 'info' | 'warn' | 'error', message: string): void }
  ) {}

  public loadActiveProfile(): Promise<LoadedProfile | undefined> {
    return this.enqueueWorkspaceMutation(() => this.loadActiveProfileUnlocked());
  }

  private async loadActiveProfileUnlocked(): Promise<LoadedProfile | undefined> {
    const workspaceConfig = await this.readWorkspaceConfig();
    if (workspaceConfig) {
      const loaded = await this.inflateProfile(workspaceConfig, 'workspaceFile');
      this.setActive(loaded);
      // Absorb credentials found in the file (legacy builds, or a password the
      // user pasted in by hand to change it) into SecretStorage, then rewrite
      // the file without them. Hand-editing still works: paste a password into
      // sftp.json, it becomes the active secret and the file is scrubbed.
      if (this.hasWorkspacePlaintextSecrets) {
        // Preserve the exact hand-edited topology during automatic migration:
        // only successfully vaulted plaintext fields are removed.
        const migrated = await this.migrateAndScrubWorkspaceSecrets();
        this.filePassword = undefined;
        this.filePassphrase = undefined;
        this.hasWorkspacePlaintextSecrets = false;
        if (migrated) {
          this.logger.append('info', 'Moved plaintext credentials out of sftp.json into secure storage (OS credential vault). Everything else in the file stays hand-editable.');
        }
      }
      return loaded;
    }

    const stored = this.context.workspaceState.get<SftpProfile>(PROFILE_KEY);
    if (stored) {
      const loaded = await this.inflateProfile(stored, 'legacyState');
      this.setActive(loaded);
      return loaded;
    }

    this.activeProfile = undefined;
    this.ignoreMatcher = new IgnoreMatcher([], []);
    return undefined;
  }

  public async saveProfile(profile: SftpProfile, secret: StoredSecretPayload): Promise<void> {
    const targetProfileName = this.activeProfileName;
    const snapshot = this.cloneProfile(profile);
    await this.enqueueWorkspaceMutation(async () => {
      await this.writeWorkspaceConfigUnlocked(snapshot, targetProfileName, secret);
      await this.context.workspaceState.update(PROFILE_KEY, undefined);
      if (this.activeProfileName === targetProfileName) {
        this.setActive({
          profile: snapshot,
          password: secret.password,
          passphrase: secret.passphrase,
          source: 'workspaceFile'
        });
      }
    });
    this.logger.append('info', 'Saved .vscode/sftp.json and sftp-companion.json.');
  }

  public async generateWorkspaceConfig(): Promise<vscode.Uri | undefined> {
    const loaded = this.activeProfile ?? await this.loadActiveProfile();
    if (!loaded) {
      vscode.window.showWarningMessage('Create or import an SFTP account first.');
      return undefined;
    }

    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      vscode.window.showWarningMessage('Open a workspace folder before generating sftp.json.');
      return undefined;
    }

    const target = await this.writeWorkspaceConfig(loaded.profile);
    const uri = vscode.Uri.file(target);
    await vscode.window.showTextDocument(uri);
    this.logger.append('info', 'Updated .vscode/sftp.json from the account manager.');
    return uri;
  }

  public async openWorkspaceConfig(): Promise<vscode.Uri | undefined> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      vscode.window.showWarningMessage('Open a workspace folder before editing sftp.json.');
      return undefined;
    }

    const target = path.join(workspace.uri.fsPath, '.vscode', 'sftp.json');
    try {
      await fs.access(target);
      const uri = vscode.Uri.file(target);
      await vscode.window.showTextDocument(uri);
      return uri;
    } catch {
      return this.generateWorkspaceConfig();
    }
  }

  public getCurrentProfile(): LoadedProfile | undefined {
    return this.activeProfile;
  }

  /** Identity captured by queued transfers so they cannot cross profiles. */
  public getOperationContextKey(): string | undefined {
    const loaded = this.activeProfile;
    const root = this.getLocalRoot();
    if (!loaded || !root) {
      return undefined;
    }
    const profile = loaded.profile;
    return JSON.stringify([
      this.activeProfileName ?? '',
      root.fsPath,
      profile.host,
      profile.port,
      profile.protocol,
      profile.secure === true,
      profile.username,
      joinRemote(profile.remotePath || '/'),
      profile.authMode,
      profile.privateKeyPath ?? ''
    ]);
  }

  /** Named profiles declared in sftp.json's "profiles" block. */
  public getProfileNames(): string[] {
    return [...this.availableProfileNames];
  }

  /** Active named profile, or undefined when the base config is in use. */
  public getActiveProfileName(): string | undefined {
    return this.activeProfileName;
  }

  /** Switch to a named profile (or undefined for base) and reload. */
  public async selectProfile(name: string | undefined): Promise<void> {
    await this.enqueueWorkspaceMutation(async () => {
      await this.context.workspaceState.update(ACTIVE_PROFILE_NAME_KEY, name);
      await this.loadActiveProfileUnlocked();
    });
  }

  public getLocalRoot(): vscode.Uri | undefined {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    const profile = this.activeProfile?.profile;
    if (!workspace || !profile) {
      return workspace?.uri;
    }

    const base = path.resolve(workspace.uri.fsPath, profile.context || '.');
    const root = path.resolve(base, profile.syncFolder || '.');
    return vscode.Uri.file(root);
  }

  public getAllowedRoots(): string[] {
    const localRoot = this.getLocalRoot();
    const profile = this.activeProfile?.profile;
    if (!localRoot || !profile) {
      return [];
    }

    if (profile.autoSyncMode === 'manual') {
      return [];
    }

    if (profile.autoSyncMode === 'root') {
      return [localRoot.fsPath];
    }

    return profile.whitelist.map((entry) => path.resolve(localRoot.fsPath, normalizeRelative(entry)));
  }

  public getAutoSyncMode(): AutoSyncMode {
    return this.activeProfile?.profile.autoSyncMode ?? 'manual';
  }

  public async setAutoSyncMode(mode: AutoSyncMode): Promise<void> {
    const updated = await this.mutateActiveProfile((loaded) => ({
      profile: { ...loaded.profile, autoSyncMode: mode },
      result: true
    }));
    if (!updated) {
      vscode.window.showWarningMessage('Configure sftp.json before changing auto-sync mode.');
    }
  }

  public getShowHidden(): boolean {
    // Single source of truth: sftp-companion.json (edited via the account
    // manager). The old duplicate VS Code setting was removed — it silently
    // lost to the file and made the Settings UI lie about the actual state.
    return this.activeProfile?.profile.showHiddenFiles ?? false;
  }

  /**
   * Whether this path is covered by auto-sync: everything in "root" mode, or
   * a sync-list entry / anything inside one in "whitelist" mode.
   */
  public isAutoSynced(relativePath: string): boolean {
    const profile = this.activeProfile?.profile;
    if (!profile || profile.autoSyncMode === 'manual') {
      return false;
    }
    const normalized = normalizeRelative(relativePath);
    if (this.ignoreMatcher.isIgnored(normalized)) {
      return false;
    }
    if (profile.autoSyncMode === 'root') {
      return true;
    }
    return profile.whitelist.some((entry) => isChildOrSame(normalized, normalizeRelative(entry)));
  }

  public isWhitelisted(relativePath: string): boolean {
    const normalized = normalizeRelative(relativePath);
    if (!normalized) {
      return false;
    }
    return (this.activeProfile?.profile.whitelist ?? []).some((entry) => normalizeRelative(entry) === normalized);
  }

  public async toggleWhitelistEntry(relativePath: string): Promise<void> {
    const target = normalizeRelative(relativePath);
    const updated = await this.mutateActiveProfile((loaded) => {
      const current = loaded.profile.whitelist.map((entry) => normalizeRelative(entry));
      const whitelist = current.includes(target)
        ? current.filter((entry) => entry !== target)
        : [...current, target].sort((left, right) => left.localeCompare(right));
      return { profile: { ...loaded.profile, whitelist }, result: true };
    });
    if (!updated) {
      vscode.window.showWarningMessage('Configure sftp.json before tagging whitelist items.');
    }
  }

  /** Add or remove an exact path from the ignore patterns. */
  public async toggleIgnoreEntry(relativePath: string): Promise<boolean> {
    const target = normalizeRelative(relativePath);
    const exactPattern = literalIgnorePattern(target);
    const result = await this.mutateActiveProfile((loaded) => {
      const exists = loaded.profile.ignore.some((entry) => entry === exactPattern || normalizeRelative(entry) === target);
      const ignore = exists
        ? loaded.profile.ignore.filter((entry) => entry !== exactPattern && normalizeRelative(entry) !== target)
        : [...loaded.profile.ignore, exactPattern];
      return { profile: { ...loaded.profile, ignore }, result: !exists };
    });
    if (result === undefined) {
      vscode.window.showWarningMessage('Configure sftp.json before ignoring items.');
      return false;
    }
    return result;
  }

  /** Persist one or more exact paths as ignored in a single config write. */
  public async addIgnoreEntries(relativePaths: readonly string[]): Promise<string[]> {
    const result = await this.mutateActiveProfile((loaded) => {
      const ignore = [...loaded.profile.ignore];
      const currentSet = new Set(ignore);
      const added: string[] = [];
      for (const relativePath of relativePaths) {
        const target = normalizeRelative(relativePath);
        const exactPattern = literalIgnorePattern(target);
        if (target && !currentSet.has(exactPattern)) {
          currentSet.add(exactPattern);
          ignore.push(exactPattern);
          added.push(target);
        }
      }
      return { profile: { ...loaded.profile, ignore }, result: added };
    });
    if (result === undefined) {
      vscode.window.showWarningMessage('Configure sftp.json before ignoring items.');
      return [];
    }
    return result;
  }

  public resolveRemotePath(relativePath: string): string {
    const remoteBase = this.activeProfile?.profile.remotePath ?? '/';
    const normalized = normalizeRelative(relativePath);
    if (normalized.split('/').includes('..')) {
      throw new Error(`Refusing remote path outside the configured root: ${relativePath}`);
    }
    return joinRemote(remoteBase, normalized);
  }

  public resolveLocalPath(relativePath: string): string | undefined {
    const root = this.getLocalRoot();
    if (!root) {
      return undefined;
    }
    const resolved = path.resolve(root.fsPath, normalizeRelative(relativePath));
    const fromRoot = path.relative(root.fsPath, resolved);
    if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
      return undefined;
    }
    return resolved;
  }

  /**
   * Resolve a sync-root path and verify the nearest existing ancestor still
   * resolves inside the canonical root. This blocks downloads/deletes from
   * following a junction or symlink out of the workspace.
   */
  public async resolveSafeLocalPath(relativePath: string): Promise<string | undefined> {
    const root = this.getLocalRoot();
    const resolved = this.resolveLocalPath(relativePath);
    if (!root || !resolved) {
      return undefined;
    }

    const [canonicalRoot, canonicalResolved] = await Promise.all([
      this.canonicalProspectivePath(root.fsPath),
      this.canonicalProspectivePath(resolved)
    ]);
    if (!canonicalRoot || !canonicalResolved) {
      return undefined;
    }
    const fromRoot = path.relative(canonicalRoot, canonicalResolved);
    return fromRoot !== '..' && !fromRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(fromRoot)
      ? resolved
      : undefined;
  }

  /** Resolve an internal workspace cache path without following links outside it. */
  public async resolveSafeWorkspacePath(relativePath: string): Promise<string | undefined> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
      return undefined;
    }
    const normalized = normalizeRelative(relativePath);
    if (normalized.split('/').includes('..')) {
      return undefined;
    }
    const resolved = path.resolve(workspace.uri.fsPath, normalized);
    const lexical = path.relative(workspace.uri.fsPath, resolved);
    if (lexical === '..' || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) {
      return undefined;
    }
    const [canonicalWorkspace, canonicalResolved] = await Promise.all([
      this.canonicalProspectivePath(workspace.uri.fsPath),
      this.canonicalProspectivePath(resolved)
    ]);
    if (!canonicalWorkspace || !canonicalResolved) {
      return undefined;
    }
    const canonicalRelative = path.relative(canonicalWorkspace, canonicalResolved);
    return canonicalRelative !== '..'
      && !canonicalRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(canonicalRelative)
      ? resolved
      : undefined;
  }

  /** True for files beneath the extension's configured compare/edit cache. */
  public isInternalRemoteCachePath(localPath: string): boolean {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      return false;
    }
    const base = vscode.workspace.getConfiguration('sftpCompanion')
      .get<string>('tempRemoteCachePath', '.vscode/.sftp-companion-cache');
    const cacheRoot = path.resolve(workspace.uri.fsPath, base);
    const cacheFromWorkspace = path.relative(workspace.uri.fsPath, cacheRoot);
    if (cacheFromWorkspace === '..'
      || cacheFromWorkspace.startsWith(`..${path.sep}`)
      || path.isAbsolute(cacheFromWorkspace)) {
      return false;
    }
    const fromCache = path.relative(cacheRoot, path.resolve(localPath));
    return fromCache !== '..'
      && !fromCache.startsWith(`..${path.sep}`)
      && !path.isAbsolute(fromCache);
  }

  /** Revalidate an absolute transfer path immediately before queue execution. */
  public async isSafeTransferLocalPath(localPath: string, requireInsideRoot: boolean): Promise<boolean> {
    const root = this.getLocalRoot();
    if (!root) {
      return false;
    }
    const resolved = path.resolve(localPath);
    const fromRoot = path.relative(root.fsPath, resolved);
    const insideRoot = fromRoot !== '..'
      && !fromRoot.startsWith(`..${path.sep}`)
      && !path.isAbsolute(fromRoot);
    if (!insideRoot) {
      return !requireInsideRoot;
    }
    const safe = await this.resolveSafeLocalPath(fromRoot || '.');
    return safe !== undefined && path.resolve(safe) === resolved;
  }

  public toRelativeLocalPath(filePath: string): string | undefined {
    const root = this.getLocalRoot();
    if (!root) {
      return undefined;
    }
    const relative = relativeTo(root.fsPath, filePath);
    if (relative.startsWith('..')) {
      return undefined;
    }
    // Only ignore patterns hide paths here. The whitelist must NOT filter this
    // mapping — the local tree uses it for browsing, and hiding non-whitelisted
    // siblings would make it impossible to tag additional folders. Auto-upload
    // whitelist gating happens in SyncWatcher via getAllowedRoots().
    if (this.ignoreMatcher.isIgnored(relative)) {
      return undefined;
    }
    return relative;
  }

  public getIgnoreMatcher(): IgnoreMatcher {
    return this.ignoreMatcher;
  }

  private async readWorkspaceConfig(): Promise<SftpProfile | undefined> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      return undefined;
    }
    const sftpJsonPath = path.join(workspace.uri.fsPath, '.vscode', 'sftp.json');
    const companionPath = path.join(workspace.uri.fsPath, '.vscode', 'sftp-companion.json');
    this.filePassword = undefined;
    this.filePassphrase = undefined;
    this.hasWorkspacePlaintextSecrets = false;
    try {
      const raw = await fs.readFile(sftpJsonPath, 'utf8');
      const base = JSON.parse(raw) as SftpJsonShape;
      this.hasWorkspacePlaintextSecrets = hasPlaintextSecret(base)
        || Object.values(base.profiles ?? {}).some((entry) => hasPlaintextSecret(entry));

      // Overlay the active named profile (if any) onto the base connection.
      this.availableProfileNames = base.profiles ? Object.keys(base.profiles) : [];
      const requested = this.context.workspaceState.get<string>(ACTIVE_PROFILE_NAME_KEY) ?? base.defaultProfile;
      const overlay = requested && base.profiles ? base.profiles[requested] : undefined;
      this.activeProfileName = overlay ? requested : undefined;
      const parsed: SftpJsonShape = overlay ? { ...base, ...overlay } : base;

      // remotePath is optional: many FTP accounts land in the right folder by
      // default, so an absent remotePath simply means the server root ('/').
      if (!parsed.host || !parsed.username) {
        return undefined;
      }

      let companion: CompanionJsonShape = {};
      try {
        companion = JSON.parse(await fs.readFile(companionPath, 'utf8')) as CompanionJsonShape;
      } catch {
        // No companion file yet — fall back to legacy keys inside sftp.json.
      }

      this.filePassword = typeof parsed.password === 'string' && parsed.password ? parsed.password : undefined;
      this.filePassphrase = typeof parsed.passphrase === 'string' && parsed.passphrase ? parsed.passphrase : undefined;

      const protocol = parsed.protocol === 'ftp' ? 'ftp' : 'sftp';
      return {
        host: parsed.host,
        port: parsed.port ?? (protocol === 'ftp' ? 21 : 22),
        protocol,
        secure: parsed.secure === true || parsed.secure === 'control',
        username: parsed.username,
        remotePath: parsed.remotePath || '/',
        context: companion.context ?? parsed.context ?? '.',
        syncFolder: companion.syncFolder ?? parsed.syncFolder ?? '.',
        ignore: parsed.ignore ?? [...DEFAULT_SECURITY_IGNORE_PATTERNS],
        whitelist: companion.syncWhitelist ?? parsed.syncWhitelist ?? [],
        authMode: protocol === 'sftp' && parsed.privateKeyPath ? 'privateKey' : 'password',
        privateKeyPath: parsed.privateKeyPath,
        showHiddenFiles: companion.showHiddenFiles ?? parsed.showHiddenFiles ?? false,
        autoSyncMode: companion.autoSyncMode
          ?? parsed.autoSyncMode
          ?? (parsed.uploadOnSave ? 'root' : parsed.watcher?.autoUpload ? 'whitelist' : 'manual')
      };
    } catch {
      return undefined;
    }
  }

  private async inflateProfile(profile: SftpProfile, source: LoadedProfile['source']): Promise<LoadedProfile> {
    // Per-server secret first (shared across projects/profiles pointing at the
    // same host+user); the legacy single-slot key covers pre-profile installs.
    const secretRaw = await this.context.secrets.get(secretKeyFor(profile.host, profile.username))
      ?? await this.context.secrets.get(SECRET_KEY);
    const secret = secretRaw ? JSON.parse(secretRaw) as StoredSecretPayload : {};
    return {
      // Profiles saved by pre-FTP builds have no protocol key — assume SFTP.
      profile: { ...profile, protocol: profile.protocol ?? 'sftp' },
      // Hand-edits to sftp.json win over SecretStorage so both stay usable.
      password: this.filePassword ?? secret.password,
      passphrase: this.filePassphrase ?? secret.passphrase ?? profile.passphrase,
      source
    };
  }

  private writeWorkspaceConfig(profile: SftpProfile, explicitSecret?: StoredSecretPayload): Promise<string> {
    const snapshot = this.cloneProfile(profile);
    const targetProfileName = this.activeProfileName;
    return this.enqueueWorkspaceMutation(() => this.writeWorkspaceConfigUnlocked(snapshot, targetProfileName, explicitSecret));
  }

  private async writeWorkspaceConfigUnlocked(
    profile: SftpProfile,
    targetProfileName: string | undefined,
    explicitSecret?: StoredSecretPayload
  ): Promise<string> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      throw new Error('Open a workspace folder before saving sftp.json.');
    }

    const vscodeDir = path.join(workspace.uri.fsPath, '.vscode');
    await fs.mkdir(vscodeDir, { recursive: true });
    const target = path.join(vscodeDir, 'sftp.json');
    const companionTarget = path.join(vscodeDir, 'sftp-companion.json');

    // The file may hold hand-edited named profiles — read it so they survive.
    let existing: SftpJsonShape = {};
    let existingRaw: string | undefined;
    try {
      existingRaw = await fs.readFile(target, 'utf8');
      existing = JSON.parse(existingRaw) as SftpJsonShape;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot safely update ${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let existingCompanion: CompanionJsonShape = {};
    let existingCompanionRaw: string | undefined;
    try {
      existingCompanionRaw = await fs.readFile(companionTarget, 'utf8');
      existingCompanion = JSON.parse(existingCompanionRaw) as CompanionJsonShape;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot safely update ${companionTarget}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Migrate every effective base/named plaintext credential before anything
    // is removed from disk. A failed vault write aborts the JSON rewrite.
    const explicitSecretKey = explicitSecret ? secretKeyFor(profile.host, profile.username) : undefined;
    const previousExplicitSecret = explicitSecretKey
      ? await this.context.secrets.get(explicitSecretKey)
      : undefined;
    const migrated = await this.migrateWorkspaceSecrets(existing);
    if (explicitSecret) {
      await this.context.secrets.store(explicitSecretKey!, JSON.stringify(explicitSecret));
      // One vault entry represents one host+username identity. An explicit
      // Account Manager save resolves any conflicting inline copies for that
      // same identity, so none can override the new vault value on reload.
      if (existing.host && existing.username
        && secretKeyFor(existing.host, existing.username) === explicitSecretKey) {
        migrated.scrubBase = true;
      }
      for (const [name, entry] of Object.entries(existing.profiles ?? {})) {
        const effective = { ...existing, ...entry };
        if (effective.host && effective.username
          && secretKeyFor(effective.host, effective.username) === explicitSecretKey) {
          migrated.scrubProfiles.add(name);
        }
      }
      if (targetProfileName) {
        migrated.scrubProfiles.add(targetProfileName);
      } else {
        migrated.scrubBase = true;
      }
    }

    // sftp.json context = context + syncFolder combined, so the SFTP engine's
    // local root matches SFTP Companion's sync root exactly.
    const combinedContext = normalizeRelative(path.posix.join(
      normalizeRelative(profile.context || '.') || '.',
      normalizeRelative(profile.syncFolder || '.') || '.'
    ));

    // Keep every hand-edited/third-party key we do not manage. Managed fields
    // are rebuilt below, while plaintext credentials and migrated legacy keys
    // are deliberately scrubbed.
    const {
      name: _name,
      host: _host,
      protocol: _protocol,
      secure: _secure,
      port: _port,
      username: _username,
      password: _password,
      passphrase: _passphrase,
      privateKeyPath: _privateKeyPath,
      remotePath: _remotePath,
      context: _context,
      uploadOnSave: _uploadOnSave,
      ignore: _ignore,
      profiles: _profiles,
      defaultProfile: _defaultProfile,
      syncFolder: _legacySyncFolder,
      syncWhitelist: _legacySyncWhitelist,
      showHiddenFiles: _legacyShowHiddenFiles,
      autoSyncMode: _legacyAutoSyncMode,
      ...preservedTopLevel
    } = existing;
    const config: SftpJsonShape = {
      ...preservedTopLevel,
      // sftp.json keeps the standard schema (name required) so the file stays
      // portable, but auto-sync always runs through the built-in watcher —
      // uploadOnSave stays off so no other tool double-uploads.
      name: profile.host,
      host: profile.host,
      protocol: profile.protocol === 'ftp' ? 'ftp' : 'sftp',
      port: profile.port,
      username: profile.username,
      remotePath: profile.remotePath || '/',
      uploadOnSave: false,
      ignore: profile.ignore
    };
    if (profile.protocol === 'ftp' && profile.secure) {
      config.secure = true;
    }
    if (combinedContext && combinedContext !== '.') {
      config.context = `./${combinedContext}`;
    }

    // Credentials never go into the file — the password and key passphrase
    // live only in VS Code SecretStorage (the OS credential vault). Everything
    // else stays hand-editable in sftp.json / sftp-companion.json.
    if (profile.protocol !== 'ftp' && profile.authMode === 'privateKey') {
      config.privateKeyPath = profile.privateKeyPath;
    }
    if (!migrated.scrubBase && existing.password !== undefined) {
      config.password = existing.password;
    }
    if (typeof existing.passphrase !== 'string' || !migrated.scrubBase) {
      config.passphrase = existing.passphrase;
    }

    // Keep the base connection untouched while a named profile is active. The
    // effective Account Manager values are written back to that named entry.
    if (targetProfileName && existing.host) {
      config.name = existing.name ?? existing.host;
      config.host = existing.host;
      config.port = existing.port;
      config.protocol = existing.protocol;
      config.secure = existing.secure;
      config.username = existing.username;
      config.remotePath = existing.remotePath;
      config.privateKeyPath = existing.privateKeyPath;
      config.ignore = existing.ignore ?? profile.ignore;
      if (existing.context) {
        config.context = existing.context;
      } else {
        delete config.context;
      }
    }

    // Preserve unknown named-profile keys and scrub plaintext only after its
    // effective credential was safely stored in SecretStorage.
    if (existing.profiles) {
      const preserved: Record<string, Partial<SftpJsonShape>> = {};
      for (const [name, entry] of Object.entries(existing.profiles)) {
        if (name === targetProfileName) {
          const {
            host: _entryHost,
            protocol: _entryProtocol,
            secure: _entrySecure,
            port: _entryPort,
            username: _entryUsername,
            password: _entryPassword,
            passphrase: _entryPassphrase,
            privateKeyPath: _entryPrivateKeyPath,
            remotePath: _entryRemotePath,
            uploadOnSave: _entryUploadOnSave,
            ignore: _entryIgnore,
            ...unknownEntry
          } = entry;
          const updated: Partial<SftpJsonShape> = {
            ...unknownEntry,
            host: profile.host,
            protocol: profile.protocol === 'ftp' ? 'ftp' : 'sftp',
            port: profile.port,
            username: profile.username,
            remotePath: profile.remotePath || '/',
            uploadOnSave: false,
            ignore: profile.ignore
          };
          if (profile.protocol === 'ftp' && profile.secure) {
            updated.secure = true;
          }
          if (profile.protocol !== 'ftp' && profile.authMode === 'privateKey') {
            updated.privateKeyPath = profile.privateKeyPath;
          }
          if (typeof _entryPassphrase === 'boolean') {
            updated.passphrase = _entryPassphrase;
          }
          if (!migrated.scrubProfiles.has(name)) {
            updated.password = _entryPassword;
            if (typeof _entryPassphrase === 'string') {
              updated.passphrase = _entryPassphrase;
            }
          }
          preserved[name] = updated;
        } else if (migrated.scrubProfiles.has(name)) {
          const { password: _entryPassword, passphrase: entryPassphrase, ...rest } = entry;
          preserved[name] = typeof entryPassphrase === 'string'
            ? rest
            : { ...rest, passphrase: entryPassphrase };
        } else {
          preserved[name] = entry;
        }
      }
      config.profiles = preserved;
    }
    if (existing.defaultProfile !== undefined) {
      config.defaultProfile = existing.defaultProfile;
    }

    const {
      password: _companionPassword,
      passphrase: _companionPassphrase,
      ...preservedCompanion
    } = existingCompanion;
    const companion: CompanionJsonShape = {
      ...preservedCompanion,
      context: profile.context,
      syncFolder: profile.syncFolder,
      autoSyncMode: profile.autoSyncMode,
      syncWhitelist: profile.whitelist,
      showHiddenFiles: profile.showHiddenFiles ?? false
    };

    try {
      await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      await fs.writeFile(companionTarget, `${JSON.stringify(companion, null, 2)}\n`, 'utf8');
    } catch (error) {
      const rollbackErrors: string[] = [];
      const restoreFile = async (filePath: string, previous: string | undefined): Promise<void> => {
        try {
          if (previous === undefined) {
            await fs.rm(filePath, { force: true });
          } else {
            await fs.writeFile(filePath, previous, 'utf8');
          }
        } catch (rollbackError) {
          rollbackErrors.push(`${filePath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      };
      await restoreFile(target, existingRaw);
      await restoreFile(companionTarget, existingCompanionRaw);
      if (explicitSecretKey) {
        try {
          if (previousExplicitSecret === undefined) {
            await this.context.secrets.delete(explicitSecretKey);
          } else {
            await this.context.secrets.store(explicitSecretKey, previousExplicitSecret);
          }
        } catch (rollbackError) {
          rollbackErrors.push(`credential vault: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      const rollbackMessage = rollbackErrors.length
        ? ` Rollback also failed for ${rollbackErrors.join('; ')}.`
        : '';
      throw new Error(`Could not save the SFTP configuration: ${error instanceof Error ? error.message : String(error)}.${rollbackMessage}`);
    }
    return target;
  }

  private async migrateAndScrubWorkspaceSecrets(): Promise<boolean> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      return false;
    }
    const target = path.join(workspace.uri.fsPath, '.vscode', 'sftp.json');
    const existingRaw = await fs.readFile(target, 'utf8');
    const existing = JSON.parse(existingRaw) as SftpJsonShape;
    const migrated = await this.migrateWorkspaceSecrets(existing);
    if (!migrated.scrubBase && migrated.scrubProfiles.size === 0) {
      return false;
    }
    const scrubbed: SftpJsonShape = { ...existing };
    if (migrated.scrubBase) {
      delete scrubbed.password;
      if (typeof scrubbed.passphrase === 'string') {
        delete scrubbed.passphrase;
      }
    }
    if (existing.profiles) {
      scrubbed.profiles = Object.fromEntries(Object.entries(existing.profiles).map(([name, entry]) => {
        if (!migrated.scrubProfiles.has(name)) {
          return [name, entry];
        }
        const sanitized = { ...entry };
        delete sanitized.password;
        if (typeof sanitized.passphrase === 'string') {
          delete sanitized.passphrase;
        }
        return [name, sanitized];
      }));
    }
    try {
      await fs.writeFile(target, `${JSON.stringify(scrubbed, null, 2)}\n`, 'utf8');
    } catch (error) {
      await fs.writeFile(target, existingRaw, 'utf8').catch(() => undefined);
      throw error;
    }
    return true;
  }

  private async migrateWorkspaceSecrets(existing: SftpJsonShape): Promise<{
    scrubBase: boolean;
    scrubProfiles: Set<string>;
  }> {
    type SecretGroup = { payload: StoredSecretPayload; conflict: boolean };
    const groups = new Map<string, SecretGroup>();
    const addEffective = (effective: Partial<SftpJsonShape>): void => {
      if (!effective.host || !effective.username || !hasPlaintextSecret(effective)) {
        return;
      }
      const key = secretKeyFor(effective.host, effective.username);
      const candidate: StoredSecretPayload = {
        password: typeof effective.password === 'string' && effective.password.length > 0
          ? effective.password
          : undefined,
        passphrase: typeof effective.passphrase === 'string' && effective.passphrase.length > 0
          ? effective.passphrase
          : undefined
      };
      const group = groups.get(key) ?? { payload: {}, conflict: false };
      for (const field of ['password', 'passphrase'] as const) {
        const incoming = candidate[field];
        const current = group.payload[field];
        if (incoming && current && incoming !== current) {
          group.conflict = true;
        } else if (incoming) {
          group.payload[field] = incoming;
        }
      }
      groups.set(key, group);
    };

    addEffective(existing);
    for (const entry of Object.values(existing.profiles ?? {})) {
      addEffective({ ...existing, ...entry });
    }
    if ([...groups.values()].some((group) => group.conflict)) {
      this.logger.append('warn', 'Plaintext credentials were left in sftp.json because multiple profiles with the same host and username contain different secrets. Resolve the conflict in Account Manager before they can be migrated safely.');
      return { scrubBase: false, scrubProfiles: new Set<string>() };
    }
    for (const [key, group] of groups) {
      let stored: StoredSecretPayload = {};
      try {
        const raw = await this.context.secrets.get(key);
        stored = raw ? JSON.parse(raw) as StoredSecretPayload : {};
      } catch {
        // A malformed legacy vault value must not prevent a valid inline
        // credential from being secured and removed from the JSON file.
      }
      await this.context.secrets.store(key, JSON.stringify({ ...stored, ...group.payload }));
    }

    const scrubProfiles = new Set<string>();
    const scrubBase = hasPlaintextSecret(existing) && Boolean(existing.host && existing.username);
    for (const [name, entry] of Object.entries(existing.profiles ?? {})) {
      const effective = { ...existing, ...entry };
      if (hasPlaintextSecret(entry) && effective.host && effective.username) {
        scrubProfiles.add(name);
      }
    }
    return { scrubBase, scrubProfiles };
  }

  private enqueueWorkspaceMutation<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.workspaceMutationTail.then(operation);
    this.workspaceMutationTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async canonicalProspectivePath(target: string): Promise<string | undefined> {
    let nearest = target;
    while (true) {
      let nearestStat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        nearestStat = await fs.lstat(nearest);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          return undefined;
        }
        const parent = path.dirname(nearest);
        if (parent === nearest) {
          return undefined;
        }
        nearest = parent;
        continue;
      }
      // Reject the link itself, including dangling symlinks whose realpath
      // cannot be resolved, instead of climbing past it to a safe parent.
      if (nearestStat.isSymbolicLink()) {
        return undefined;
      }
      const canonicalNearest = await fs.realpath(nearest).catch(() => undefined);
      return canonicalNearest
        ? path.resolve(canonicalNearest, path.relative(nearest, target))
        : undefined;
    }
  }

  private mutateActiveProfile<T>(
    transform: (loaded: LoadedProfile) => { profile: SftpProfile; result: T }
  ): Promise<T | undefined> {
    return this.enqueueWorkspaceMutation(async () => {
      const loaded = this.activeProfile ?? await this.loadActiveProfileUnlocked();
      if (!loaded) {
        return undefined;
      }
      const transformed = transform(loaded);
      const snapshot = this.cloneProfile(transformed.profile);
      const targetProfileName = this.activeProfileName;
      const secret = { password: loaded.password, passphrase: loaded.passphrase };
      // A field-only mutation is not permission to resolve or overwrite a
      // conflicting shared host+username credential. Leave the vault alone.
      await this.writeWorkspaceConfigUnlocked(snapshot, targetProfileName);
      await this.context.workspaceState.update(PROFILE_KEY, undefined);
      if (this.activeProfileName === targetProfileName) {
        this.setActive({
          profile: snapshot,
          password: secret.password,
          passphrase: secret.passphrase,
          source: 'workspaceFile'
        });
      }
      this.logger.append('info', 'Saved .vscode/sftp.json and sftp-companion.json.');
      return transformed.result;
    });
  }

  private cloneProfile(profile: SftpProfile): SftpProfile {
    return {
      ...profile,
      ignore: [...profile.ignore],
      whitelist: [...profile.whitelist]
    };
  }

  private setActive(loaded: LoadedProfile): void {
    this.activeProfile = loaded;
    this.ignoreMatcher = new IgnoreMatcher(loaded.profile.ignore, loaded.profile.whitelist.map((entry) => normalizeRelative(entry)));
  }
}
