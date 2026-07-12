# Changelog

All notable changes to **SFTP Companion**.

## 0.9.0

- **Multiple server profiles per project** — a `profiles` block in `sftp.json` (e.g. dev/staging/production) with a one-click *Switch Server Profile* action; passwords are shared per server via the credential vault.
- **Remote file management** — rename/move, new file, new folder, and chmod (with the current permissions pre-filled) right from the Remote Files tree.
- **Make Identical** — pick a source of truth in the Sync Center and mirror the other side exactly, including orphan deletion, with a dry-run confirmation of the counts first.
- **Conflict guard** — auto-upload warns instead of overwriting when the server copy changed after your local edit.
- **Queue controls** — pause/stop/resume individual transfers, pause/resume the whole queue, and clear completed transfers.

## 0.8.0

- **Passwords are now SecretStorage-only.** Credentials are never written into `.vscode/sftp.json`; existing passwords found in the file are migrated into the OS credential vault and scrubbed from the file automatically. Hand-editing still works — paste a password into `sftp.json` and it is absorbed on save.
- **Setup Guide** — a built-in step-by-step page (book icon in the SFTP Companion view): first-time setup, protocol/port cheat sheet, where settings live, syncing basics, and troubleshooting.
- **Cleaner navigation** — the main panel is now five compact rows (Connection with green/red status dot, Account, Auto Sync, Sync Center, Setup Guide) with hover icon buttons for connect / disconnect / test / edit-json instead of one row per action.
- README rewritten; repository metadata added for Marketplace publishing.

## 0.7.x

- Auto-upload modes (`Everything`, `Sync List Only`) require a modal confirmation before turning on — in both the quick pick and the account manager.
- Bulk transfers of 25+ files from the Sync Center ask for confirmation with the exact file count.
- Hard block: the SFTP config files (which used to contain credentials) can never be uploaded to the server, regardless of ignore settings.
- Sync Center compare page: right-click context menus on files and folders (upload / download / smart sync / diff / copy path), checkbox multi-select with select-all, and *Upload / Download / Sync Selected* bulk actions.

## 0.5.0 – 0.6.0

- Fully standalone — no dependency on any other SFTP extension; auto-sync always runs through the built-in watcher and queue.
- Delete from server (with confirmation), opt-in auto-delete of remote counterparts.
- Local folder monitoring — trees refresh when files change outside VS Code.
- Missing remote folders are created automatically on upload; fixed FTP `550/553 Not a directory` failures and self-healing of paths blocked by junk zero-byte files.
- Fixed folder-create events being uploaded as files (which produced those junk files).

## 0.2.x – 0.4.x

- Account Manager rebuilt with native VS Code theming and a protocol picker (SFTP / FTP / FTPS via `basic-ftp`); two-way sync with `.vscode/sftp.json` + `.vscode/sftp-companion.json`.
- Smart Sync compares edit time + size on both sides and asks before acting; timestamps preserved on transfer.
- Sync Center full-page recursive compare with per-folder rollups and a live Transfers tab.
- Transfer queue with connection pool, per-file progress, pause / resume / stop / retry.
- Sync-status colors and Git-style badges in the file trees; context menus everywhere.
- Reliability: keyboard-interactive auth fallback, auto-connect, serialized command channels, FTP auto-reconnect.
