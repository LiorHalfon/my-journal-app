# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, dependency-free Hebrew/RTL journaling PWA. Entries live in IndexedDB on the device. Backup is an AES-256-GCM sealed file that the device uploads to a private GitHub repo, so GitHub only ever holds ciphertext.

Native ES modules, no build step. Each module hides a lot behind a small interface:

| Module | Owns |
|---|---|
| `entries-store.js` | IndexedDB. `open`/`readAll`/`put`/`putAll`/`remove`/`addMissing`. `putAll` is one transaction, all-or-nothing. `readAll()` returns newest-first, so no caller sorts. |
| `folders.js` | Which folders exist, their order (latest entry activity first), which one is open, and the naming rule. An entry's folder is a plain `folder` name on the entry; this module keeps per-device records in `localStorage` so a folder disappears only when deleted. |
| `vault.js` | The key, the recovery code (Crockford base32 with a checksum), the key id, the sealed envelope, `VaultError` and its Hebrew messages. Pure: only `crypto`, `TextEncoder`/`TextDecoder` and `btoa`/`atob`. |
| `github.js` | A stateless client for the backup file's GitHub REST calls: check the repo, current sha, upload, versions, download. `GithubError` and its Hebrew messages. The token goes only into the `Authorization` header. |
| `backup-store.js` | The backup settings (`key`, `github`, `remote`) in their own IndexedDB database, `journal-backup`, so the service worker can read them. |
| `backup.js` | The backup job: whether to upload, sealing, uploading under the Web Lock, restore, sealed export and import, and `describeBackupError()`. |
| `backup-file.js` | The JSON interchange format — the single source of truth for what gets written and what is accepted back. |
| `view.js` | Every DOM read and write, all HTML building, and date formatting. No other module touches the DOM. |
| `local-storage.js` | `localStorage` that returns a fallback instead of throwing in private mode. |
| `app.js` | Screen state, event wiring, boot. Holds no domain logic. |

There is no build step, no package manager, no lint config, and no test suite — verify changes by serving the folder and loading the page. `README.md` (Hebrew) covers creating the backup repo and its token, and the backup file format.

## Running it

```bash
python3 -m http.server 8080   # then http://localhost:8080
```

`file://` fails: the service worker and WebCrypto (`crypto.subtle`) both require a secure context, and localhost counts as one. Deployment is GitHub Pages off `main` — pushing is deploying, live at https://liorhalfon.github.io/my-journal-app/.

**Treat the origin as fixed.** IndexedDB is keyed to `https://liorhalfon.github.io`, so moving hosts abandons every entry on every installed device; the only migration path is the JSON export/import pair. The path within the origin is free to change.

## Editing gotchas

**Shipping a change is just `git push`.** The shell is served network-first through `networkFirst()`, which fetches with `cache: "no-cache"` so the conditional request sidesteps the `max-age=600` GitHub Pages sets. An installed device picks the change up on its first launch after the Pages build. `VERSION` exists for deliberate precache resets, not for routine deploys.

**`SHELL_FILES` in `sw.js` must match real paths.** `cache.addAll()` rejects atomically, so one 404 fails the whole install — and `register()` in `app.js` swallows the rejection, so offline dies with no visible symptom while the app keeps working online. Adding a shell file means verifying it actually serves.

**`sw.js` is a module.** Its static imports (`entries-store.js`, `backup.js` and everything they import) must exist and stay free of DOM, `window` and direct `localStorage`. A failed import fails the worker's install, and offline dies silently, like a bad `SHELL_FILES` entry.

## Architecture

**Screen state lives only in `app.js`** (`entries`, `folder`, `folderPanel`, `pendingFolderDelete`, `query`, `editingId`, `pendingDeleteId`, and for the backup sheet `setupPanel`, `pendingCode`, `setupError`, `backupBlocked`). `view.renderEntries()` and `view.renderFolders()` receive that state and rebuild into `innerHTML` — no diffing, no framework. `render()` rebuilds both; search and list clicks call `renderList()` alone, so a half-typed folder name is never rebuilt away. In the same way only setup actions call `renderBackupSetup()`, so a status refresh never wipes a half-typed repo or token. Every mutation follows one shape: `store.put`/`remove` → `refreshEntries()` → `scheduleBackup()`.

**Only a successful save clears the composer.** No folder action, render or search writes to `#composer`, and the draft also lives in `localStorage`. The user asked for this explicitly; keep it true.

**The new-folder field closes on a tap outside the folder row, never on blur.** A tap blurs the field before its click lands, and closing the field then shifts a sideways-scrolled row, so the tap misses the folder.

**Everything interpolated into HTML passes through `escapeHtml()` in `view.js`.** `highlightMatches()` escapes first, then wraps matches in `<mark>`. Building markup anywhere else means re-deriving this, which is why the DOM stays in one module.

**Backup failures are `VaultError` or `GithubError`, each with a `kind`.** `VaultError` (`vault.js`): `no-key`, `bad-code`, `wrong-key`, `corrupt`. `GithubError` (`github.js`): `bad-repo`, `public`, `offline`, `auth`, `denied`, `missing`, `busy`, `conflict`, or `http` plus a `status`. Each class has its `describe…Error()` beside it, and `backup.describeBackupError()` picks between them; the UI shows only that. A new failure mode means a new kind and a message there. Automatic backups swallow every failure; only actions the owner taps show a message.

**The key is a non-extractable `CryptoKey`.** It's stored in `journal-backup` as `{ key, kid }`, so page code can encrypt with it but can't read it out. Raw key bytes exist only between creating or decoding a recovery code and `importKey()`, and are zeroed right after. The recovery code is never stored: it lives in `pendingCode` until the owner confirms it. The token is stored only in the `github` record. Neither ever goes into a log, a URL, an error message, `localStorage` or `sessionStorage`.

**Backups run by themselves, and upload only on a change.** `backupQuietly()` runs at boot, on `online`, on `visibilitychange` in both directions, and 20 s after a mutation through `scheduleBackup()`. `backupIfChanged()` compares a fingerprint, the SHA-256 of `kid + "\n" + JSON.stringify(entries)`, with the one in `remote`, so an edit or a new key uploads and nothing else does. An unchanged journal refreshes `confirmedAt` without a request, and the status turns stale 3 days after `confirmedAt`. A device with no `remote` never covers an existing file in the repo: it returns `"remote-exists"` and the sheet says to restore first. A restore or a manual "גיבוי עכשיו" (`force`) lifts that; saving a different repo clears `remote`, so the check runs again. Every backup, restore and account save runs under the Web Lock `journal-backup`, which the page and the service worker share. Each upload is a commit named `backup`, so the repo's history is the version list. Restore goes through `store.addMissing()`, which is additive-only and keyed by the client-generated `id`: it never deletes or overwrites, so deletions and folder changes don't reach a device that already has those entries.

**`backup.js` runs in the service worker too: no DOM, no `localStorage`.** The same goes for everything it imports. `folders.js` reaches `localStorage` only through the `local-storage.js` wrappers, which fall back quietly where it doesn't exist.

## Conventions

- UI strings are Hebrew and hardcoded inline; there is no i18n layer. Layout is RTL, so use logical CSS properties (`margin-inline-start`, `inset-inline`).
- All CSS lives in the `<style>` block of `index.html`. Each colour token is declared once with `light-dark()`, so a palette change is a one-line edit; `[data-theme]` overrides `color-scheme` to force a mode.
- The writing surface (`.composer textarea`, `.entry-text`, `.entry-edit textarea`) is Heebo; everything else is Assistant. That split is what makes an entry read as content rather than as interface. Both fonts are served from `fonts/` (Hebrew and Latin subsets, precached), never from Google.
- Text colours are held to WCAG AA. `--ink-faint` in the light palette is the known exception at 2.63 — see the git history for the dark-palette fix.
- DOM access is by id through `view.byId()`; list and backup-setup interactions are delegated on `#list` and `#backupSetup` via `data-act` attributes.
- The recovery code, key id, repo and token are shown and typed `dir="ltr"`.
