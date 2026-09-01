# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, dependency-free Hebrew/RTL journaling PWA. Entries live in IndexedDB on the device; backup is a JSON file in the user's own Google Drive.

Native ES modules, no build step. Each module hides a lot behind a small interface:

| Module | Owns |
|---|---|
| `config.js` | The Google Client ID, and nothing else — the one file a human edits to enable backup. |
| `entries-store.js` | IndexedDB. `open`/`readAll`/`put`/`remove`/`addMissing`. `readAll()` returns newest-first, so no caller sorts. |
| `drive.js` | OAuth token lifecycle, folder discovery, multipart upload, the error taxonomy, and the Hebrew messages for it. |
| `backup-file.js` | The JSON interchange format — the single source of truth for what gets written and what is accepted back. |
| `view.js` | Every DOM read and write, all HTML building, and date formatting. No other module touches the DOM. |
| `local-storage.js` | `localStorage` that returns a fallback instead of throwing in private mode. |
| `app.js` | Screen state, event wiring, boot. Holds no domain logic. |

There is no build step, no package manager, no lint config, and no test suite — verify changes by serving the folder and loading the page. `README.md` (Hebrew) covers the Google Cloud console walkthrough and the backup file format.

## Running it

```bash
python3 -m http.server 8080   # then http://localhost:8080
```

`file://` fails: the service worker and Google OAuth both require a secure context, and localhost counts as one. Deployment is GitHub Pages off `main` — pushing is deploying, live at https://liorhalfon.github.io/my-journal-app/.

**Treat the origin as fixed.** IndexedDB is keyed to `https://liorhalfon.github.io`, so moving hosts abandons every entry on every installed device; the only migration path is the JSON export/import pair. The path within the origin is free to change.

Drive backup stays inert until an OAuth Client ID replaces the placeholder in `config.js` **and** the exact serving origin is registered as an *Authorized JavaScript origin* in Google Cloud. `drive.isConfigured()` detects the `PASTE-` prefix and `boot()` disables the connect button.

## Editing gotchas

**Shipping a change is just `git push`.** The shell is served network-first through `networkFirst()`, which fetches with `cache: "no-cache"` so the conditional request sidesteps the `max-age=600` GitHub Pages sets. An installed device picks the change up on its first launch after the Pages build. `VERSION` exists for deliberate precache resets, not for routine deploys.

**`SHELL_FILES` in `sw.js` must match real paths.** `cache.addAll()` rejects atomically, so one 404 fails the whole install — and `register()` in `app.js` swallows the rejection, so offline dies with no visible symptom while the app keeps working online. Adding a shell file means verifying it actually serves.

## Architecture

**Screen state lives only in `app.js`** (`entries`, `query`, `editingId`, `pendingDeleteId`). `view.renderEntries()` receives that state and rebuilds the whole list into `innerHTML` — no diffing, no framework. Every mutation follows one shape: `store.put`/`remove` → `refreshEntries()` → `scheduleAutoSync()`.

**Everything interpolated into HTML passes through `escapeHtml()` in `view.js`.** `highlightMatches()` escapes first, then wraps matches in `<mark>`. Building markup anywhere else means re-deriving this, which is why the DOM stays in one module.

**Drive failures are `DriveError` with a `kind`** — `no-gis`, `denied`, `auth`, `offline`, or `http` plus a `status`. `describeDriveError()` maps a kind to its Hebrew message and lives beside the class. A new failure mode means a new kind and a branch there.

**Auth is the GIS token client (implicit flow).** This flow has no refresh tokens at all: the token lives in memory only, expires in ~1h, and is re-requested silently (`prompt: ""`) or with a consent window. localStorage holds the draft, cached Drive file IDs, and the last-sync timestamp; the token is never persisted. `drive.onConnectionChange()` is how the view learns to re-render — `drive.js` never touches the DOM itself.

**The Drive scope is `drive.file`,** so the app sees only files it created itself. `ensureBackupFolder()`'s search-by-name works solely because the app made that folder — code that expects to read pre-existing user files will fail. Holding this scope is what keeps the project out of Google's app-verification process.

**Sync is last-writer-wins on a single `journal-latest.json`,** updated in place rather than appended. `store.addMissing()` is additive-only, keyed by the client-generated `id`: it adds what is missing and never deletes or overwrites. Deletions do not propagate, and two devices syncing concurrently clobber each other. `scheduleAutoSync()` debounces 20s after a mutation, runs only when a token is already live, and swallows failures on purpose — local data is safe and there is a manual button.

## Conventions

- UI strings are Hebrew and hardcoded inline; there is no i18n layer. Layout is RTL, so use logical CSS properties (`margin-inline-start`, `inset-inline`).
- All CSS lives in the `<style>` block of `index.html`. Each colour token is declared once with `light-dark()`, so a palette change is a one-line edit; `[data-theme]` overrides `color-scheme` to force a mode.
- The writing surface (`.composer textarea`, `.entry-text`, `.entry-edit textarea`) is Heebo; everything else is Assistant. That split is what makes an entry read as content rather than as interface.
- Text colours are held to WCAG AA. `--ink-faint` in the light palette is the known exception at 2.63 — see the git history for the dark-palette fix.
- DOM access is by id through `view.byId()`; list interactions are delegated on `#list` via `data-act` attributes.
- The service worker passes `googleapis.com` and `accounts.google.com` requests straight to the network — tokens and Drive responses have to be fresh.
