import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { IgnoreMatcher } from './ignoreMatcher';
import { isChildOrSame, joinRemote, normalizeRelative, relativeTo } from './pathUtils';
import { AutoSyncMode, LoadedProfile, SftpProfile, StoredSecretPayload } from './types';

const PROFILE_KEY = 'sftpCompanion.profile';
const SECRET_KEY = 'sftpCompanion.secret';
// Which named profile (sftp.json "profiles" key) is active — per workspace.
const ACTIVE_PROFILE_NAME_KEY = 'sftpCompanion.activeProfileName';

/** Secrets are keyed per server+user so profiles and projects share them. */
function secretKeyFor(host: string, username: string): string {
  return `${SECRET_KEY}:${host}:${username}`;
}

// .vscode/sftp.json must stay a valid config for the Natizyskunk/liximomo SFTP
// extension (it validates its schema), so companion-only metadata lives in
// .vscode/sftp-companion.json instead of being mixed into sftp.json.
interface SftpJsonShape {
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
  private availableProfileNames: string[] = [];
  private activeProfileName?: string;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: { append(level: 'info' | 'warn' | 'error', message: string): void }
  ) {}

  public async loadActiveProfile(): Promise<LoadedProfile | undefined> {
    const workspaceConfig = await this.readWorkspaceConfig();
    if (workspaceConfig) {
      const loaded = await this.inflateProfile(workspaceConfig, 'workspaceFile');
      this.setActive(loaded);
      // Absorb credentials found in the file (legacy builds, or a password the
      // user pasted in by hand to change it) into SecretStorage, then rewrite
      // the file without them. Hand-editing still works: paste a password into
      // sftp.json, it becomes the active secret and the file is scrubbed.
      if (this.filePassword || this.filePassphrase) {
        await this.context.secrets.store(secretKeyFor(loaded.profile.host, loaded.profile.username), JSON.stringify({
          password: loaded.password,
          passphrase: loaded.passphrase
        }));
        this.filePassword = undefined;
        this.filePassphrase = undefined;
        await this.writeWorkspaceConfig(loaded.profile);
        this.logger.append('info', 'Moved the password out of sftp.json into secure storage (OS credential vault). Everything else in the file stays hand-editable.');
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
    await this.context.secrets.store(secretKeyFor(profile.host, profile.username), JSON.stringify(secret));
    await this.writeWorkspaceConfig(profile);
    await this.context.workspaceState.update(PROFILE_KEY, undefined);
    this.setActive({
      profile,
      password: secret.password,
      passphrase: secret.passphrase,
      source: 'workspaceFile'
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
    await this.context.workspaceState.update(ACTIVE_PROFILE_NAME_KEY, name);
    await this.loadActiveProfile();
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
    const loaded = this.activeProfile ?? await this.loadActiveProfile();
    if (!loaded) {
      vscode.window.showWarningMessage('Configure sftp.json before changing auto-sync mode.');
      return;
    }

    await this.saveProfile({
      ...loaded.profile,
      autoSyncMode: mode
    }, {
      password: loaded.password,
      passphrase: loaded.passphrase
    });
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
    const loaded = this.activeProfile ?? await this.loadActiveProfile();
    if (!loaded) {
      vscode.window.showWarningMessage('Configure sftp.json before tagging whitelist items.');
      return;
    }

    const target = normalizeRelative(relativePath);
    const current = loaded.profile.whitelist.map((entry) => normalizeRelative(entry));
    const next = current.includes(target)
      ? current.filter((entry) => entry !== target)
      : [...current, target].sort((left, right) => left.localeCompare(right));

    await this.saveProfile({
      ...loaded.profile,
      whitelist: next
    }, {
      password: loaded.password,
      passphrase: loaded.passphrase
    });
  }

  /** Add or remove an exact path from the ignore patterns. */
  public async toggleIgnoreEntry(relativePath: string): Promise<boolean> {
    const loaded = this.activeProfile ?? await this.loadActiveProfile();
    if (!loaded) {
      vscode.window.showWarningMessage('Configure sftp.json before ignoring items.');
      return false;
    }

    const target = normalizeRelative(relativePath);
    const exists = loaded.profile.ignore.some((entry) => normalizeRelative(entry) === target);
    const nextIgnore = exists
      ? loaded.profile.ignore.filter((entry) => normalizeRelative(entry) !== target)
      : [...loaded.profile.ignore, target];

    await this.saveProfile({
      ...loaded.profile,
      ignore: nextIgnore
    }, {
      password: loaded.password,
      passphrase: loaded.passphrase
    });
    return !exists;
  }

  public resolveRemotePath(relativePath: string): string {
    const remoteBase = this.activeProfile?.profile.remotePath ?? '/';
    return joinRemote(remoteBase, relativePath);
  }

  public resolveLocalPath(relativePath: string): string | undefined {
    const root = this.getLocalRoot();
    if (!root) {
      return undefined;
    }
    return path.resolve(root.fsPath, normalizeRelative(relativePath));
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
    try {
      const raw = await fs.readFile(sftpJsonPath, 'utf8');
      const base = JSON.parse(raw) as SftpJsonShape;

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
        ignore: parsed.ignore ?? ['.vscode/**', '_notes/**'],
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

  private async writeWorkspaceConfig(profile: SftpProfile): Promise<string> {
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
    try {
      existing = JSON.parse(await fs.readFile(target, 'utf8')) as SftpJsonShape;
    } catch {
      // No file yet.
    }

    // sftp.json context = context + syncFolder combined, so the SFTP engine's
    // local root matches SFTP Companion's sync root exactly.
    const combinedContext = normalizeRelative(path.posix.join(
      normalizeRelative(profile.context || '.') || '.',
      normalizeRelative(profile.syncFolder || '.') || '.'
    ));

    const config: SftpJsonShape = {
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

    // A named profile is active: `profile` holds MERGED values, so keep the
    // base connection fields from the file untouched instead of overwriting
    // them — only shared settings (ignore, autoSync) update. Connection edits
    // for a named profile are made in its profiles-block entry by hand.
    if (this.activeProfileName && existing.host) {
      config.host = existing.host;
      config.port = existing.port;
      config.protocol = existing.protocol;
      config.secure = existing.secure;
      config.username = existing.username;
      config.remotePath = existing.remotePath;
      config.privateKeyPath = existing.privateKeyPath;
      if (existing.context) {
        config.context = existing.context;
      }
    }

    // Preserve the hand-edited profiles block. The active profile's inline
    // password/passphrase (if any) was just absorbed into SecretStorage by the
    // caller, so scrub it here — otherwise every load would re-migrate it.
    if (existing.profiles) {
      const preserved: Record<string, Partial<SftpJsonShape>> = {};
      for (const [name, entry] of Object.entries(existing.profiles)) {
        if (name === this.activeProfileName) {
          const { password: _pw, passphrase: _pp, ...rest } = entry;
          preserved[name] = rest;
        } else {
          preserved[name] = entry;
        }
      }
      config.profiles = preserved;
    }
    if (existing.defaultProfile) {
      config.defaultProfile = existing.defaultProfile;
    }

    const companion: CompanionJsonShape = {
      context: profile.context,
      syncFolder: profile.syncFolder,
      autoSyncMode: profile.autoSyncMode,
      syncWhitelist: profile.whitelist,
      showHiddenFiles: profile.showHiddenFiles ?? false
    };

    await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await fs.writeFile(companionTarget, `${JSON.stringify(companion, null, 2)}\n`, 'utf8');
    return target;
  }

  private setActive(loaded: LoadedProfile): void {
    this.activeProfile = loaded;
    this.ignoreMatcher = new IgnoreMatcher(loaded.profile.ignore, loaded.profile.whitelist.map((entry) => normalizeRelative(entry)));
  }
}
