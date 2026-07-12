# SFTP Companion — Roadmap

Shipped changes live in [CHANGELOG.md](CHANGELOG.md); this file tracks what's next.

## Done (shipped in 0.9.0)

- [x] Multiple accounts/profiles — several servers per workspace with a profile picker (dev/staging/production).
- [x] Rename / move / new file / new folder / chmod on the remote tree.
- [x] "Make identical" mode in Sync Center: upload missing + download missing + delete orphans, with a dry-run preview.
- [x] Conflict guard — auto-upload flags a remote file that changed since last sync instead of clobbering it.
- [x] Pause / stop / resume individual transfers and the whole queue.

## High value

- [ ] **Bundle the extension** (esbuild) — ~600 files → 1; faster activation, much smaller VSIX.
- [ ] **Publish to the VS Code Marketplace** — publisher account, `vsce publish`, CI.

## Quality of life

- [ ] Persist transfer history across reloads (last N transfers with timestamps).
- [ ] Sync Center: remember last scan, auto-rescan after bulk operations, search/filter box for the compare tree.
- [ ] Status bar quick menu (connect/disconnect, auto-sync mode, open Sync Center).
- [ ] Per-folder auto-sync mode overrides (e.g. Everything inside one folder, manual elsewhere).

## Bigger swings

- [ ] Remote FileSystemProvider (`sftp://` scheme) so remote files open/edit natively without the cache-folder round trip.
- [ ] Scheduled/periodic sync (e.g. re-scan every N minutes and report drift).
