import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { ConfigService, DEFAULT_SECURITY_IGNORE_PATTERNS } from './configService';
import { Logger } from './logger';
import { AutoSyncMode, SftpProfile, StoredSecretPayload } from './types';

export class AccountViewProvider {
  private currentPanel?: vscode.WebviewPanel;

  public constructor(
    private readonly config: ConfigService,
    private readonly logger: Logger,
    private readonly onProfileSaved: () => Promise<void> | void
  ) {}

  public async reveal(): Promise<void> {
    if (this.currentPanel) {
      this.currentPanel.reveal(vscode.ViewColumn.Active, true);
      await this.render();
      return;
    }

    this.currentPanel = vscode.window.createWebviewPanel(
      'sftpCompanionAccountManager',
      'SFTP Account Manager',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.currentPanel.onDidDispose(() => {
      this.currentPanel = undefined;
    });
    this.currentPanel.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message?.type) {
        case 'save-profile':
          if (await this.handleSave(message.payload)) {
            await this.pushProfileToWebview(true);
          }
          break;
        case 'save-and-view':
          if (await this.handleSave(message.payload)) {
            await this.pushProfileToWebview(true);
            await this.config.openWorkspaceConfig();
          }
          break;
        case 'generate-config':
          await this.config.generateWorkspaceConfig();
          break;
        case 'open-config':
          await this.config.openWorkspaceConfig();
          break;
        case 'test-connection':
          await vscode.commands.executeCommand('sftpCompanion.testConnection');
          break;
        case 'request-reload':
          await this.render();
          break;
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.logger.append('error', `Account settings: ${text}`);
        vscode.window.showErrorMessage(`Could not save SFTP settings: ${text}`);
      }
    });
    await this.render();
  }

  /** Called when .vscode/sftp.json changes on disk so an open panel stays current. */
  public async refreshFromDisk(): Promise<void> {
    await this.pushProfileToWebview();
  }

  private async pushProfileToWebview(saved = false): Promise<void> {
    if (!this.currentPanel) {
      return;
    }
    const loaded = await this.config.loadActiveProfile();
    void this.currentPanel.webview.postMessage({
      type: saved ? 'profile-saved' : 'config-updated',
      profile: loaded?.profile ?? null,
      password: loaded?.password ?? '',
      passphrase: loaded?.passphrase ?? '',
      autoDeleteRemote: vscode.workspace.getConfiguration('sftpCompanion').get<boolean>('autoDeleteRemote', false)
    });
  }

  private async render(): Promise<void> {
    if (!this.currentPanel) {
      return;
    }

    const loaded = this.config.getCurrentProfile() ?? await this.config.loadActiveProfile();
    this.currentPanel.webview.html = this.getHtml(
      this.currentPanel.webview,
      loaded?.profile,
      loaded?.password,
      loaded?.passphrase,
      vscode.workspace.getConfiguration('sftpCompanion').get<boolean>('autoDeleteRemote', false)
    );
  }

  private async handleSave(payload: Record<string, unknown>): Promise<boolean> {
    // The webview exposes 'sftp' | 'ftp' | 'ftps'; internally FTPS is FTP + secure.
    const isFtp = payload.protocol === 'ftp' || payload.protocol === 'ftps';
    const profile: SftpProfile = {
      host: String(payload.host || ''),
      port: Number(payload.port || (isFtp ? 21 : 22)),
      protocol: isFtp ? 'ftp' : 'sftp',
      secure: payload.protocol === 'ftps',
      username: String(payload.username || ''),
      remotePath: String(payload.remotePath || '/'),
      context: String(payload.context || '.'),
      syncFolder: String(payload.syncFolder || '.'),
      ignore: splitList(payload.ignore),
      whitelist: splitList(payload.whitelist),
      authMode: !isFtp && payload.authMode === 'privateKey' ? 'privateKey' : 'password',
      privateKeyPath: String(payload.privateKeyPath || ''),
      showHiddenFiles: payload.showHiddenFiles === true,
      autoSyncMode: isAutoSyncMode(payload.autoSyncMode) ? payload.autoSyncMode : 'manual'
    };

    const secret: StoredSecretPayload = {
      password: String(payload.password || ''),
      passphrase: String(payload.passphrase || '')
    };

    if (!profile.host || !profile.username) {
      vscode.window.showWarningMessage('Host and username are required.');
      return false;
    }

    if (profile.protocol === 'sftp' && profile.port === 21) {
      const choice = await vscode.window.showWarningMessage(
        'Port 21 is the FTP port, but the protocol is set to SFTP (which runs over SSH, usually port 22). Switch the protocol to FTP, or use port 22?',
        'Switch to FTP',
        'Use Port 22',
        'Keep As Is'
      );
      if (choice === 'Switch to FTP') {
        profile.protocol = 'ftp';
        profile.authMode = 'password';
      } else if (choice === 'Use Port 22') {
        profile.port = 22;
      } else if (choice !== 'Keep As Is') {
        return false;
      }
    }

    // Switching auto-upload ON from the panel needs the same explicit consent
    // as the quick-pick command — a stray dropdown change must not arm it.
    const previousMode = this.config.getCurrentProfile()?.profile.autoSyncMode ?? 'manual';
    if (profile.autoSyncMode !== previousMode && profile.autoSyncMode !== 'manual') {
      const detail = profile.autoSyncMode === 'root'
        ? 'EVERY file you save or change under the sync root will upload to the server automatically. If the remote path points at the wrong folder, this can overwrite a live site.'
        : 'Files and folders on the sync list will upload to the server automatically whenever they change locally.';
      const confirmLabel = profile.autoSyncMode === 'root' ? 'Auto-Upload Everything' : 'Auto-Upload Sync List';
      const choice = await vscode.window.showWarningMessage(
        `Enable auto-upload (${profile.autoSyncMode === 'root' ? 'Everything' : 'Sync List Only'})?`,
        { modal: true, detail },
        confirmLabel
      );
      if (choice !== confirmLabel) {
        vscode.window.showInformationMessage('Save cancelled — auto sync mode was not changed.');
        return false;
      }
    }

    const autoDeleteRemote = payload.autoDeleteRemote === true;
    const previousAutoDelete = vscode.workspace.getConfiguration('sftpCompanion').get<boolean>('autoDeleteRemote', false);
    if (autoDeleteRemote && !previousAutoDelete) {
      const confirmLabel = 'Enable Delete Mirroring';
      const choice = await vscode.window.showWarningMessage(
        'Mirror local deletes to the server?',
        {
          modal: true,
          detail: 'When auto-sync is enabled, deleting a local file or folder inside its scope permanently deletes the matching server item. Deleting a folder recursively removes everything inside the server folder, including remote-only or ignored descendants. Deleted server content cannot be restored by this extension.'
        },
        confirmLabel
      );
      if (choice !== confirmLabel) {
        vscode.window.showInformationMessage('Save cancelled — delete mirroring was not enabled.');
        return false;
      }
    }

    await this.config.saveProfile(profile, secret);
    await vscode.workspace.getConfiguration('sftpCompanion').update(
      'autoDeleteRemote',
      autoDeleteRemote,
      vscode.ConfigurationTarget.Workspace
    );
    await this.onProfileSaved();
    this.logger.append('info', `Account settings updated for ${profile.host}.`);
    vscode.window.showInformationMessage('Saved SFTP settings to .vscode/sftp.json.');
    return true;
  }

  private getHtml(webview: vscode.Webview, profile?: SftpProfile, password?: string, passphrase?: string, autoDeleteRemote = false): string {
    const nonce = randomBytes(16).toString('base64');
    const authMode = profile?.authMode ?? 'password';
    const autoSyncMode = profile?.autoSyncMode ?? 'manual';
    const protocolValue = profile?.protocol === 'ftp' ? (profile.secure ? 'ftps' : 'ftp') : 'sftp';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px 24px 48px;
      max-width: 920px;
      margin: 0 auto;
    }
    header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 6px; }
    h1 { font-size: 1.35em; font-weight: 600; margin: 0; }
    h1 .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; background: var(--vscode-charts-purple, #b180d7); }
    .subtitle { opacity: 0.75; margin: 0 0 16px; line-height: 1.5; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
    button {
      font-family: inherit; font-size: inherit;
      border: 1px solid transparent; border-radius: 4px;
      padding: 7px 14px; cursor: pointer;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.18));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.3)); }
    button.link {
      background: none; border: none; padding: 7px 4px;
      color: var(--vscode-textLink-foreground); text-decoration: underline;
    }
    button.link:hover { color: var(--vscode-textLink-activeForeground); background: none; }
    .banner {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 10px 14px; border-radius: 6px; margin-bottom: 14px; line-height: 1.4;
    }
    .banner.ok { background: color-mix(in srgb, var(--vscode-charts-green, #2ea043) 14%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-charts-green, #2ea043) 35%, transparent); }
    .banner.warn { background: color-mix(in srgb, var(--vscode-charts-yellow, #d29922) 14%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-charts-yellow, #d29922) 35%, transparent); }
    .banner.info { background: color-mix(in srgb, var(--vscode-charts-blue, #388bfd) 14%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-charts-blue, #388bfd) 35%, transparent); }
    #externalBanner { display: none; }
    .card {
      background: var(--vscode-editorWidget-background, rgba(128,128,128,0.06));
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
      border-radius: 8px; padding: 16px 18px; margin-bottom: 14px;
    }
    .card h2 {
      font-size: 0.85em; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
      opacity: 0.8; margin: 0 0 12px;
    }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
    .grid .full { grid-column: 1 / -1; }
    @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
    label { display: flex; flex-direction: column; gap: 5px; font-size: 0.92em; }
    label .title { opacity: 0.85; font-weight: 500; }
    label .hint { opacity: 0.55; font-size: 0.88em; font-weight: 400; }
    input[type="text"], input[type="password"], input[type="number"], select, textarea {
      width: 100%; padding: 7px 9px; border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
      font-family: inherit; font-size: inherit;
    }
    textarea { font-family: var(--vscode-editor-font-family, monospace); min-height: 120px; resize: vertical; line-height: 1.5; }
    input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .check { flex-direction: row; align-items: center; gap: 8px; }
    .check input { width: auto; }
    .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
    .hidden { display: none !important; }
    footer { opacity: 0.6; font-size: 0.88em; margin-top: 18px; line-height: 1.5; }
    code { font-family: var(--vscode-editor-font-family, monospace); background: rgba(128,128,128,0.15); padding: 1px 5px; border-radius: 3px; }
  </style>
</head>
<body>
  <header>
    <h1><span class="dot"></span>SFTP Account Manager</h1>
    <div class="toolbar">
      <button id="test" class="secondary">⚡ Test Connection</button>
      <button id="openConfig" class="link">Open sftp.json for manual edit</button>
    </div>
  </header>
  <p class="subtitle">Settings live in a standard <code>.vscode/sftp.json</code> (SFTP-extension compatible) plus <code>.vscode/sftp-companion.json</code> for companion-only options like the whitelist. Edit here or edit the files directly — this panel follows changes on disk either way.</p>
  <div class="banner info" id="externalBanner">
    <span><code>sftp.json</code> changed on disk while you have unsaved edits here.</span>
    <button class="secondary" id="reloadExternal">Load File Version</button>
  </div>

  <div class="card">
    <h2>Server</h2>
    <div class="grid">
      <label><span class="title">Protocol <span class="hint">— SFTP uses SSH (port 22), FTP/FTPS use port 21</span></span>
        <select id="protocol">
          <option value="sftp" ${protocolValue === 'sftp' ? 'selected' : ''}>SFTP (SSH)</option>
          <option value="ftp" ${protocolValue === 'ftp' ? 'selected' : ''}>FTP (plain)</option>
          <option value="ftps" ${protocolValue === 'ftps' ? 'selected' : ''}>FTPS (FTP over TLS)</option>
        </select>
      </label>
      <label><span class="title">Port</span><input type="number" id="port" value="${Number(profile?.port) || (protocolValue === 'sftp' ? 22 : 21)}" /></label>
      <label><span class="title">Host</span><input type="text" id="host" placeholder="example.com" value="${escapeHtml(profile?.host ?? '')}" /></label>
      <label><span class="title">Username</span><input type="text" id="username" placeholder="deploy-user" value="${escapeHtml(profile?.username ?? '')}" /></label>
    </div>
  </div>

  <div class="card">
    <h2>Authentication</h2>
    <div class="grid">
      <label id="rowAuthMode"><span class="title">Auth Mode</span>
        <select id="authMode">
          <option value="password" ${authMode === 'password' ? 'selected' : ''}>Password</option>
          <option value="privateKey" ${authMode === 'privateKey' ? 'selected' : ''}>Private Key</option>
        </select>
      </label>
      <label id="rowPassword"><span class="title">Password</span><input type="password" id="password" value="${escapeHtml(password ?? '')}" /></label>
      <label id="rowKeyPath"><span class="title">Private Key Path</span><input type="text" id="privateKeyPath" placeholder="C:\\Users\\you\\.ssh\\id_rsa" value="${escapeHtml(profile?.privateKeyPath ?? '')}" /></label>
      <label id="rowPassphrase"><span class="title">Key Passphrase <span class="hint">(optional)</span></span><input type="password" id="passphrase" value="${escapeHtml(passphrase ?? '')}" /></label>
    </div>
  </div>

  <div class="card">
    <h2>Paths</h2>
    <div class="grid">
      <label class="full"><span class="title">Remote Path <span class="hint">— folder on the server. Leave as / when the account already lands in the right folder.</span></span><input type="text" id="remotePath" placeholder="/" value="${escapeHtml(profile?.remotePath ?? '/')}" /></label>
      <label><span class="title">Context <span class="hint">— workspace subfolder</span></span><input type="text" id="context" value="${escapeHtml(profile?.context ?? '.')}" /></label>
      <label><span class="title">Sync Folder <span class="hint">— local root that mirrors the server</span></span><input type="text" id="syncFolder" value="${escapeHtml(profile?.syncFolder ?? '.')}" /></label>
    </div>
  </div>

  <div class="card">
    <h2>Sync Behavior</h2>
    <div class="grid">
      <label><span class="title">Auto Sync Mode <span class="hint">— written to sftp.json as uploadOnSave / watcher</span></span>
        <select id="autoSyncMode">
          <option value="manual" ${autoSyncMode === 'manual' ? 'selected' : ''}>Manual Only</option>
          <option value="root" ${autoSyncMode === 'root' ? 'selected' : ''}>Everything (Whole Sync Root)</option>
          <option value="whitelist" ${autoSyncMode === 'whitelist' ? 'selected' : ''}>Sync List Only</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" id="showHiddenFiles" ${profile?.showHiddenFiles ? 'checked' : ''} /> <span class="title">Show hidden files in trees</span></label>
      <label class="check full"><input type="checkbox" id="autoDeleteRemote" ${autoDeleteRemote ? 'checked' : ''} /> <span class="title">Mirror local deletes to the server <span class="hint">— only inside the active auto-sync scope; confirmation is required when enabling</span></span></label>
      <label class="full"><span class="title">Sync List <span class="hint">— files and folders that auto-upload in "Sync List Only" mode. One path per line, relative to the sync folder. Easiest way: right-click any file/folder → Add / Remove from Sync List.</span></span><textarea id="whitelist" placeholder="NewSite&#10;assets/uploads&#10;index.php">${escapeHtml((profile?.whitelist ?? []).join('\n'))}</textarea></label>
    </div>
  </div>

  <div class="card">
    <h2>Ignore Patterns</h2>
    <div class="grid">
      <label class="full"><span class="title">One entry per line <span class="hint">— never uploaded or watched, hidden from Remote Files, and skipped in folder downloads. New accounts start with security-focused exclusions such as <code>.git</code>, <code>.gitignore</code>, <code>.vscode</code>, environment files, and private-key formats. A name without a slash matches at any depth; globs are allowed.</span></span><textarea id="ignore" placeholder=".git&#10;.gitignore&#10;.vscode&#10;.env&#10;*.pem">${escapeHtml((profile?.ignore ?? [...DEFAULT_SECURITY_IGNORE_PATTERNS]).join('\n'))}</textarea></label>
    </div>
  </div>

  <div class="actions">
    <button id="save">💾 Save</button>
    <button id="generate" class="secondary" title="Save these settings, then open .vscode/sftp.json in the editor">💾 Save &amp; View JSON</button>
  </div>

  <footer>Passwords and passphrases are stored only in VS Code SecretStorage (your OS credential vault) — never written into <code>sftp.json</code>. Everything else stays hand-editable in <code>.vscode/sftp.json</code> and <code>sftp-companion.json</code>. Tip: to change the password by hand, paste it into <code>sftp.json</code> as <code>"password"</code> — it is absorbed into secure storage and scrubbed from the file automatically.</footer>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const ids = ['protocol','host','port','username','remotePath','context','syncFolder','autoSyncMode','authMode','privateKeyPath','password','passphrase','ignore','whitelist','showHiddenFiles','autoDeleteRemote'];
    let dirty = false;
    let externalData = null;

    const el = (id) => document.getElementById(id);
    const collect = () => Object.fromEntries(ids.map((id) => {
      const element = el(id);
      return [id, element.type === 'checkbox' ? element.checked : element.value];
    }));

    function toggleAuth() {
      const isFtp = el('protocol').value !== 'sftp';
      if (isFtp) {
        el('authMode').value = 'password';
      }
      const usePassword = el('authMode').value === 'password';
      el('rowAuthMode').classList.toggle('hidden', isFtp);
      el('rowPassword').classList.toggle('hidden', !usePassword);
      el('rowKeyPath').classList.toggle('hidden', usePassword || isFtp);
      el('rowPassphrase').classList.toggle('hidden', usePassword || isFtp);
    }

    function onProtocolChanged() {
      const isFtp = el('protocol').value !== 'sftp';
      const port = el('port').value;
      if (isFtp && (port === '22' || port === '')) {
        el('port').value = '21';
      } else if (!isFtp && (port === '21' || port === '')) {
        el('port').value = '22';
      }
      toggleAuth();
    }

    function applyProfile(data) {
      const profile = data.profile || {};
      const setValue = (id, value) => { el(id).value = value == null ? '' : String(value); };
      el('protocol').value = profile.protocol === 'ftp' ? (profile.secure ? 'ftps' : 'ftp') : 'sftp';
      setValue('host', profile.host); setValue('port', profile.port == null ? (profile.protocol === 'ftp' ? 21 : 22) : profile.port);
      setValue('username', profile.username); setValue('remotePath', profile.remotePath || '/');
      setValue('context', profile.context || '.'); setValue('syncFolder', profile.syncFolder || '.');
      el('autoSyncMode').value = profile.autoSyncMode || 'manual';
      el('authMode').value = profile.authMode || 'password';
      setValue('privateKeyPath', profile.privateKeyPath);
      setValue('password', data.password); setValue('passphrase', data.passphrase);
      setValue('ignore', (profile.ignore || []).join('\\n'));
      setValue('whitelist', (profile.whitelist || []).join('\\n'));
      el('showHiddenFiles').checked = profile.showHiddenFiles === true;
      el('autoDeleteRemote').checked = data.autoDeleteRemote === true;
      dirty = false;
      toggleAuth();
      el('externalBanner').style.display = 'none';
    }

    ids.forEach((id) => {
      el(id).addEventListener('input', () => { dirty = true; });
      el(id).addEventListener('change', () => { dirty = true; });
    });
    el('authMode').addEventListener('change', toggleAuth);
    el('protocol').addEventListener('change', onProtocolChanged);
    el('save').addEventListener('click', () => vscode.postMessage({ type: 'save-profile', payload: collect() }));
    el('generate').addEventListener('click', () => {
      // Open the JSON only after validation, confirmations, and both writes finish.
      vscode.postMessage({ type: 'save-and-view', payload: collect() });
    });
    el('openConfig').addEventListener('click', () => vscode.postMessage({ type: 'open-config' }));
    el('test').addEventListener('click', () => vscode.postMessage({ type: 'test-connection' }));
    el('reloadExternal').addEventListener('click', () => { if (externalData) { applyProfile(externalData); } });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message && message.type === 'profile-saved') {
        applyProfile(message);
      } else if (message && message.type === 'config-updated') {
        if (dirty) {
          externalData = message;
          el('externalBanner').style.display = 'flex';
        } else {
          applyProfile(message);
        }
      }
    });

    toggleAuth();
  </script>
</body>
</html>`;
  }
}

function splitList(value: unknown): string[] {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isAutoSyncMode(value: unknown): value is AutoSyncMode {
  return value === 'manual' || value === 'root' || value === 'whitelist';
}
