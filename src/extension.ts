import * as vscode from 'vscode';
import { AccountViewProvider } from './accountViewProvider';
import { ConfigService } from './configService';
import { Logger } from './logger';
import { HostKeyMismatchError, SftpService } from './sftpService';
import { SyncActions } from './syncActions';
import { SetupGuidePanel } from './setupGuidePanel';
import { SyncCenterPanel } from './syncCenterPanel';
import { SyncDecorationProvider } from './syncDecorations';
import { SyncWatcher } from './syncWatcher';
import { TransferQueue } from './transferQueue';
import { LocalTreeProvider, LogTreeProvider, MainTreeProvider, QueueTreeProvider, RemoteTreeProvider } from './treeProviders';
import { AutoSyncMode, LoadedProfile, LocalNode, QueueItem, RemoteNode } from './types';

type CommandInput = LocalNode | RemoteNode | vscode.Uri | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  const config = new ConfigService(context, logger);
  // Trusted SSH host key fingerprints, pinned per host:port on first connect.
  const hostKeyStore = {
    get: (hostId: string) => context.globalState.get<string>(`sftpCompanion.hostKey:${hostId}`),
    set: async (hostId: string, fingerprint: string) => {
      await context.globalState.update(`sftpCompanion.hostKey:${hostId}`, fingerprint);
    }
  };
  const sftp = new SftpService(logger, hostKeyStore);

  // Connect, and when the server's SSH key differs from the pinned one, show
  // the fingerprints and let the user decide instead of failing opaquely.
  const connectVerified = async (profile: LoadedProfile): Promise<void> => {
    try {
      await sftp.connect(profile);
    } catch (error) {
      if (!(error instanceof HostKeyMismatchError)) {
        throw error;
      }
      const trustLabel = 'Trust New Key & Connect';
      const choice = await vscode.window.showWarningMessage(
        `SSH host key changed for ${error.hostId}`,
        {
          modal: true,
          detail: `Trusted: SHA256:${error.knownFingerprint}\nPresented: SHA256:${error.presentedFingerprint}\n\nA changed key usually means the server was reinstalled or migrated — but it can also mean the connection is being intercepted. Only continue if you expected this change.`
        },
        trustLabel
      );
      if (choice !== trustLabel) {
        throw error;
      }
      await hostKeyStore.set(error.hostId, error.presentedFingerprint);
      await sftp.connect(profile);
    }
  };

  let notifyConnectionChanged: () => void = () => undefined;
  // Forward reference: the remote tree needs ensureConnected for lazy
  // auto-connect, but ensureConnected is defined after the trees below.
  let ensureConnectedRef: () => Promise<boolean> = async () => false;

  const getTransferConcurrency = (): number =>
    vscode.workspace.getConfiguration('sftpCompanion').get<number>('transferConcurrency', 5);
  sftp.setTransferConcurrency(getTransferConcurrency());

  const queue = new TransferQueue(
    sftp,
    logger,
    getTransferConcurrency(),
    async () => {
      if (sftp.connected) {
        return;
      }
      const profile = await config.loadActiveProfile();
      if (!profile) {
        throw new Error('No SFTP account is configured yet.');
      }
      await connectVerified(profile);
      notifyConnectionChanged();
    }
  );
  // When a file inside the auto-sync scope is deleted locally, optionally
  // mirror the delete on the server (off by default — it is destructive).
  const watcher = new SyncWatcher(config, queue, logger, (relativePath) => {
    if (!vscode.workspace.getConfiguration('sftpCompanion').get<boolean>('autoDeleteRemote', false)) {
      return;
    }
    void (async () => {
      if (!(await ensureConnectedRef())) {
        return;
      }
      const remotePath = config.resolveRemotePath(relativePath);
      try {
        await sftp.deleteRemote(remotePath);
        logger.append('info', `Auto-delete mirrored local delete: ${remotePath}`);
      } catch (error) {
        logger.append('error', `Auto-delete failed for ${remotePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, async (relativePath, localPath, remotePath) => {
    // Conflict guard: if the server copy is NEWER than the local file being
    // auto-uploaded, someone changed it since we last synced — ask instead of
    // silently clobbering it. Only guards watcher uploads; manual is manual.
    if (!sftp.connected) {
      return true; // Can't check without a connection; queue connects anyway.
    }
    try {
      const [remoteStat, localStat] = await Promise.all([
        sftp.stat(remotePath),
        import('fs/promises').then((fsp) => fsp.stat(localPath))
      ]);
      if (!remoteStat?.modifiedAt || remoteStat.modifiedAt <= localStat.mtimeMs + 2000) {
        return true;
      }
      const choice = await vscode.window.showWarningMessage(
        `Auto-upload conflict: "${relativePath}" changed on the SERVER after your local edit (server ${new Date(remoteStat.modifiedAt).toLocaleString()} vs local ${new Date(localStat.mtimeMs).toLocaleString()}).`,
        'Upload Anyway',
        'Compare First',
        'Skip'
      );
      if (choice === 'Compare First') {
        await vscode.commands.executeCommand('sftpCompanion.compareFile', vscode.Uri.file(localPath));
        return false;
      }
      if (choice !== 'Upload Anyway') {
        logger.append('warn', `Auto-upload of ${relativePath} skipped — remote copy is newer (conflict).`);
        return false;
      }
      return true;
    } catch {
      return true; // Guard must never block uploads on its own errors.
    }
  });

  const syncDecorations = new SyncDecorationProvider();
  const mainTree = new MainTreeProvider(config, sftp);
  const localTree = new LocalTreeProvider(config, sftp, syncDecorations);
  const remoteTree = new RemoteTreeProvider(config, sftp, logger, () => ensureConnectedRef());
  const queueTree = new QueueTreeProvider(() => queue.items);
  const logTree = new LogTreeProvider(logger);

  // Local and remote views use createTreeView so the providers can surface
  // connection status and sync tallies via view.message.
  const remoteView = vscode.window.createTreeView('sftpCompanionRemote', { treeDataProvider: remoteTree, showCollapseAll: true });
  remoteTree.attachView(remoteView);
  const localView = vscode.window.createTreeView('sftpCompanionLocal', { treeDataProvider: localTree, showCollapseAll: true });
  localTree.attachView(localView);

  // Folder downloads skip ignored paths (remote-only clutter like host panels).
  sftp.setIgnoreFilter((relativePath) => config.getIgnoreMatcher().isIgnored(relativePath));

  context.subscriptions.push(
    logger,
    watcher,
    remoteView,
    localView,
    syncDecorations,
    vscode.window.registerFileDecorationProvider(syncDecorations),
    vscode.window.registerTreeDataProvider('sftpCompanionMain', mainTree),
    vscode.window.registerTreeDataProvider('sftpCompanionQueue', queueTree),
    vscode.window.registerTreeDataProvider('sftpCompanionLog', logTree)
  );

  const refreshAll = (): void => {
    // Context keys drive the welcome views (Connect / Manage Account buttons).
    void vscode.commands.executeCommand('setContext', 'sftpCompanion.connected', sftp.connected);
    void vscode.commands.executeCommand('setContext', 'sftpCompanion.configured', config.getCurrentProfile() !== undefined);
    mainTree.refresh();
    localTree.refresh();
    remoteTree.refresh();
    queueTree.refresh();
    logTree.refresh();
  };

  const updateStatusBar = createStatusBar(config, sftp, queue);
  context.subscriptions.push(updateStatusBar);
  let scannedThisConnection = false;
  notifyConnectionChanged = () => {
    refreshAll();
    updateStatusBar.update();
    if (!sftp.connected) {
      scannedThisConnection = false;
    } else if (!scannedThisConnection) {
      // First moment of a fresh connection: compare everything in the
      // background so Explorer badges are accurate without the user opening
      // the Sync Center. Skipped entirely when no account is configured.
      scannedThisConnection = true;
      void syncCenter.runScanInBackground();
    }
  };

  const ensureConnected = async (): Promise<boolean> => {
    if (sftp.connected) {
      return true;
    }
    const profile = await config.loadActiveProfile();
    if (!profile) {
      vscode.window.showWarningMessage('No SFTP account is configured yet. Open the account manager first.');
      return false;
    }
    try {
      await connectVerified(profile);
      notifyConnectionChanged();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.append('error', `Connect failed: ${message}`);
      vscode.window.showErrorMessage(`SFTP connect failed: ${message}`);
      return false;
    }
  };
  ensureConnectedRef = ensureConnected;

  const actions = new SyncActions(config, sftp, queue, logger, ensureConnected);
  const syncCenter = new SyncCenterPanel(config, sftp, queue, logger, actions, ensureConnected, syncDecorations);
  const setupGuide = new SetupGuidePanel();

  const accountView = new AccountViewProvider(config, logger, () => {
    watcher.restart();
    refreshAll();
    updateStatusBar.update();
  });

  queue.onDidChange(() => {
    queueTree.refresh();
    updateStatusBar.update();
    void vscode.commands.executeCommand('setContext', 'sftpCompanion.queuePaused', queue.paused);
  });
  // After transfers finish, re-check sync status so files turn green without a
  // manual refresh. Debounced so bulk uploads trigger one refresh, not fifty.
  let syncRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    queue.onDidComplete(() => {
      if (syncRefreshTimer) {
        clearTimeout(syncRefreshTimer);
      }
      syncRefreshTimer = setTimeout(() => refreshAll(), 800);
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration('sftpCompanion.transferConcurrency')) {
        const concurrency = getTransferConcurrency();
        queue.setConcurrency(concurrency);
        sftp.setTransferConcurrency(concurrency);
        logger.append('info', `Transfer concurrency set to ${concurrency}.`);
      }
    })
  );
  logger.onDidChange(() => logTree.refresh());

  await config.loadActiveProfile();
  watcher.restart();
  refreshAll();
  updateStatusBar.update();
  void maybeSuggestTreeIndent(context);

  // Independent of auto-sync: keep the Local Sync tree current when files are
  // added/removed outside VS Code (e.g. Windows Explorer). Debounced refresh.
  let localFsWatcher: vscode.FileSystemWatcher | undefined;
  let localFsTimer: ReturnType<typeof setTimeout> | undefined;
  const setupLocalFsWatcher = (): void => {
    localFsWatcher?.dispose();
    localFsWatcher = undefined;
    const root = config.getLocalRoot();
    if (!root) {
      return;
    }
    localFsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    const scheduleRefresh = (): void => {
      if (localFsTimer) {
        clearTimeout(localFsTimer);
      }
      localFsTimer = setTimeout(() => localTree.refresh(), 700);
    };
    localFsWatcher.onDidCreate(scheduleRefresh);
    localFsWatcher.onDidDelete(scheduleRefresh);
  };
  setupLocalFsWatcher();
  context.subscriptions.push({ dispose: () => localFsWatcher?.dispose() });

  // Keep everything (trees, watcher, open account panel) in sync with manual config edits.
  const configFileWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/{sftp,sftp-companion}.json');
  const onConfigFileChanged = async (): Promise<void> => {
    await config.loadActiveProfile();
    remoteTree.allowAutoConnect();
    watcher.restart();
    setupLocalFsWatcher();
    refreshAll();
    updateStatusBar.update();
    await accountView.refreshFromDisk();
  };
  configFileWatcher.onDidChange(onConfigFileChanged);
  configFileWatcher.onDidCreate(onConfigFileChanged);
  configFileWatcher.onDidDelete(onConfigFileChanged);
  context.subscriptions.push(configFileWatcher);

  // Saving a cached remote-edit file uploads it back to the server.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => actions.handleSavedDocument(document))
  );

  const resolveRelativePath = async (input: CommandInput): Promise<string | undefined> => {
    if (input && !(input instanceof vscode.Uri) && (input.kind === 'local' || input.kind === 'remote')) {
      return input.relativePath || undefined;
    }
    const target = await actions.resolveTarget(input);
    return target?.relativePath || undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('sftpCompanion.accounts.open', async () => accountView.reveal()),
    vscode.commands.registerCommand('sftpCompanion.accounts.generateConfig', async () => {
      await config.generateWorkspaceConfig();
      refreshAll();
    }),
    vscode.commands.registerCommand('sftpCompanion.openConfig', async () => {
      await config.openWorkspaceConfig();
    }),
    vscode.commands.registerCommand('sftpCompanion.testConnection', async () => {
      const profile = await config.loadActiveProfile();
      if (!profile) {
        vscode.window.showWarningMessage('No SFTP account is configured yet.');
        return;
      }
      const wasConnected = sftp.connected;
      try {
        if (!wasConnected) {
          await connectVerified(profile);
        }
        await sftp.list(config.resolveRemotePath(''));
        vscode.window.showInformationMessage(`Connection test succeeded for ${profile.profile.host}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.append('error', `Connection test failed: ${message}`);
        vscode.window.showErrorMessage(`Connection test failed: ${message}`);
      } finally {
        if (!wasConnected && sftp.connected) {
          await sftp.disconnect();
        }
        refreshAll();
        updateStatusBar.update();
      }
    }),
    vscode.commands.registerCommand('sftpCompanion.setAutoSyncMode', async () => {
      const selection = await vscode.window.showQuickPick([
        { label: 'Manual Only', description: 'Do not auto-upload any changes.', mode: 'manual' as AutoSyncMode },
        { label: 'Everything', description: 'Auto-upload everything under the configured sync root.', mode: 'root' as AutoSyncMode },
        { label: 'Sync List Only', description: 'Auto-upload only files and folders on the sync list.', mode: 'whitelist' as AutoSyncMode }
      ], { placeHolder: 'Choose how automatic upload should work.' });
      if (!selection) {
        return;
      }
      // Turning auto-upload ON can silently overwrite server content, so it
      // requires an explicit modal confirmation. Turning it off never does.
      if (selection.mode !== 'manual' && selection.mode !== config.getAutoSyncMode()) {
        const detail = selection.mode === 'root'
          ? 'EVERY file you save or change under the sync root will upload to the server automatically. If the remote path points at the wrong folder, this can overwrite a live site.'
          : 'Files and folders on the sync list will upload to the server automatically whenever they change locally.';
        const confirmLabel = selection.mode === 'root' ? 'Auto-Upload Everything' : 'Auto-Upload Sync List';
        const choice = await vscode.window.showWarningMessage(
          `Enable auto-upload: ${selection.label}?`,
          { modal: true, detail },
          confirmLabel
        );
        if (choice !== confirmLabel) {
          return;
        }
      }
      await config.setAutoSyncMode(selection.mode);
      watcher.restart();
      refreshAll();
      updateStatusBar.update();
    }),
    vscode.commands.registerCommand('sftpCompanion.toggleWhitelistTag', async (input?: CommandInput) => {
      const relativePath = await resolveRelativePath(input);
      if (!relativePath) {
        return;
      }
      await config.toggleWhitelistEntry(relativePath);
      watcher.restart();
      refreshAll();
      const tagged = config.isWhitelisted(relativePath);
      vscode.window.setStatusBarMessage(
        tagged ? `$(pin) Added to sync list: ${relativePath}` : `$(pinned-dirty) Removed from sync list: ${relativePath}`,
        4000
      );
    }),
    vscode.commands.registerCommand('sftpCompanion.toggleIgnore', async (input?: CommandInput) => {
      const relativePath = await resolveRelativePath(input);
      if (!relativePath) {
        return;
      }
      const nowIgnored = await config.toggleIgnoreEntry(relativePath);
      watcher.restart();
      refreshAll();
      vscode.window.setStatusBarMessage(
        nowIgnored ? `$(eye-closed) Ignored: ${relativePath}` : `$(eye) No longer ignored: ${relativePath}`,
        4000
      );
    }),
    vscode.commands.registerCommand('sftpCompanion.refreshLocal', () => localTree.refresh()),
    vscode.commands.registerCommand('sftpCompanion.deleteRemote', async (item?: RemoteNode) => {
      if (!item) {
        return;
      }
      const confirm = vscode.workspace.getConfiguration('sftpCompanion').get<boolean>('confirmRemoteDelete', true);
      if (confirm) {
        const label = item.isDirectory ? 'folder and everything inside it' : 'file';
        const choice = await vscode.window.showWarningMessage(
          `Delete ${item.isDirectory ? 'folder' : 'file'} "${item.remotePath}" from the server?`,
          { modal: true, detail: `This permanently removes the ${label} from the server. The local copy is not touched.` },
          'Delete from Server'
        );
        if (choice !== 'Delete from Server') {
          return;
        }
      }
      if (!(await ensureConnected())) {
        return;
      }
      try {
        await sftp.deleteRemote(item.remotePath, item.isDirectory);
        refreshAll();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Delete failed: ${message}`);
      }
    }),
    vscode.commands.registerCommand('sftpCompanion.switchProfile', async () => {
      await config.loadActiveProfile();
      const names = config.getProfileNames();
      if (names.length === 0) {
        vscode.window.showInformationMessage(
          'No named profiles in sftp.json yet. Add a "profiles" block, e.g. { "profiles": { "production": { "host": "...", "remotePath": "..." } } } — each entry overrides the base connection fields.'
        );
        await config.openWorkspaceConfig();
        return;
      }
      const active = config.getActiveProfileName();
      const pick = await vscode.window.showQuickPick([
        { label: '$(server) Base config', description: active === undefined ? 'active' : '', name: undefined as string | undefined },
        ...names.map((name) => ({ label: `$(server-environment) ${name}`, description: name === active ? 'active' : '', name: name as string | undefined }))
      ], { placeHolder: 'Switch server profile (connection fields from sftp.json "profiles")' });
      if (!pick) {
        return;
      }
      await sftp.disconnect();
      await config.selectProfile(pick.name);
      remoteTree.allowAutoConnect();
      watcher.restart();
      refreshAll();
      updateStatusBar.update();
      logger.append('info', `Switched to ${pick.name ? `profile "${pick.name}"` : 'the base config'}.`);
    }),
    vscode.commands.registerCommand('sftpCompanion.renameRemote', async (item?: RemoteNode) => {
      if (!item || !(await ensureConnected())) {
        return;
      }
      const currentName = item.remotePath.split('/').pop() ?? '';
      const input = await vscode.window.showInputBox({
        prompt: 'New name (or a full path starting with / to move it)',
        value: currentName,
        validateInput: (value) => (!value.trim() ? 'Enter a name' : undefined)
      });
      if (!input || input === currentName) {
        return;
      }
      const parent = item.remotePath.slice(0, item.remotePath.lastIndexOf('/')) || '/';
      const target = input.startsWith('/') ? input : `${parent === '/' ? '' : parent}/${input}`;
      try {
        await sftp.renameRemote(item.remotePath, target);
        refreshAll();
      } catch (error) {
        vscode.window.showErrorMessage(`Rename failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand('sftpCompanion.newRemoteFolder', async (item?: RemoteNode) => {
      if (!(await ensureConnected())) {
        return;
      }
      const base = item?.isDirectory ? item.remotePath : config.resolveRemotePath('');
      const name = await vscode.window.showInputBox({ prompt: `New folder inside ${base}`, placeHolder: 'folder-name' });
      if (!name?.trim()) {
        return;
      }
      try {
        await sftp.createRemoteFolder(`${base === '/' ? '' : base}/${name.trim()}`);
        refreshAll();
      } catch (error) {
        vscode.window.showErrorMessage(`Create folder failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand('sftpCompanion.newRemoteFile', async (item?: RemoteNode) => {
      if (!(await ensureConnected())) {
        return;
      }
      const base = item?.isDirectory ? item.remotePath : config.resolveRemotePath('');
      const name = await vscode.window.showInputBox({ prompt: `New empty file inside ${base}`, placeHolder: 'filename.php' });
      if (!name?.trim()) {
        return;
      }
      try {
        await sftp.createRemoteFile(`${base === '/' ? '' : base}/${name.trim()}`);
        refreshAll();
      } catch (error) {
        vscode.window.showErrorMessage(`Create file failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand('sftpCompanion.chmodRemote', async (item?: RemoteNode) => {
      if (!item || !(await ensureConnected())) {
        return;
      }
      const mode = await vscode.window.showInputBox({
        prompt: `Permissions for ${item.remotePath} (octal, e.g. 644 for files, 755 for folders/scripts)`,
        value: item.mode ?? (item.isDirectory ? '755' : '644'),
        validateInput: (value) => (/^[0-7]{3,4}$/.test(value) ? undefined : 'Enter 3–4 octal digits, e.g. 644')
      });
      if (!mode) {
        return;
      }
      try {
        await sftp.chmodRemote(item.remotePath, mode);
        refreshAll();
      } catch (error) {
        vscode.window.showErrorMessage(`chmod failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand('sftpCompanion.connect', async () => {
      remoteTree.allowAutoConnect();
      await ensureConnected();
      refreshAll();
    }),
    vscode.commands.registerCommand('sftpCompanion.disconnect', async () => {
      // Explicit disconnect must stick — stop the remote tree from silently
      // reconnecting on the refresh that follows.
      remoteTree.blockAutoConnect();
      await sftp.disconnect();
      notifyConnectionChanged();
    }),
    vscode.commands.registerCommand('sftpCompanion.refreshRemote', () => {
      remoteTree.allowAutoConnect();
      refreshAll();
    }),
    vscode.commands.registerCommand('sftpCompanion.revealSyncFolder', async () => {
      const root = config.getLocalRoot();
      if (!root) {
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', root);
    }),
    vscode.commands.registerCommand('sftpCompanion.uploadFile', async (input?: CommandInput) => actions.upload(input)),
    vscode.commands.registerCommand('sftpCompanion.uploadFolder', async (input?: CommandInput) => actions.upload(input)),
    vscode.commands.registerCommand('sftpCompanion.downloadFile', async (input?: CommandInput) => actions.download(input)),
    vscode.commands.registerCommand('sftpCompanion.downloadFolder', async (input?: CommandInput) => actions.download(input)),
    vscode.commands.registerCommand('sftpCompanion.compareFile', async (input?: CommandInput) => actions.compare(input)),
    vscode.commands.registerCommand('sftpCompanion.syncResource', async (input?: CommandInput) => actions.smartSync(input)),
    vscode.commands.registerCommand('sftpCompanion.openRemoteFile', async (item?: RemoteNode) => actions.openRemoteForEdit(item)),
    vscode.commands.registerCommand('sftpCompanion.openSyncCenter', () => syncCenter.reveal()),
    vscode.commands.registerCommand('sftpCompanion.openSetupGuide', () => setupGuide.reveal()),
    vscode.commands.registerCommand('sftpCompanion.retryQueueItem', async (item?: QueueItem) => {
      if (!item) {
        return;
      }
      await queue.retry(item.id);
    }),
    vscode.commands.registerCommand('sftpCompanion.removeQueueItem', (item?: QueueItem) => {
      if (!item) {
        return;
      }
      queue.remove(item.id);
    }),
    vscode.commands.registerCommand('sftpCompanion.pauseQueueItem', (item?: QueueItem) => {
      if (item) {
        queue.pauseItem(item.id);
      }
    }),
    vscode.commands.registerCommand('sftpCompanion.stopQueueItem', (item?: QueueItem) => {
      if (item) {
        queue.stopItem(item.id);
      }
    }),
    vscode.commands.registerCommand('sftpCompanion.resumeQueueItem', (item?: QueueItem) => {
      if (item) {
        queue.resumeItem(item.id);
      }
    }),
    vscode.commands.registerCommand('sftpCompanion.pauseQueue', () => queue.pauseAll()),
    vscode.commands.registerCommand('sftpCompanion.resumeQueue', () => queue.resumeAll()),
    vscode.commands.registerCommand('sftpCompanion.clearCompletedTransfers', () => queue.clearCompleted())
  );
}

export async function deactivate(): Promise<void> {
  return;
}

/**
 * VS Code's default tree indent (8px) is narrower than the folder chevron
 * (16px), so files one level deep can appear to line up with their parent's
 * siblings. Offer once to widen the indent — it is a user setting the
 * extension must not change silently.
 */
async function maybeSuggestTreeIndent(context: vscode.ExtensionContext): Promise<void> {
  const promptKey = 'sftpCompanion.indentPromptShown';
  if (context.globalState.get<boolean>(promptKey)) {
    return;
  }
  const treeConfig = vscode.workspace.getConfiguration('workbench.tree');
  if (treeConfig.get<number>('indent', 8) >= 12) {
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    'Nested files in tree views can look flat because VS Code\'s default indent (8px) is narrower than the folder arrow. Increase the tree indent to 16px and show indent guides? (Affects all tree views.)',
    'Yes, Improve Nesting',
    'No Thanks'
  );
  await context.globalState.update(promptKey, true);
  if (choice === 'Yes, Improve Nesting') {
    await treeConfig.update('indent', 16, vscode.ConfigurationTarget.Global);
    await treeConfig.update('renderIndentGuides', 'always', vscode.ConfigurationTarget.Global);
  }
}

function createStatusBar(
  config: ConfigService,
  sftp: SftpService,
  queue: TransferQueue
): { update(): void; dispose(): void } {
  // Do NOT Object.assign extra members onto the StatusBarItem itself: newer VS Code
  // builds have an internal update() method that the text/tooltip setters call, so
  // overwriting it causes infinite recursion during activation.
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const update = (): void => {
    const root = config.getLocalRoot();
    const active = queue.items.filter((entry) => entry.status === 'running' || entry.status === 'queued').length;
    if (active > 0) {
      item.text = `$(sync~spin) SFTP ${active} transfer${active === 1 ? '' : 's'}`;
    } else {
      item.text = sftp.connected ? '$(plug) SFTP Connected' : '$(debug-disconnect) SFTP Disconnected';
    }
    item.tooltip = root
      ? `Sync root: ${root.fsPath}\nAuto sync: ${config.getAutoSyncMode()}`
      : 'Open a workspace and configure .vscode/sftp.json through the account manager.';
    item.command = 'sftpCompanion.testConnection';
    item.show();
  };
  update();
  return { update, dispose: () => item.dispose() };
}
