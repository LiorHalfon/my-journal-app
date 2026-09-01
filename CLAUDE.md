# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, dependency-free Hebrew/RTL journaling PWA. Entries live in IndexedDB on the device; backup is a JSON file in the user's own Google Drive. Four files do everything: `index.html` (markup + all CSS inline), `app.js` (all logic, one global scope, no modules), `sw.js`, `manifest.webmanifest`.

There is no build step, no package manager, no lint config, and no test suite — verify changes by serving the folder and loading the page. `README.md` (Hebrew) covers the Google Cloud console walkthrough and the backup file format.

## Running it

```bash
python3 -m http.server 8080   # then http://localhost:8080
```

`file://` fails: the service worker and Google OAuth both require a secure context, and localhost counts as one. Deploying is uploading the folder to any static host over HTTPS.

Drive backup stays inert until an OAuth Client ID replaces the placeholder at `app.js:8` **and** the exact serving origin is registered as an *Authorized JavaScript origin* in Google Cloud. `initAuth()` detects the `PASTE-` prefix and disables the connect button.

## Editing gotchas

**Bump `VERSION` in `sw.js` when `index.html`, `app.js`, or the manifest changes.** Same-origin assets are served cache-first, so an installed worker keeps handing out the old `app.js` and the change never appears in the browser.

**`SHELL_FILES` in `sw.js` must match real paths.** `cache.addAll()` rejects atomically — a single 404 fails the whole install and kills offline mode silently. It is currently mismatched: `sw.js` and the manifest reference `icons/*.png`, while the PNGs sit at the repo root with no `icons/` directory.

## Architecture

**State is module-level globals in `app.js`** (`entries`, `query`, `editingId`, `pendingDeleteId`, `accessToken`). `render()` rebuilds the entire list into `list.innerHTML` from the in-memory `entries` array — no diffing, no framework. Every mutation follows one shape: write IndexedDB → `reload()` (re-read, sort desc, render) → `scheduleSync()`.

**Everything interpolated into HTML passes through `esc()`.** `highlight()` escapes first, then wraps matches in `<mark>`. New markup builders must do the same.

**Errors are thrown as plain object literals, not `Error`s** — `{kind: "http", status}`, `{kind: "offline"}`, `{kind: "denied"}`, `{kind: "no_gis"}`. `authErrMsg()` switches on `kind` to produce the Hebrew message. A new failure mode means a new `kind` plus a case there.

**Auth is the GIS token client (implicit flow).** This flow has no refresh tokens at all: `accessToken` lives in memory only, expires in ~1h, and is re-requested through `getToken(interactive)` — silently with `prompt: ""`, or with a consent window. localStorage holds the draft, cached Drive file IDs, and the last-sync timestamp; the token is never persisted.

**The Drive scope is `drive.file`,** so the app sees only files it created itself. `ensureFolder()`'s search-by-name works solely because the app made that folder — code that expects to read pre-existing user files will fail. Holding this scope is what keeps the project out of Google's app-verification process.

**Sync is last-writer-wins on a single `journal-latest.json`,** updated in place rather than appended. `mergeEntries()` is additive-only, keyed by the client-generated `id`: it adds what is missing and never deletes or overwrites. Deletions do not propagate, and two devices syncing concurrently clobber each other. `scheduleSync()` debounces 20s after a mutation, runs only when a token is already live, and swallows failures on purpose — local data is safe and there is a manual button.

## Conventions

- UI strings are Hebrew and hardcoded inline; there is no i18n layer. Layout is RTL, so use logical CSS properties (`margin-inline-start`, `inset-inline`).
- All CSS lives in the `<style>` block of `index.html`, driven by custom properties with a `prefers-color-scheme` dark block.
- DOM access is by id through `$()`; list interactions are delegated on `#list` via `data-act` attributes.
- The service worker passes `googleapis.com` and `accounts.google.com` requests straight to the network — tokens and Drive responses have to be fresh.
