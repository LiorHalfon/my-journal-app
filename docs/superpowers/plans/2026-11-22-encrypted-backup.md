# Encrypted GitHub backup implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the never-used Google Drive backup with an automatic, encrypted backup to a private GitHub repo that keeps working offline, plus the hardening that goes with it: sealed exports, no Google code or fonts, a page security policy, and Android Background Sync.

**Architecture:** Four new modules, each hiding one thing. `vault.js` does the crypto and the recovery code. `github.js` is a stateless client for the four GitHub REST calls. `backup-store.js` keeps the backup settings in their own IndexedDB database. `backup.js` is the backup job: it decides whether to upload, seals and uploads under a Web Lock, and restores. `backup.js` and everything it imports run in both the page and the service worker, which is what lets Background Sync upload with the app closed. `app.js` and `view.js` replace the Drive sheet with key setup, account setup, status and restore.

**Tech Stack:** Native ES modules, no build step, no dependencies. WebCrypto (AES-256-GCM, SHA-256), IndexedDB, Web Locks, a module service worker with Background Sync, the GitHub REST API (version `2022-11-28`). Tests are throwaway: Node 24 for the pure modules, and same-origin check pages and a fake GitHub in Chrome for the rest.

**Spec:** `docs/superpowers/specs/2026-11-22-encrypted-backup-design.md`. Its "Hebrew copy" table and "The page security policy" string are used verbatim.

## Global Constraints

- No build step, no package manager, no dependencies, no committed tests. Test files live only in `$T`, defined under "Test setup".
- The entries database stays as it is: `journal`, `DB_VERSION` 1, store `entries`. Backup `SCHEMA` stays `1`. `entries-store.js` doesn't change.
- Backup settings live in IndexedDB `journal-backup` v1, store `settings`, under the record names `key`, `github` and `remote`. Their shapes are in the spec.
- No journal text leaves the device unsealed. Everything sent to GitHub and every exported file is the spec's sealed envelope. Plain JSON is accepted only on import.
- Raw key bytes exist only between creating or decoding a recovery code and `importKey`. They're never stored, and the `Uint8Array` is zeroed right after import. The stored `CryptoKey` has `extractable: false`.
- The token and the recovery code never appear in a log, URL, commit message, error message, `localStorage` or `sessionStorage`.
- Constants: file `journal.sealed.json`, commit message `backup`, Web Lock and Background Sync tag `journal-backup`, change debounce `20000` ms, stale after `3` days, GitHub API base `https://api.github.com`, header `X-GitHub-Api-Version: 2022-11-28`.
- `backup.js` and everything it imports must run in a service worker: no DOM, no `window`, no `document`, no direct `localStorage`. The wrappers in `local-storage.js` are fine.
- Only `view.js` touches the DOM. Screen state lives only in `app.js`. Every interpolated value goes through `escapeHtml()`, attributes included.
- Only the success path of `submit()` writes to `#composer`. Mutations keep the shape store write → `refreshEntries()` → `scheduleBackup()`.
- Automatic backups fail silently. Only actions the owner taps show error messages.
- UI strings are Hebrew, exactly as in the spec's copy table. Layout is RTL: use logical CSS properties and only the existing colour tokens. Touch targets are at least `2.75rem` tall. The recovery code, key id, repo and token are shown and typed `dir="ltr"`.
- Code comments are in Hebrew, like the surrounding files. Style: 2-space indent, double quotes, semicolons, trailing commas in multi-line literals.
- Work on branch `encrypted-backup`, created from `main` before Task 1. Never push: pushing `main` deploys to GitHub Pages.
- Commit messages: a plain imperative subject, a body that says why, and the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` at the end.
- `SHELL_FILES` in `sw.js` lists exactly the files that exist. Task 4 sets `VERSION` to `"v3"`. Later tasks keep `"v3"`, so the branch ships as one precache reset.

## Review Focus

1. **A new or wiped phone, with an empty journal, while the repo already holds a backup.** The owner expects the backup to wait for a restore, not to be replaced by an empty journal on the next launch. Automatic backup returns `"remote-exists"` and the sheet says to restore first. Pinned by Task 3 ("a device that never uploaded doesn't cover an existing backup") and Task 5 check B.
2. **A restore with the wrong key,** for example after making a new key instead of entering the code. The owner expects a "sealed with another key" message, with nothing imported and nothing uploaded over the backup. Pinned by Task 3 ("a restore with another key changes nothing") and Task 5 check C.
3. **A recovery code typed or pasted by hand:** lowercase, spaces, no hyphens, `O` for `0`, `I` or `L` for `1`, stray whitespace, one wrong, missing or swapped character. Equivalent codes are accepted. Anything else is rejected, never read as a different key. Pinned by Task 1.
4. **A public repo in the account form,** such as the app's own repo, which has to be public for Pages. It's refused, nothing is stored, nothing is uploaded. Pinned by Task 2 ("checkAccount refuses a public repo") and Task 3 ("saveAccount refuses a public repo").
5. **An interrupted backup:** offline, an expired token, GitHub 5xx, a stale `sha`, two triggers at once. Local entries are untouched, nothing half-written is recorded, the next trigger uploads, and after 3 days the dot turns red. Pinned by Task 3 (offline, auth, conflict and concurrency tests) and Task 4 checks F–H.

---

## Test setup (read once, used by every task)

```bash
REPO=/Users/liorhalfon/git/my-journal-app
T="<the executing session's scratchpad directory>/backup-tests"
mkdir -p "$T/node" "$T/www"
```

**Node (Tasks 1–2).** `$T/node/harness.mjs` exports `REPO` (from env, defaulting to the path above), `load(file)`, which imports a fresh copy of `"$REPO/<file>"` with a `?fresh=<n>` query, `test(name, fn)` and `run()`, which prints `ok`/`FAIL` lines and `N/M passed` and exits non-zero on any failure. Same shape as the harness in `docs/superpowers/plans/2026-10-05-folders.md` Task 1, minus the fake `localStorage`. Run a file with `node "$T/node/<name>.test.mjs"`. Exit code 0 means every test passed.

**The fake GitHub, `$T/www/fake-github.js`.** An ES module imported by the Node tests, the check pages and the fake-backed app. `createFakeGithub({ repo = "owner/journal-backup", token = "test-token", isPrivate = true, persistKey = null })` returns `fake` with:

- `fake.fetch(url, init)`. It rejects with `new TypeError("Failed to fetch")` while `fake.online` is `false`. Otherwise it records `{ method, url, headers, body }` in `fake.calls`, answers `401` unless `Authorization` is `Bearer <token>`, answers `404` for any other repo, and serves:
  - `GET /repos/{repo}` → `200 { full_name, private }`.
  - `GET /repos/{repo}/contents/journal.sealed.json[?ref=<commit>]` → `404` if there's no file at that ref. With an `Accept` containing `raw`, `200` with the file text. Otherwise `200 { sha, path }`.
  - `PUT /repos/{repo}/contents/journal.sealed.json` with body `{ message, content, sha? }`: `422` if the file exists and no `sha` was sent, `409` if `sha` isn't the current blob sha (including any `sha` when there's no file). Otherwise it stores `atob(content)` as a new version with blob sha `b<n>` and commit sha `c<n>`, and answers `201 { content: { sha }, commit: { sha } }`.
  - `GET /repos/{repo}/commits?path=journal.sealed.json&per_page=30` → newest first, `[{ sha, commit: { committer: { date } } }]`.
- `fake.online` (default `true`), `fake.calls`, `fake.commits` (newest first), `fake.head()` (the current file text or `null`), `fake.seed(text)` (a commit as if from another device), `fake.failNext(status, headers = {})` (the next request answers with that status), `fake.makePublic()`.
- With `persistKey`, state is loaded from and saved to `sessionStorage[persistKey]`, so it survives page reloads.

**Browser (Tasks 3–8).** `$T/serve.py`, run once in the background with `REPO="$REPO" python3 -I "$T/serve.py"`, serves on `http://localhost:8090`:

- `/__tests__/<path>` from `$T/www/<path>`, and everything else from `$REPO`.
- `/?fake=1` and `/index.html?fake=1`: `index.html` with `<script type="module" src="/__tests__/install-fake.js"></script>` inserted just before `<script type="module" src="app.js"></script>`.
- `Cache-Control: no-store` on every response, and `text/javascript` for `.js`.

`$T/www/install-fake.js` runs before `app.js` on `/?fake=1`. It creates a fake with `persistKey: "fake-github"` and installs `fake.fetch` as `window.fetch`. It overrides `navigator.onLine` with a getter returning `fake.online`, and adds `fake.setOnline(bool)`, which also fires `online`/`offline` on `window`. It replaces `SyncManager.prototype.register` with a recorder that pushes the tag onto `fake.syncTags` and registers nothing, so the real service worker never calls the real GitHub with the fake token. It exposes `window.fakeGithub = fake`. The fake account is repo `owner/journal-backup`, token `test-token`. Typing these into the app is fine: they are fake values for this app on localhost.

`$T/www/harness.js` exports `test(name, fn)` and `run()`. `run()` writes `ok`/`FAIL` lines into `<pre id="out">` and sets `document.title` to `PASS n/n` or `FAIL k/n`. A check page is `$T/www/<name>.check.html` loading `<name>.check.js` as a module. Open `http://localhost:8090/__tests__/<name>.check.html` in Chrome and read the page text.

Check pages and the app share the origin `localhost:8090`, so close any app tab on `:8090` before opening a check page. Each check page deletes `journal` and `journal-backup` before importing app modules, and fails with "close other :8090 tabs" if a deletion is blocked.

**Reset snippet for the app tab.** It wipes this origin's journal and settings and reloads. The fake repo survives in `sessionStorage`. Also run `sessionStorage.removeItem("fake-github")` to empty the repo.

```js
localStorage.clear();
let left = 2;
for (const name of ["journal", "journal-backup"]) {
  const wipe = indexedDB.deleteDatabase(name);
  wipe.onblocked = wipe.onsuccess = () => --left || location.reload();
}
"resetting";
```

---

### Task 1: `vault.js`, the key, the recovery code and the sealed envelope

**Files:**
- Create: `vault.js`
- Test: `$T/node/harness.mjs`, `$T/node/vault.test.mjs`

**Interfaces:**
- Consumes: nothing. Only the globals `crypto`, `TextEncoder`, `TextDecoder`, `btoa` and `atob`, which exist in browsers, service workers and Node 24.
- Produces (named exports of `vault.js`):
  - `newKeyBytes(): Uint8Array`, 32 random bytes
  - `toRecoveryCode(bytes: Uint8Array): Promise<string>`, 14 groups of 4 joined by `-`
  - `fromRecoveryCode(code: string): Promise<Uint8Array | null>`
  - `keyId(bytes: Uint8Array): Promise<string>`, 8 lowercase hex characters
  - `importKey(bytes: Uint8Array): Promise<CryptoKey>`, AES-GCM, 256-bit, `extractable: false`, usages `["encrypt", "decrypt"]`
  - `seal(key: CryptoKey, kid: string, text: string): Promise<string>`, the envelope JSON
  - `unseal(key: CryptoKey, kid: string, sealed: string): Promise<string>`
  - `isSealed(text: string): boolean`
  - `class VaultError extends Error` with `kind`: `"no-key" | "bad-code" | "wrong-key" | "corrupt"`
  - `describeVaultError(error: VaultError): string`

- [ ] **Step 1: Create the branch, then write the harness and the failing tests**

```bash
cd "$REPO" && git switch -c encrypted-backup
```

`$T/node/vault.test.mjs`:

```js
import assert from "node:assert/strict";
import { load, test, run } from "./harness.mjs";
const v = await load("vault.js");
const CODE = /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/;
const flat = (code) => code.replaceAll("-", "");

test("a recovery code round-trips to the same 32 bytes", async () => {
  const bytes = v.newKeyBytes();
  assert.equal(bytes.length, 32);
  const code = await v.toRecoveryCode(bytes);
  assert.match(code, CODE);
  assert.deepEqual(await v.fromRecoveryCode(code), bytes);
});

test("a hand-typed code reads as the same key", async () => {
  const zero = new Uint8Array(32);
  const code = await v.toRecoveryCode(zero);
  for (const typed of [code.toLowerCase(), code.replaceAll("-", " "), flat(code),
                       ` ${code}\n`, code.replaceAll("0", "O")])
    assert.deepEqual(await v.fromRecoveryCode(typed), zero, typed);
  const ones = new Uint8Array(32).fill(0x42);
  const withOnes = await v.toRecoveryCode(ones);
  assert.ok(withOnes.includes("1"));
  assert.deepEqual(await v.fromRecoveryCode(withOnes.replaceAll("1", "I")), ones);
  assert.deepEqual(await v.fromRecoveryCode(withOnes.replaceAll("1", "l")), ones);
});

test("a wrong, missing or swapped character is rejected", async () => {
  const code = flat(await v.toRecoveryCode(v.newKeyBytes()));
  for (let i = 0; i < code.length; i++) {
    const other = code[i] === "A" ? "B" : "A";
    assert.equal(await v.fromRecoveryCode(code.slice(0, i) + other + code.slice(i + 1)), null, `changed ${i}`);
    assert.equal(await v.fromRecoveryCode(code.slice(0, i) + code.slice(i + 1)), null, `dropped ${i}`);
    if (i && code[i] !== code[i - 1])
      assert.equal(await v.fromRecoveryCode(code.slice(0, i - 1) + code[i] + code[i - 1] + code.slice(i + 1)), null, `swapped ${i}`);
  }
  for (const junk of ["", "U".repeat(56), code + "A", "x".repeat(200)])
    assert.equal(await v.fromRecoveryCode(junk), null);
});

test("keyId is 8 hex characters and depends on the key", async () => {
  const a = v.newKeyBytes();
  assert.match(await v.keyId(a), /^[0-9a-f]{8}$/);
  assert.equal(await v.keyId(a), await v.keyId(a));
  assert.notEqual(await v.keyId(a), await v.keyId(v.newKeyBytes()));
});

test("importKey makes a non-extractable AES-256-GCM key", async () => {
  const key = await v.importKey(v.newKeyBytes());
  assert.equal(key.extractable, false);
  assert.equal(key.algorithm.name, "AES-GCM");
  assert.equal(key.algorithm.length, 256);
  await assert.rejects(crypto.subtle.exportKey("raw", key));
});

test("seal then unseal gives back the text, Hebrew and emoji included", async () => {
  const bytes = v.newKeyBytes(), key = await v.importKey(bytes), kid = await v.keyId(bytes);
  const text = "יום טוב 🌿\nשורה שנייה";
  assert.equal(await v.unseal(key, kid, await v.seal(key, kid, text)), text);
});

test("the envelope holds no plaintext and has exactly the spec's fields", async () => {
  const bytes = v.newKeyBytes(), key = await v.importKey(bytes), kid = await v.keyId(bytes);
  const sealed = await v.seal(key, kid, "סוד-שמור 12345");
  assert.ok(!sealed.includes("סוד") && !sealed.includes("12345"));
  const env = JSON.parse(sealed);
  assert.deepEqual(Object.keys(env).sort(), ["app", "data", "iv", "kid", "sealed"]);
  assert.equal(env.app, "tiny-journal");
  assert.equal(env.sealed, 1);
  assert.equal(env.kid, kid);
  assert.equal(atob(env.iv).length, 12);
  assert.notEqual(await v.seal(key, kid, "x"), await v.seal(key, kid, "x"));
});

test("isSealed tells a sealed file from a plain backup and from junk", async () => {
  const bytes = v.newKeyBytes(), key = await v.importKey(bytes);
  assert.equal(v.isSealed(await v.seal(key, await v.keyId(bytes), "x")), true);
  for (const text of ['{"app":"tiny-journal","schema":1,"entries":[]}', "not json", "null", "[]", ""])
    assert.equal(v.isSealed(text), false, text);
});

test("unseal reports wrong-key for another kid, corrupt for tampering", async () => {
  const a = v.newKeyBytes(), b = v.newKeyBytes();
  const keyA = await v.importKey(a), kidA = await v.keyId(a);
  const keyB = await v.importKey(b), kidB = await v.keyId(b);
  const sealed = await v.seal(keyA, kidA, "x");
  const kind = (p) => p.then(() => "none", (e) => e instanceof v.VaultError && e.kind);
  assert.equal(await kind(v.unseal(keyB, kidB, sealed)), "wrong-key");
  assert.equal(await kind(v.unseal(keyB, kidA, sealed)), "corrupt");
  const env = JSON.parse(sealed);
  const flip = (b64) => btoa(String.fromCharCode(...[...atob(b64)].map((c, i) => c.charCodeAt(0) ^ (i === 0))));
  assert.equal(await kind(v.unseal(keyA, kidA, JSON.stringify({ ...env, data: flip(env.data) }))), "corrupt");
  assert.equal(await kind(v.unseal(keyA, kidA, JSON.stringify({ ...env, iv: flip(env.iv) }))), "corrupt");
  assert.equal(await kind(v.unseal(keyA, kidA, "not json")), "corrupt");
});

test("every error kind has a Hebrew message", () => {
  for (const kind of ["no-key", "bad-code", "wrong-key", "corrupt"])
    assert.match(v.describeVaultError(new v.VaultError(kind)), /[א-ת]/, kind);
});

await run();
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `node "$T/node/vault.test.mjs"`
Expected: an import error for `vault.js`.

- [ ] **Step 3: Implement `vault.js`**

Use the algorithms and copy from the spec ("The recovery code", "The sealed file", the Hebrew error rows):

- Base32 works MSB-first: 32 bytes give 52 characters, the last one carrying 1 data bit and 4 zero bits. Then come the first 20 bits of SHA-256(bytes) as 4 more characters.
- `fromRecoveryCode` normalizes as the spec says, and returns `null` unless the length is 56, the padding bits are zero and the checksum matches.
- `keyId` is the hex of the first 4 bytes of the same SHA-256.
- Base64 goes through `btoa`/`atob` over a binary string, built in chunks so that a large journal doesn't overflow `String.fromCharCode(...)`.
- `unseal` checks `kid` before decrypting. Any failure to parse the envelope or to decrypt becomes `VaultError("corrupt")`.
- `VaultError` and `describeVaultError` follow the shape of `DriveError`/`describeDriveError` in `drive.js:25-32` and `drive.js:292-314`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `node "$T/node/vault.test.mjs"`
Expected: `10/10 passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add vault.js
git commit -m "Add the vault: encryption key, recovery code and sealed file"
```

---

### Task 2: `github.js`, the GitHub client

**Files:**
- Create: `github.js`
- Test: `$T/www/fake-github.js`, `$T/node/github.test.mjs`

**Interfaces:**
- Consumes: the globals `fetch` and `navigator.onLine`. Offline means `navigator.onLine === false`. Node's `navigator` has no `onLine`, and that counts as online.
- Produces (named exports of `github.js`):
  - `type Account = { repo: string, token: string }`
  - `FILE_PATH = "journal.sealed.json"`
  - `parseRepo(raw: string): string`, either `"owner/name"` or `""`
  - `checkAccount(account: Account): Promise<void>`
  - `currentSha(account: Account): Promise<string | null>`, the blob sha, or `null` with no file
  - `upload(account: Account, text: string, sha: string | null): Promise<string>`, the new blob sha
  - `listVersions(account: Account): Promise<{ commit: string, at: string }[]>`, newest first, at most 30
  - `download(account: Account, commit?: string): Promise<string>`
  - `class GithubError extends Error` with `kind`: `"offline" | "auth" | "denied" | "missing" | "conflict" | "busy" | "public" | "bad-repo" | "http"`, and `status`
  - `describeGithubError(error: GithubError): string`

- [ ] **Step 1: Write the fake GitHub (contract under "Test setup") and the failing tests**

`$T/node/github.test.mjs`, written in the same style as Task 1. The tests, by name, with their assertions:

- `parseRepo accepts owner/name and GitHub URLs`: `"LiorHalfon/journal-backup"`, `" LiorHalfon/journal-backup "`, `"https://github.com/LiorHalfon/journal-backup"`, `"https://github.com/LiorHalfon/journal-backup.git"` and `"github.com/LiorHalfon/journal-backup/"` all give `"LiorHalfon/journal-backup"`.
- `parseRepo rejects anything else`: `""`, `"owner"`, `"a/b/c"`, `"owner/re po"`, `"owner/"` and `"https://gitlab.com/a/b"` give `""`.
- `checkAccount accepts a private repo`: resolves. One call, `GET https://api.github.com/repos/owner/journal-backup`, with headers `Authorization: Bearer test-token`, `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`.
- `checkAccount refuses a public repo`: after `fake.makePublic()`, rejects with kind `"public"`.
- `checkAccount maps an unknown repo and a bad token`: `{ repo: "owner/other" }` gives `"missing"`, `{ token: "nope" }` gives `"auth"`.
- `upload creates, then updates with the sha it got`: `currentSha` is `null`. `upload(a, "v1", null)` returns `s1`, the PUT body has `message === "backup"` and `atob(content) === "v1"`. `currentSha` is now `s1`. `upload(a, "v2", s1)` returns a new sha, and `fake.head() === "v2"`.
- `upload reports conflict for a stale or missing sha`: with a file present, `upload(a, "x", "stale")` and `upload(a, "x", null)` both reject with `"conflict"`.
- `listVersions is newest first`: after three uploads, three items, with `commit` equal to `fake.commits[i].sha` and `at` a parseable date. The request URL contains `path=journal.sealed.json` and `per_page=30`.
- `download gets the latest or a given version as raw text`: `download(a)` is the last text, and `download(a, firstCommit)` is the first text. The request's `Accept` is `application/vnd.github.raw+json`.
- `offline is reported without a request`: with `navigator.onLine` set to `false`, `checkAccount`, `currentSha`, `upload`, `listVersions` and `download` each reject with `"offline"`, and `fake.calls` stays empty.
- `a network failure counts as offline`: with `fake.online = false`, `"offline"`.
- `statuses map to kinds`: through `failNext`, 401 gives `auth`, 403 `denied`, 403 with `x-ratelimit-remaining: 0` `busy`, 404 `missing`, 429 `busy`, 502 `busy`, and 418 `http` with `status === 418`.
- `every kind has a Hebrew message`: all nine kinds match `/[א-ת]/`, and the `http` message includes `418`.
- `nothing goes to any host but api.github.com`: every recorded URL starts with `https://api.github.com/`.

Set `navigator.onLine` with `Object.defineProperty(globalThis.navigator, "onLine", { get: () => online, configurable: true })`, and set `globalThis.fetch = fake.fetch` before each test.

- [ ] **Step 2: Run the tests and see them fail**

Run: `node "$T/node/github.test.mjs"`
Expected: an import error for `github.js`.

- [ ] **Step 3: Implement `github.js`**

- One private `request(account, method, path, { body, raw })` adds the headers above, maps a `fetch` rejection to `offline`, maps statuses as in the tests, and on PUT maps both 409 and 422 to `conflict`.
- `upload` sends `content: btoa(text)`. The envelope is ASCII. It includes `sha` only when non-null and returns `response.content.sha`.
- `checkAccount` throws `public` unless `private === true`.
- Messages come from the spec's copy table.

- [ ] **Step 4: Run the tests and see them pass**

Run: `node "$T/node/github.test.mjs"`
Expected: `14/14 passed`.

- [ ] **Step 5: Commit**

```bash
git add github.js
git commit -m "Add a GitHub client for the backup file"
```

---

### Task 3: `backup-store.js` and `backup.js`, the backup job

**Files:**
- Create: `backup-store.js`, `backup.js`
- Test: `$T/serve.py`, `$T/www/harness.js`, `$T/www/backup.check.html`, `$T/www/backup.check.js`

**Interfaces:**
- Consumes: everything Task 1 and Task 2 produce. From the existing code, `open`, `readAll`, `put`, `remove` and `addMissing` in `entries-store.js`, and `serializeEntries` and `readEntries` in `backup-file.js`. The caller must already have run `store.open()`.
- Produces:
  - `backup-store.js`: `get(name): Promise<any>` (`undefined` when absent), `set(name, value): Promise<void>`, `remove(name): Promise<void>`. Names are `"key" | "github" | "remote"`. The database opens lazily on first use.
  - `backup.js`:
    - `SYNC_TAG = "journal-backup"`, also the Web Lock name
    - `status(): Promise<{ kid: string | null, repo: string | null, confirmedAt: number | null }>`
    - `newRecoveryCode(): Promise<string>`
    - `saveKey(code: string): Promise<string>`, the kid. Throws `VaultError("bad-code")` and leaves the old key in place. Leaves `remote` untouched.
    - `saveAccount(repo: string, token: string): Promise<string>`, the clean repo. Throws `GithubError` `bad-repo`, or `auth` for an empty token, before any request. Throws whatever `checkAccount` throws. Stores nothing on failure. On success it clears `remote` only when the repo differs from the stored one, so a renewed token for the same repo doesn't block backups.
    - `backupIfChanged({ force = false } = {}): Promise<"uploaded" | "unchanged" | "not-ready" | "remote-exists">`
    - `listVersions(): Promise<{ commit: string, at: string }[]>`
    - `restoreVersion(commit: string): Promise<number>`, the number of entries added
    - `exportFile(): Promise<string>`, sealed, or `VaultError("no-key")`
    - `importFile(text: string): Promise<number>`, the number added
    - `describeBackupError(error: unknown): string`

- [ ] **Step 1: Write `serve.py`, the browser harness and the failing checks**

`$T/www/backup.check.js` imports `/entries-store.js`, `/backup-store.js`, `/backup.js` and `/vault.js` from the app, plus `./harness.js` and `./fake-github.js`. Before each test, it removes every entry and the three settings through the modules' own functions, makes a fresh fake, installs its `fetch` and makes `navigator.onLine` follow `fake.online`. `setUp()` saves a fresh code and the fake account. `seed(n)` puts `n` entries with texts `רשומה <i>`. The tests:

- `nothing uploads before a key and an account exist`: `"not-ready"` with neither, and again with only a key. `fake.calls.length === 0`.
- `saveKey stores a non-extractable key`: `(await settings.get("key")).key.extractable === false`, and `status().kid` equals the returned kid.
- `saveKey rejects a mistyped code and keeps the old key`: after a good `saveKey`, `saveKey("1234")` rejects with `bad-code` and `status().kid` is unchanged.
- `saveAccount refuses a public repo and stores nothing`: after `fake.makePublic()`, `public`, and `settings.get("github")` is `undefined`.
- `saveAccount refuses a malformed repo without a request`: `saveAccount("owner", "t")` gives `bad-repo`, and `fake.calls.length === 0`.
- `the first backup to an empty repo uploads a sealed file`: `setUp(); seed(2)` gives `"uploaded"`. `vault.isSealed(fake.head())` is true, and `fake.head()` doesn't include `"רשומה"`.
- `a backup restores to the same entries`: after the upload, remove both entries, then `restoreVersion(fake.commits[0].sha) === 2` and the texts match.
- `a run with no changes uploads nothing and refreshes confirmedAt`: a second run gives `"unchanged"` with the PUT count unchanged, and `status().confirmedAt` doesn't go down.
- `an edit uploads again`: `store.put` a changed entry gives `"uploaded"`, and `fake.commits.length === 2`.
- `a device that never uploaded doesn't cover an existing backup`: `fake.seed(<a file sealed with this key on another device>)`, `setUp()` with no entries gives `"remote-exists"`, and there's no PUT. With `{ force: true }` it gives `"uploaded"`.
- `after a restore, the next backup uploads the merged journal`: after `"remote-exists"`, `restoreVersion(latest)` and `seed(1)`, the run gives `"uploaded"`. `fake.head()` unseals, through `importFile` on a cleared journal, to the restored entries plus the new one.
- `a restore with another key changes nothing`: the backup is sealed under key A and this device has key B. `restoreVersion(latest)` rejects with `wrong-key`, entries are unchanged, `settings.get("remote")` is `undefined`, and the next `backupIfChanged()` still gives `"remote-exists"`.
- `a stale sha is retried once`: after an upload, `settings.set("remote", { ...remote, sha: "stale" })` and an edit give `"uploaded"`, with exactly 2 PUTs in that run (409, then success).
- `offline changes nothing and reports offline`: with `fake.online = false`, an edit rejects with `offline`, and `remote` and the entries are unchanged. Back online, the run gives `"uploaded"`.
- `an expired token reports auth and changes nothing`: `failNext(401)` gives `auth`, entries are unchanged, `remote` is unchanged.
- `GitHub 5xx reports busy`: `failNext(502)` gives `busy`.
- `two runs at once upload once`: `Promise.all([backupIfChanged(), backupIfChanged()])` gives one `"uploaded"` and one `"unchanged"`, with 1 PUT.
- `a new key re-encrypts on the next run`: `saveKey(newCode)` then a run gives `"uploaded"`, and `JSON.parse(fake.head()).kid` is the new kid.
- `a new token for the same repo keeps remote; another repo clears it`: after an upload, `saveAccount("owner/journal-backup", "test-token")` leaves `remote` as it was, and the next run gives `"unchanged"`. Switch `fetch` to a second fake built with `repo: "owner/other"`, and `saveAccount("owner/other", "test-token")` leaves `settings.get("remote")` `undefined`.
- `exportFile is sealed and importFile reads it back`: the export passes `isSealed` and doesn't contain `"רשומה"`. Clear the entries, and `importFile(export) === 2`.
- `exportFile without a key reports no-key`.
- `importFile still reads an old plain export`: `importFile(serializeEntries(entries)) === n` on a cleared journal.
- `importFile reports corrupt for junk`: `"hello"` gives `corrupt`.
- `listVersions is newest first`: after two uploads, `[0].commit === fake.commits[0].sha`.
- `describeBackupError covers both error classes and anything else`: a `VaultError("wrong-key")` and a `GithubError("auth")` give their spec copy, and `new Error("x")` gives `הגיבוי נכשל.`

- [ ] **Step 2: Run the checks and see them fail**

Start `serve.py` in the background, open `http://localhost:8090/__tests__/backup.check.html`, and read the page text.
Expected: the title isn't `PASS`, and the page shows the import failure for `/backup.js`.

- [ ] **Step 3: Implement `backup-store.js`**

A key/value store over IndexedDB `journal-backup` v1, store `settings` with out-of-line keys. The value is stored as is, which is how a `CryptoKey` gets stored. Use `toPromise` from `entries-store.js:12-17` as the pattern, but keep the code here: `entries-store.js` doesn't change.

- [ ] **Step 4: Implement `backup.js`**

`backupIfChanged` runs entirely inside `navigator.locks.request(SYNC_TAG, …)`:

1. It needs both the `key` and the `github` settings, otherwise `"not-ready"`.
2. It computes `fingerprint` from `kid` and `store.readAll()`, as the spec says.
3. Unless `force`: if `remote.fingerprint === fingerprint`, it sets `confirmedAt = Date.now()` and returns `"unchanged"`. If `remote` is missing and `currentSha()` isn't `null`, it returns `"remote-exists"`.
4. It seals `serializeEntries(entries)` and uploads with `remote?.sha ?? null`. On `conflict` or `missing` it calls `currentSha()` and uploads once more with that.
5. It sets `remote = { sha, fingerprint, confirmedAt: Date.now() }` and returns `"uploaded"`.

`restoreVersion` and `importFile` share a private `readBackupText(text)`. A sealed file needs the key (`no-key` otherwise) and is unsealed, then parsed with `readEntries`. Any parse failure becomes `VaultError("corrupt")`. After its `addMissing`, `restoreVersion` sets `remote = { sha: null, fingerprint: "", confirmedAt: null }`, but only when `remote` is missing. `saveKey` zeroes the bytes after `importKey`.

- [ ] **Step 5: Run the checks and see them pass**

Reload the check page.
Expected: title `PASS 25/25`.

- [ ] **Step 6: Commit**

```bash
git add backup-store.js backup.js
git commit -m "Add the backup job: seal, upload when changed, restore"
```

---

### Task 4: The backup sheet, automatic backups, and Drive's removal

**Files:**
- Modify: `index.html`
  - meta description, line 7
  - sheet markup, lines 259–294
  - CSS for the setup section, after `.notice`, line 199
  - the Google sign-in script, line 298, deleted
- Modify: `view.js`. Replace `renderSyncStatus` (lines 283–296) and add `renderBackupSetup`.
- Modify: `app.js`
  - imports, lines 5–14
  - state, lines 22–32
  - `scheduleAutoSync`, lines 105–112, becomes `scheduleBackup`
  - the backup actions, lines 183–243
  - `wireBackupSheet`, lines 488–527
  - boot, lines 529–584
- Modify: `sw.js`
  - `VERSION = "v3"`
  - `SHELL_FILES` without `config.js` and `drive.js`, with `vault.js`, `github.js`, `backup-store.js` and `backup.js`
  - the `googleapis.com` / `accounts.google.com` branch, lines 70–74, deleted
- Modify: `manifest.webmanifest` description. Both descriptions become `יומן אישי מינימליסטי עם גיבוי מוצפן`.
- Modify: `README.md`, `CLAUDE.md`
- Delete: `drive.js`, `config.js`
- Test: `$T/www/install-fake.js`. The checks below run in Chrome on `http://localhost:8090/?fake=1`.

**Interfaces:**
- Consumes: `backup.js` from Task 3, except restore, export and import, which come in Task 5.
- Produces:
  - `view.renderBackupStatus({ kid, repo, confirmedAt, blocked }): void` sets the dot's class (`on` when fresh, `warn` when stale, none when not set up), its title, and the text and warn style of `#sheetSub`, choosing among the spec's five status rows. It enables `#backupBtn` only when `kid && repo`. Staleness is `confirmedAt` older than `STALE_AFTER_DAYS = 3`, a constant in `view.js`. The day count is `Math.floor(age / 86400000)`.
  - `view.renderBackupSetup({ kid, repo, panel, code, error }): void` rebuilds `#backupSetup` only.
    - `panel` is `null | "new-key" | "enter-code" | "account"`.
    - Buttons: `data-act` `new-key`, `enter-code`, `copy-code`, `confirm-code`, `save-code`, `edit-account`, `save-account`, `cancel-setup`.
    - Fields: `data-role` `codebox`, `repobox`, `tokenbox`. The token field is `type="password"`, and every field has `autocomplete="off"`, `spellcheck="false"`, `autocapitalize="off"` and `dir="ltr"`.
    - `error` is shown in a `.notice.bad` inside the open panel.
  - In `app.js`:
    - state `setupPanel`, `pendingCode`, `setupError`, `backupBlocked`
    - `backupQuietly(): Promise<string | null>`, which sets `backupBlocked = result === "remote-exists"`, re-renders the status, and returns `null` on any error
    - `scheduleBackup()`, the 20 s debounce into `backupQuietly`
    - `backupNow()`, the manual run with `{ force: true }` through `runExclusive`. It shows `גובה. {count} רשומות.`, toasts `גובה`, and shows `describeBackupError` on failure.

- [ ] **Step 1: Write `install-fake.js` (contract under "Test setup")**

- [ ] **Step 2: Rebuild the sheet markup and CSS**

- The sheet gets this order: `#sheetSub`, then `<div id="backupSetup">`, then the `#backupBtn` action, then the existing divider, export and import actions, `#sheetNotice` and `#backupList`.
- The setup sections reuse the existing `.action`, `.tbtn`, `.notice` and `.folder-panel` styles.
- The recovery code is shown in a monospace block, `dir="ltr"`, with `user-select: all`. It wraps by groups and never scrolls the page sideways.

- [ ] **Step 3: Implement the view functions, then the wiring in `app.js`**

- Clicks are delegated on `#backupSetup`.
- `new-key` sets `pendingCode = await backup.newRecoveryCode()`. `copy-code` uses `navigator.clipboard.writeText` and the spec's toast. `confirm-code` and `save-code` call `backup.saveKey`, and `save-account` calls `backup.saveAccount`. Each success closes the panel, clears `pendingCode`, re-renders the status and calls `backupQuietly()`. A failure sets `setupError` from `describeBackupError` and keeps the typed text.
- Only setup actions call `renderBackupSetup`, so a status refresh never wipes a half-typed field.
- `pendingCode` lives only in memory.
- Triggers for `backupQuietly()`: boot after `store.open()`, `online`, and `visibilitychange` in both directions. After each mutation, `scheduleBackup()`.
- Delete `drive.js` and `config.js`, and every reference to them, `connectBtn`, `syncBtn` and `snapshotBtn`.
- Keep `exportToFile` and `importFromFile` as they are for now. Task 5 changes them.

- [ ] **Step 4: Update `sw.js`, the manifest, `README.md` and `CLAUDE.md`**

- `README.md`, in Hebrew:
  - The intro says the backup is encrypted on the phone and goes to a private GitHub repo.
  - The file list drops `config.js` and `drive.js` and adds the four new modules.
  - Section 1 becomes "מאגר הגיבוי": create a private repo; create a fine-grained token under Only select repositories for that repo with Repository permissions → Contents: Read and write and nothing else; pick an expiration; paste the token in "מאגר GitHub" on each device.
  - The "גיבוי" section describes the automatic triggers, versions as commits, the additive restore and the sealed envelope.
  - Replace "אין הצפנה בצד לקוח" with the recovery-code warning from the spec.
  - The two-device paragraphs say the app is built for one writing device.
- `CLAUDE.md`:
  - "What this is" and the module table: remove `config.js` and `drive.js`, add `vault.js`, `github.js`, `backup-store.js` and `backup.js`, each with what it owns.
  - Remove the "Drive backup stays inert" paragraph.
  - In Architecture, replace the four Drive paragraphs with: the two error classes and `describeBackupError`; the non-extractable key and what never gets stored; `fingerprint`, the `remote-exists` rule and the Web Lock; and "`backup.js` runs in the service worker too: no DOM, no `localStorage`".
  - In Conventions, drop the line about passing `googleapis.com` through.

- [ ] **Step 5: Check it in the browser**

Close every `:8090` tab, run the reset snippet with `sessionStorage.removeItem("fake-github")`, and open `http://localhost:8090/?fake=1`. Each check is something to do and something to see:

- A. **Fresh start.** Open the sheet. It shows `הגיבוי עוד לא הוגדר. הרשומות שמורות רק במכשיר הזה.`, the dot has neither `on` nor `warn`, its title is `גיבוי לא הוגדר`, and `#backupBtn` is disabled.
- B. **Key.** Tap `יצירת מפתח`. A code matching the Task 1 pattern appears. `ביטול` leaves no key, and tapping `יצירת מפתח` again gives a different code. `שמרתי את הקוד` shows `מפתח פעיל · <8 hex>`. `מפתח חדש` shows the extra "previous backups stay locked" note.
- C. **Account.** Run `fakeGithub.makePublic()`, then save `owner/journal-backup` / `test-token`: the `public` message appears in the panel and the typed repo is still there. Run `sessionStorage.removeItem("fake-github")` and reload, which gives a private fake while the key stays. Save the account again, and the panel shows `owner/journal-backup`. Within a second `fakeGithub.commits.length === 1`, and the status reads `גובה לאחרונה: …`.
- D. **Automatic after a change.** Write an entry and wait 21 s: there's one more commit. Write another and immediately fire `document.dispatchEvent(new Event("visibilitychange"))`: a commit lands without waiting.
- E. **Draft safety.** With text in the composer, open and close the sheet, open and cancel each panel, run `גיבוי עכשיו`. The composer text is unchanged.
- F. **Offline.** `fakeGithub.setOnline(false)`, then write an entry: no new commit, and no toast or notice. `fakeGithub.setOnline(true)`: a commit appears within a second.
- G. **Token expired.** `fakeGithub.failNext(401)`, then tap `גיבוי עכשיו`: the spec's `auth` message appears. Do the same with no tap (write an entry, wait 21 s): nothing is shown.
- H. **Stale.** In the console, set `remote.confirmedAt` to 4 days ago through `/backup-store.js`. Then `fakeGithub.setOnline(false)`, write an entry so there's a change that can't go out, and reload. The dot has `warn`, its title is `הגיבוי האחרון לפני 4 ימים`, and the sheet shows `הגיבוי האחרון לפני 4 ימים.` With no unsent change, the same steps show the fresh status instead: an unchanged journal counts as confirmed without a request.
- I. **No Google.** Read the network requests: none go to a Google host, and none ask for `drive.js` or `config.js`. `caches.open("journal-shell-v3")` then `.keys()` has exactly one entry per `SHELL_FILES` item.
- J. **Offline launch.** Stop `serve.py` and reload: the app loads from the service worker with its entries. Then restart `serve.py`.

- [ ] **Step 6: Commit**

```bash
git add -A index.html view.js app.js sw.js manifest.webmanifest README.md CLAUDE.md drive.js config.js
git commit -m "Back up to GitHub automatically, and remove Google Drive"
```

---

### Task 5: Restore, sealed export and import

**Files:**
- Modify: `index.html`. Add a `#restoreBtn` action after `#backupBtn`, and use the spec's copy for the export and import actions.
- Modify: `view.js`. `renderBackupList` (lines 336–352) becomes `renderVersionList`. `renderBackupStatus` also enables `#restoreBtn` when `kid && repo`, and `#exportBtn` when `kid`, with export's small text set to `צריך קודם מפתח הצפנה` otherwise.
- Modify: `app.js`. `showBackups`, `restoreFrom`, `exportToFile`, `importFromFile` (lines 232–295) and their wiring.
- Test: Chrome on `http://localhost:8090/?fake=1`.

**Interfaces:**
- Consumes: `listVersions`, `restoreVersion`, `exportFile`, `importFile` and `describeBackupError` from `backup.js`.
- Produces:
  - `view.renderVersionList(versions: { commit, at }[]): void`. Items are `<button class="backup-item" data-commit="…">`, labelled with `shortStampOf` of `at`, under the spec's heading. An empty list shows `אין עדיין גרסאות במאגר.`
  - Restore success shows the spec's notice and toast, then `refreshEntries()`, `backupBlocked = false` and `backupQuietly()`.
  - Export goes through the existing anchor-download code, with the content from `backup.exportFile()` and the filename from `timestampedFilename()`.
  - Every failure in these four flows shows `describeBackupError`. `BAD_BACKUP_MESSAGE` goes away.

- [ ] **Step 1: Implement the markup, view and wiring above**

- [ ] **Step 2: Check it in the browser**

- A. **Versions.** With 3 commits in the fake, `שחזור` lists 3 items, newest first. Delete one entry in the app, tap the newest version, and `שוחזרו 1 רשומות.` appears with the entry back.
- B. **New phone.** Create a key and read the code off the screen before confirming it. Save the account, write two entries and let them upload. Run the reset snippet without clearing the fake, enter the code through `יש לי קוד שחזור`, and save the account. The status shows the `remote-exists` row and no commit is added. Restore the newest version: the entries come back, the status turns fresh, and one new commit appears.
- C. **Wrong key.** Run the reset snippet without clearing the fake, make a new key with `יצירת מפתח`, save the account, and restore the newest version. The `wrong-key` message appears, the list is still empty, `fakeGithub.commits.length` is unchanged, and the status still shows the `remote-exists` row.
- D. **Sealed export.** With no key, the export action is disabled and shows `צריך קודם מפתח הצפנה`. With a key, export writes `~/Downloads/journal-*.json`. Check the newest one:

```bash
f=$(ls -t ~/Downloads/journal-*.json | head -1)
python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sorted(d), d["sealed"])' "$f"
grep -c "רשומה" "$f"
```

Expected: `['app', 'data', 'iv', 'kid', 'sealed'] 1`, then `0`. Delete the test file afterwards.
- E. **Import.** On a reset origin with the same code entered, importing that file gives `יובאו N רשומות.` Importing an old plain export, made in Node with `serializeEntries`, works too. Importing a text file gives the `corrupt` message.

- [ ] **Step 3: Commit**

```bash
git add index.html view.js app.js
git commit -m "Restore from GitHub versions, and seal exports"
```

---

### Task 6: Serve the fonts with the app

**Files:**
- Create: `fonts/assistant-hebrew.woff2`, `fonts/assistant-latin.woff2`, `fonts/heebo-hebrew.woff2`, `fonts/heebo-latin.woff2`, `fonts/OFL-Assistant.txt`, `fonts/OFL-Heebo.txt`
- Modify: `index.html`. Delete lines 17–19, the two preconnects and the Google Fonts stylesheet, and add four `@font-face` rules at the top of `<style>`.
- Modify: `sw.js`. Add the four `.woff2` files to `SHELL_FILES`, and delete the `FONTS` cache name, its use in `activate` and the font branch in `fetch`, lines 76–88.
- Modify: `CLAUDE.md`, the Heebo/Assistant convention line (fonts live in `fonts/`), and the `README.md` file list.

**Interfaces:**
- Consumes: nothing new.
- Produces: same-origin font files that the shell precaches.

- [ ] **Step 1: Ask the owner before downloading**

Ask for one approval covering four font files from `fonts.gstatic.com` (about 30–60 KB each) and the two license files from `raw.githubusercontent.com/google/fonts/main/ofl/{assistant,heebo}/OFL.txt`.

- [ ] **Step 2: Download into an empty folder, then copy in**

Fetch `https://fonts.googleapis.com/css2?family=Assistant:wght@200..700&family=Heebo:wght@200..800&display=swap` with a current desktop Chrome `User-Agent` string, so Google returns woff2, and no other identifying headers. From the `/* hebrew */` and `/* latin */` blocks of each family, download the `src` URL and keep the `font-weight` range and `unicode-range`. Write each `@font-face` with `font-family` (`"Assistant"` or `"Heebo"`), the weight range, `font-display: swap`, `src: url("fonts/<file>") format("woff2")` and the copied `unicode-range`.

- [ ] **Step 3: Check it in the browser**

- No request goes to `fonts.googleapis.com` or `fonts.gstatic.com`.
- After load, `[...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family)` includes `Assistant` and `Heebo`.
- A screenshot of the list and composer looks like `main`: Heebo for entry text, Assistant for the rest.
- Stop `serve.py` and reload: the same fonts load from the cache.

- [ ] **Step 4: Commit**

```bash
git add fonts index.html sw.js CLAUDE.md README.md
git commit -m "Serve the fonts with the app instead of from Google"
```

---

### Task 7: Android Background Sync

**Files:**
- Modify: `sw.js`. Make it a module, `import * as store from "./entries-store.js"` and `import { SYNC_TAG, backupIfChanged } from "./backup.js"`, and add a `sync` listener.
- Modify: `app.js`. Register with `{ type: "module" }` (`registerServiceWorker`, lines 545–552), and add `requestBackgroundSync()`, called from `backupQuietly` on `offline` or `busy`.
- Modify: `CLAUDE.md`. Add a gotcha: `sw.js` is a module, its imports must exist and stay free of DOM, and a failed import breaks offline silently, like a bad `SHELL_FILES` entry.

**Interfaces:**
- Consumes: `SYNC_TAG` and `backupIfChanged` from `backup.js`, and `open` from `entries-store.js`.
- Produces:
  - In `sw.js`: on `sync` with `event.tag === SYNC_TAG`, `event.waitUntil(store.open().then(() => backupIfChanged()))`. A rejection makes the browser retry later. `"not-ready"` and `"remote-exists"` resolve, so they stop the retries.
  - In `app.js`: `requestBackgroundSync(): void`. It does `navigator.serviceWorker.ready.then((reg) => reg.sync?.register(SYNC_TAG))` and swallows every failure. Without `SyncManager`, nothing happens.

- [ ] **Step 1: Implement the two changes above**

- [ ] **Step 2: Check it in the browser**

- A. After a reload, `(await navigator.serviceWorker.getRegistration()).active.scriptURL` ends with `/sw.js`, `navigator.serviceWorker.controller` isn't `null`, and `caches.keys()` is `["journal-shell-v3"]`.
- B. `fakeGithub.setOnline(false)`, write an entry, fire `visibilitychange`: `fakeGithub.syncTags` includes `"journal-backup"`. Online, with an unchanged journal, nothing is added.
- C. Stop `serve.py` and reload: the app still loads offline.

The `sync` handler itself runs against the real GitHub in Task 9, because the fake can't reach into the service worker.

- [ ] **Step 3: Commit**

```bash
git add sw.js app.js CLAUDE.md
git commit -m "Retry backups through Android Background Sync"
```

---

### Task 8: The page security policy

**Files:**
- Modify: `index.html`. Right after `<meta charset="utf-8">`, add `<meta http-equiv="Content-Security-Policy" content="…">` with the spec's policy verbatim, and `<meta name="referrer" content="no-referrer">`.
- Modify: `CLAUDE.md`. Add a convention: the page may load only its own files and send requests only to `api.github.com`, so a new host means editing the policy, and the policy is a `<meta>` because Pages can't set headers.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Add the two meta tags**

- [ ] **Step 2: Check it in the browser**

- A. On `/?fake=1`, go through boot, writing, the sheet, key and account setup, `גיבוי עכשיו`, restore, export and import. `read_console_messages` with pattern `Content Security Policy` finds nothing.
- B. On `/`, with no fake: `await fetch("https://example.com").then(() => "sent", () => "blocked")` gives `"blocked"`, and the console shows a `connect-src` violation. Appending a `<script src="https://example.com/x.js">` shows a `script-src` violation.
- C. Export still downloads, and the service worker still registers: Task 7 check A passes.

- [ ] **Step 3: Commit**

```bash
git add index.html CLAUDE.md
git commit -m "Limit the page to its own files and the GitHub API"
```

---

### Task 9: End to end against the real GitHub, then the phone

This task needs the owner. The agent never types or reads the token, and never toggles the Mac's network.

**Files:** none. This is verification only.

- [ ] **Step 1: The owner prepares a throwaway test repo**

The owner either creates a private repo `journal-backup-test`, or approves `gh repo create LiorHalfon/journal-backup-test --private`. Then the owner creates a fine-grained token for that repo only, with Contents read and write and a 7-day expiration.

- [ ] **Step 2: Run the branch on a clean origin with the real API**

Run `cd "$REPO" && python3 -m http.server 8091` in the background, and open `http://localhost:8091/` with no `?fake`. The owner creates a test key and pastes the repo and token. The agent writes two entries containing `בדיקת-גיבוי-7319`, then waits for a commit.

```bash
gh api repos/LiorHalfon/journal-backup-test/commits --jq 'length'
gh api repos/LiorHalfon/journal-backup-test/contents/journal.sealed.json -H "Accept: application/vnd.github.raw+json" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(sorted(d), d["sealed"])'
gh api repos/LiorHalfon/journal-backup-test/contents/journal.sealed.json -H "Accept: application/vnd.github.raw+json" | grep -c "בדיקת-גיבוי" || true
```

Expected: at least `1`, then `['app', 'data', 'iv', 'kid', 'sealed'] 1`, then `0`. In the console, `read_console_messages` with pattern `Content Security Policy` finds nothing. That confirms the raw download isn't redirected off `api.github.com`.

- [ ] **Step 3: Restore on a second clean origin**

Run `python3 -m http.server 8092` from `$REPO`, and open `http://localhost:8092/`. The owner enters the test code and the token. The status shows the `remote-exists` row. Restoring the newest version brings both entries back.

- [ ] **Step 4: Background Sync with the tab closed**

The owner turns Wi-Fi off. The agent writes an entry on `:8091` and closes the tab. The owner turns Wi-Fi on. Within about a minute, the commit count from Step 2 grows by one.

- [ ] **Step 5: Clean up**

The owner revokes the test token. The owner deletes `journal-backup-test` themselves, or approves `gh repo delete LiorHalfon/journal-backup-test --yes` after being told it's permanent. Stop the `:8091` and `:8092` servers and `serve.py`.

- [ ] **Step 6: Hand over for merge and the phone**

Merging and pushing `main` is the owner's call, because pushing deploys. After the deploy, on the phone:

- Open the app, so the new version loads on that launch.
- Create the real key and save the code in the password manager.
- Paste the real private repo and a token for it, and see the first commit.
- In airplane mode, write an entry and close the app. Turn airplane mode off, and see the commit appear without opening the app.
- In airplane mode, reopen the app: it launches with its fonts.
