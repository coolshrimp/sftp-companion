# VS Code SFTP Companion Extension Write-up

## Goal

SFTP Companion is a standalone VS Code extension that enhances a standard workspace `.vscode/sftp.json` workflow with a clearer UI, its own SFTP engine, transfer queue, sync-state feedback, and helper tooling.

The extension is not intended to replace the existing `sftp.json` structure with a separate profile system. It should behave like a helper layered on top of the original config shape while adding better visibility and safer workflow controls.

## Current Direction

The extension now follows these principles:

- use one workspace `.vscode/sftp.json` file as the primary config source
- keep credentials in VS Code SecretStorage where practical
- provide a Flipper-style dashboard menu as the main control surface
- open account management only when the user explicitly chooses to manage settings
- default auto-sync to off until the user enables whole-root or tagged-folder syncing
- visually highlight sync state between local and remote files

## What Exists Now

### 1. Activity Bar Workspace

The extension contributes an Activity Bar container named `SFTP Sync`.

Current views:

- `SFTP Companion` main dashboard tree
- `Local Sync` tree
- `Remote Files` tree
- `Transfer Queue` tree
- `Log Feed` tree

The original always-open account webview has been replaced by a dashboard-first layout. Account management now opens as a modal-style webview panel only when the user selects `Manage SFTP Account`.

### 2. Main Dashboard Menu

The main tree is now the equivalent of a control center, similar in spirit to the Flipper tool style.

Current actions exposed from the dashboard:

- Manage SFTP Account
- Edit `sftp.json`
- Generate / Update `sftp.json`
- Test Connection
- Connect / Disconnect
- Set Auto Sync Mode
- Find / open the original companion SFTP extension

This makes the extension usable without forcing the user into a settings form first.

### 3. Config Model

The extension currently treats `.vscode/sftp.json` as the main source of truth.

Current behavior:

- reads `.vscode/sftp.json` on startup when present
- writes helper changes back into `.vscode/sftp.json`
- supports standard fields such as `host`, `port`, `username`, `remotePath`, `context`, `syncFolder`, `ignore`, `watcher.files`
- adds helper fields such as `syncWhitelist`, `showHiddenFiles`, and `autoSyncMode`
- stores secrets separately in SecretStorage where needed
- still tolerates an older internal saved-state fallback, but that is no longer the preferred path

### 4. Account Manager Panel

The account manager exists, but it is no longer always visible.

Current editable fields:

- host
- port
- username
- remote path
- context
- sync folder
- auto sync mode
- auth mode
- private key path
- password
- passphrase
- ignore patterns
- sync whitelist
- watcher file globs
- show hidden files

Current helper behaviors:

- save helper settings back into `.vscode/sftp.json`
- update and open `sftp.json`
- show whether the original `liximomo.sftp` extension is installed
- provide a direct link when the companion extension is missing

### 5. Connection and Remote Operations

The extension owns its own SFTP connection via `ssh2-sftp-client`.

Current connection-related capabilities:

- connect
- disconnect
- test connection
- list remote directories
- stat remote files for sync comparison
- upload file
- upload folder
- download file
- download folder
- read remote file contents for diffing

### 6. Compare and Sync Feedback

The local and remote trees now include sync-state cues instead of showing plain file lists only.

Current comparisons include:

- local exists but remote is missing
- remote exists but local is missing
- local newer than remote
- remote newer than local
- present on both sides / effectively in sync

Current visual treatment:

- green for synced items
- blue when one side is newer
- red when the other side is missing
- purple accent for whitelist-tagged folders when no stronger sync state applies

Current labels shown in descriptions and tooltips:

- `In sync`
- `Local newer`
- `Remote newer`
- `Remote missing`
- `Local missing`
- `Present on both sides`
- `tagged`

### 7. Whitelist Tagging

Folder tagging for whitelist-based syncing is now partially implemented.

Current behavior:

- local folders can be tagged or untagged into the sync whitelist
- whitelist entries are stored in `.vscode/sftp.json`
- tagged folders are visually identified in the local and remote trees
- auto-sync can be limited to tagged folders only

### 8. Auto Sync Behavior

Auto-sync no longer assumes that everything under the sync root should upload.

Current modes:

- `manual`: default, no watcher-based auto-upload
- `root`: auto-upload everything under the configured sync root
- `whitelist`: auto-upload only tagged folders

Current watcher behavior:

- watcher starts only when auto-sync is enabled
- watcher debounces rapid changes
- ignored paths are skipped
- no automatic delete behavior

### 9. Transfer Queue and Logging

The extension has a built-in queue and log feed.

Current queue behavior:

- uploads and downloads are queued
- limited concurrency is used
- failed items can be retried
- completed items can be cleared
- queue status is color-coded

Current logging behavior:

- output channel logging exists
- log feed tree mirrors recent output
- connection, watcher, queue, and error events are surfaced

### 10. Dependency Awareness

The helper now detects whether the original SFTP extension is installed.

Current dependency behavior:

- checks for `liximomo.sftp`
- shows installed or missing state in the helper flow
- opens the extension search or Marketplace link when needed

### 11. Local Development Workflow

The extension already supports local iteration and packaging.

Current commands:

```powershell
npm install
npm run compile
npm run package
npm run deploy
npm run watch:deploy
```

Current release workflow:

- package VSIX locally
- force-install the latest VSIX into VS Code
- watch source changes and auto-redeploy during development

## Current Strengths

The extension is already beyond a bare MVP in a few areas:

- helper-first `.vscode/sftp.json` integration is working
- the UI is no longer settings-first
- manual-by-default autosync is safer for real projects
- local and remote trees provide useful sync feedback
- connection testing exists as a first-class action
- local packaging and redeploy workflows already exist

## Current Gaps

The extension is functional, but there are still several areas that need refinement.

Known gaps or rough edges:

- the dashboard is useful but still visually plain compared with a polished final product
- sync-state calculation currently relies on lightweight presence and timestamp checks rather than full checksum comparison
- tree comparisons can become expensive on larger folders because status is resolved per item
- manual edits to `.vscode/sftp.json` do not yet automatically refresh every surface live
- whitelist tagging exists from the local side, but the UX can be improved further
- remote-side management is still focused on browse/download/compare, not edit/move/delete workflows
- packaging still includes a large dependency footprint because the extension is not bundled yet

## Suggested Future Additions

### UI / UX

- make the dashboard feel more intentionally designed and less like a raw command list
- add dedicated section headers in the main tree, for example `Connection`, `Config`, `Sync`, `Companion`
- improve iconography and wording so state is even easier to scan
- add stronger labels such as `REMOTE MISSING`, `LOCAL NEWER`, `TAGGED`
- optionally add a richer status summary row showing connected host, sync root, autosync mode, and queue count

### Config and Live Refresh

- watch `.vscode/sftp.json` for edits and refresh the UI automatically
- show validation errors for malformed `sftp.json`
- support importing an existing plain `sftp.json` more gracefully when SecretStorage values are missing
- optionally support multiple deploy presets later while still preserving the single-config helper model

### Sync Intelligence

- cache remote stats to reduce repeated lookups while browsing trees
- add a manual `scan sync state` or `refresh compare state` command
- support folder-level aggregate state, not only per-item state
- add dry-run sync preview
- support compare-before-upload
- optionally support safer delete workflows with explicit confirmation

### Tree Actions

- add inline whitelist tagging visuals that are easier to spot
- add remote delete
- add remote rename / move
- add local-to-remote folder deploy commands from the context menu
- add `download and open` or preview flows for common web assets

### Queue and Status

- show progress percentages or active transfer counts
- show last successful sync time
- group failures more clearly with retry-all behavior
- surface queue summary in the main dashboard

### Performance / Packaging

- bundle the extension with esbuild or a similar bundler
- reduce VSIX size and redeploy time
- trim packaged files with tighter `.vscodeignore` or bundling

### Release Readiness

- add repository metadata once the GitHub repo is ready
- add changelog and versioning flow
- add Marketplace polish and screenshots
- decide whether the companion-extension link should remain optional or become more discoverable in onboarding

## Recommended Next Milestones

### Milestone A: UI Polish

- improve the main dashboard structure and labels
- add clearer sectioning and status summaries
- make tagged folders and stale files more visually obvious

### Milestone B: Live Config Refresh

- detect `.vscode/sftp.json` file changes
- refresh dashboard, trees, and watcher mode automatically
- improve error reporting for invalid config edits

### Milestone C: Sync Quality

- add cached stat refresh or smarter comparison logic
- reduce tree comparison cost
- expose a manual scan / compare refresh action

### Milestone D: Release Packaging

- bundle the extension
- reduce VSIX size
- add repo metadata and Marketplace readiness pieces

## Notes For This Workspace

For this specific site workflow, the current direction remains:

- keep the workspace root as the full site root
- allow one sync folder inside that workspace
- default auto-sync to off
- allow syncing the full sync root only when explicitly chosen
- allow syncing only tagged folders when that mode is selected
- keep `_notes` and `.vscode` excluded by default unless the user changes ignore rules

## Summary

This project has moved from a general concept into a working helper extension with:

- its own SFTP connection layer
- `.vscode/sftp.json`-first config handling
- a dashboard-first UI
- modal account management
- transfer queue and log panels
- manual / root / whitelist autosync modes
- basic sync-state highlighting across local and remote trees
- test connection support
- optional awareness of the original SFTP extension

The next work should focus less on basic scaffolding and more on polish, live refresh, performance, and stronger sync UX.