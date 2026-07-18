# Changelog

All notable changes to **SFTP Companion**.

## 0.9.4

- Sync Center Compare view now colors every row by status (in sync/local newer/server newer/local only/server only) with a tinted background and left stripe, instead of a single greyscale glyph.
- Replaced the hover-only upload/download buttons with an always-visible, GoodSync-style 3-way direction control (download / skip / upload) per row and per folder, with the recommended side pre-highlighted.
- Added a "Sync Shown" button that syncs every visible out-of-sync file in one action, letting the newer side win per file.

## 0.9.3

- Reworked Sync Center comparison into paired, row-aligned Local and Server file trees with search, explicit status filters, persistent Ignore, and clearly labeled timestamp-only Mark in sync actions.
- Replaced large transfer cards with compact paged rows. The panel now sends queue summaries while Compare is open and changed-item patches while Transfers is open, avoiding full 2,000+ item DOM rebuilds on every progress update.
- Disabled Make Identical after capped or partially failed scans, and limited Mark in sync to equal-size files that exist on both sides.
- Enabled confirmed multi-select deletion in Remote Files, surfaced opt-in file/folder delete mirroring in the Account Manager, and added security-focused ignore defaults for new accounts.
- Bound queued transfers to their originating account/root, serialized reconnects, preserved hand-edited config keys, and blocked local sync writes through links that escape the canonical root.

## 0.9.2

- **Much smaller, faster-loading extension** — the code is now bundled with esbuild: the package went from 603 files / 5.4 MB to 10 files / 0.4 MB, which speeds up install and activation.
- Marketplace polish: version/installs/rating badges in the README, gallery banner color, and listed under *SCM Providers* in addition to *Other*.

## 0.9.1

Security hardening release.

- **SSH host key verification** — the server's host key is now pinned on first connect (trust-on-first-use, like OpenSSH's `known_hosts`). If the key later changes, connecting fails with both fingerprints shown and an explicit *Trust New Key & Connect* decision, instead of silently accepting a possible man-in-the-middle.
- Webview security: CSP nonces are now cryptographically random, and the Setup Guide only executes its own three known commands.
- Smaller VSIX — screenshots and CI files are no longer packaged.

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
