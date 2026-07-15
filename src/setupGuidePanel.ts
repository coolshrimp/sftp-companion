import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

/**
 * Static, user-proof walkthrough: first-time setup, protocol cheat sheet,
 * where settings live, syncing basics, and troubleshooting. The only script
 * is three buttons that jump to the matching command.
 */
export class SetupGuidePanel {
  private currentPanel?: vscode.WebviewPanel;

  public reveal(): void {
    if (this.currentPanel) {
      this.currentPanel.reveal(vscode.ViewColumn.Active, true);
      return;
    }
    this.currentPanel = vscode.window.createWebviewPanel(
      'sftpCompanionSetupGuide',
      'SFTP Companion — Setup Guide',
      vscode.ViewColumn.Active,
      { enableScripts: true }
    );
    this.currentPanel.onDidDispose(() => {
      this.currentPanel = undefined;
    });
    // Only the exact commands the guide's buttons use — never arbitrary ones.
    const allowedCommands = new Set(['sftpCompanion.accounts.open', 'sftpCompanion.openSyncCenter', 'sftpCompanion.openConfig']);
    this.currentPanel.webview.onDidReceiveMessage(async (message: { command?: string }) => {
      if (typeof message?.command === 'string' && allowedCommands.has(message.command)) {
        await vscode.commands.executeCommand(message.command);
      }
    });
    this.currentPanel.webview.html = this.getHtml(this.currentPanel.webview);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
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
      margin: 0; padding: 20px 24px 60px;
      max-width: 860px;
    }
    h1 { font-size: 1.5em; margin: 0 0 4px; }
    h2 { font-size: 1.15em; margin: 28px 0 8px; padding-top: 16px; border-top: 1px solid rgba(128,128,128,0.2); }
    p, li { line-height: 1.55; }
    .subtitle { opacity: 0.75; margin: 0 0 16px; }
    .card {
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
      border-radius: 8px; padding: 14px 16px; margin: 10px 0;
      background: var(--vscode-editorWidget-background, rgba(128,128,128,0.06));
    }
    .steps { counter-reset: step; list-style: none; padding: 0; margin: 0; }
    .steps li { counter-increment: step; position: relative; padding: 6px 0 6px 40px; }
    .steps li::before {
      content: counter(step);
      position: absolute; left: 0; top: 6px;
      width: 26px; height: 26px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      font-weight: 700; font-size: 0.9em;
    }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: rgba(128,128,128,0.15); padding: 1px 5px; border-radius: 3px;
    }
    table { border-collapse: collapse; width: 100%; margin: 8px 0; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid rgba(128,128,128,0.15); }
    th { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; }
    button {
      font-family: inherit; font-size: inherit; border: none; border-radius: 4px;
      padding: 6px 14px; cursor: pointer; margin: 4px 8px 4px 0;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: baseline; }
    .green { background: #2ea043; } .red { background: #f85149; } .blue { background: #4a9eda; } .orange { background: #d18616; }
    .warn {
      border-left: 3px solid var(--vscode-charts-orange, #d18616);
      padding: 8px 12px; margin: 10px 0; background: rgba(209,134,22,0.08); border-radius: 0 6px 6px 0;
    }
  </style>
</head>
<body>
  <h1>📘 SFTP Companion — Setup Guide</h1>
  <p class="subtitle">Everything you need to connect to your server and keep a local folder and the live site in sync.</p>

  <div class="card">
    <button id="openAccounts">👤 Open Account Manager</button>
    <button id="openSyncCenter">🗂 Open Sync Center</button>
    <button id="openConfig">✏️ Edit sftp.json</button>
  </div>

  <h2>1 · First-time setup</h2>
  <ol class="steps">
    <li>Open the <strong>SFTP Sync</strong> icon in the activity bar (left edge of VS Code), then click <strong>Account</strong>.</li>
    <li>Pick your <strong>Protocol</strong>: <code>SFTP</code> if your host gives you SSH access (port 22), <code>FTP</code> or <code>FTPS</code> for classic hosting accounts (port 21). The port fills in automatically.</li>
    <li>Enter <strong>Host</strong> (e.g. <code>example.com</code>), <strong>Username</strong>, and <strong>Password</strong>.</li>
    <li>Set <strong>Remote Path</strong> — the folder on the server your project mirrors (often <code>/public_html</code>).</li>
    <li>Click <strong>💾 Save Settings</strong>, then <strong>⚡ Test Connection</strong>. A green "Connected" dot appears in the SFTP Companion panel when it works.</li>
  </ol>

  <h2>2 · Which protocol / port?</h2>
  <table>
    <tr><th>Protocol</th><th>Port</th><th>When to use</th></tr>
    <tr><td>SFTP</td><td>22</td><td>Host provides SSH (fast + encrypted). On shared hosting (Bluehost, etc.) usually only the <em>main</em> account works, and SSH must be enabled in cPanel first.</td></tr>
    <tr><td>FTPS</td><td>21</td><td>Classic FTP account but encrypted with TLS. Try this before plain FTP.</td></tr>
    <tr><td>FTP</td><td>21</td><td>Plain, unencrypted. Works everywhere; use it when FTPS fails.</td></tr>
  </table>
  <p>Error <em>"Connection lost before handshake"</em> means the protocol and port don't match — an FTP server answered where SSH was expected (or vice-versa).</p>

  <h2>3 · Where your settings live</h2>
  <div class="card">
    <p><strong><code>.vscode/sftp.json</code></strong> — host, protocol, port, username, remote path, ignore patterns. Hand-editable at any time; the panel and file stay in sync both ways.</p>
    <p><strong><code>.vscode/sftp-companion.json</code></strong> — companion settings: sync folder, auto-sync mode, sync list, hidden files.</p>
    <p><strong>Your password</strong> — stored only in VS Code SecretStorage (your OS credential vault, e.g. Windows Credential Manager). It is <em>never written into the files</em>, and the extension refuses to upload the config files to the server, ever.</p>
    <p>💡 To change the password by hand: paste <code>"password": "newpass"</code> into <code>sftp.json</code> and save — it is absorbed into secure storage and scrubbed from the file automatically.</p>
    <p><strong>Per-project configs:</strong> the extension reads the <code>.vscode/sftp.json</code> of the folder you opened in VS Code — open a sub-project with its own <code>sftp.json</code> and that config is used; nothing is inherited from parent folders.</p>
    <p><strong>Multiple servers (profiles):</strong> add a <code>"profiles"</code> block to <code>sftp.json</code> — each entry overrides the base connection fields. Switch with the ⇄ button on the Account row or <em>SFTP Companion: Switch Server Profile</em>. Example:</p>
    <p><code>"profiles": { "production": { "host": "example.com", "remotePath": "/public_html" }, "staging": { "remotePath": "/staging" } }</code></p>
  </div>

  <h2>4 · Syncing your files</h2>
  <p>Status colors used everywhere (file trees and Sync Center):</p>
  <p>
    <span class="dot green"></span>In sync&nbsp;&nbsp;&nbsp;
    <span class="dot blue"></span>One side is newer&nbsp;&nbsp;&nbsp;
    <span class="dot red"></span>Missing on one side&nbsp;&nbsp;&nbsp;
    <span class="dot orange"></span>Folder contains changes
  </p>
  <ul>
    <li><strong>Manual transfers</strong> — hover any file/folder in the Local or Remote tree for upload (⬆), download (⬇), and diff buttons, or right-click for the full menu.</li>
    <li><strong>Sync Center</strong> — scans both sides and shows every difference in one table. Right-click rows for actions, tick checkboxes and use <em>Upload / Download / Sync Selected</em>, or sync whole folders at once.</li>
    <li><strong>Sync list</strong> — pin files/folders (right-click → <em>Add / Remove from Sync List</em>) to auto-upload just those.</li>
    <li><strong>Auto Sync modes</strong> — <em>Manual</em> (nothing automatic), <em>Sync List Only</em>, or <em>Everything</em>. A conflict guard warns before auto-upload overwrites a file that changed on the server after your local edit.</li>
    <li><strong>Make Identical</strong> — in the Sync Center: pick a source of truth and the other side becomes an exact mirror, including deleting orphan files (a confirmation lists the exact counts first).</li>
    <li><strong>Remote file management</strong> — right-click in Remote Files for rename/move, new file, new folder, delete, and Change Permissions (chmod); hover a file to see its current permissions.</li>
  </ul>
  <div class="warn"><strong>Careful with "Everything":</strong> every save under the sync root uploads immediately to the server. The extension asks for confirmation before enabling it — read that dialog before clicking yes.</div>

  <h2>5 · Troubleshooting</h2>
  <table>
    <tr><th>Symptom</th><th>Fix</th></tr>
    <tr><td>"Connection lost before handshake"</td><td>Wrong protocol/port pairing. SFTP = 22, FTP/FTPS = 21. Switch protocol in the Account panel.</td></tr>
    <tr><td>"Authentication failed" / 530</td><td>Username or password wrong, or the account isn't allowed to log in over that protocol (shared hosts often restrict SFTP to the main account).</td></tr>
    <tr><td>"553 … Not a directory"</td><td>A file on the server occupies a folder's name. The extension deletes the blocker automatically when it's an empty junk file; otherwise it names the file so you can remove it.</td></tr>
    <tr><td>Transfers stall after idle time</td><td>Servers drop idle connections; the extension reconnects automatically on the next operation.</td></tr>
    <tr><td>Anything unclear</td><td>Check the <strong>Log Feed</strong> view at the bottom of the SFTP Sync panel — every connection, transfer, and error is logged there.</td></tr>
  </table>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('openAccounts').addEventListener('click', () => vscode.postMessage({ command: 'sftpCompanion.accounts.open' }));
    document.getElementById('openSyncCenter').addEventListener('click', () => vscode.postMessage({ command: 'sftpCompanion.openSyncCenter' }));
    document.getElementById('openConfig').addEventListener('click', () => vscode.postMessage({ command: 'sftpCompanion.openConfig' }));
  </script>
</body>
</html>`;
  }
}
