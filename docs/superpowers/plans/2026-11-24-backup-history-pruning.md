# Backup history pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the backup repo's `main` at 60 commits or fewer by rebuilding the newest 30 as a new chain after an upload, moving the branch only if it hasn't moved.

**Architecture:** `github.js` gains `pruneHistory(account)`, which checks the length, rebuilds the newest 30 commits through `POST /git/commits` and moves the branch with GraphQL `updateRefs` and `beforeOid`. `backup.js` calls it after a successful upload, inside the Web Lock, and swallows its failures.

**Tech Stack:** Native ES modules, `fetch`, GitHub REST and GraphQL. Throwaway tests: Node scripts and a browser check page served by `serve.py`, all outside git.

**Spec:** `docs/superpowers/specs/2026-11-24-backup-history-pruning-design.md`

## Global Constraints

- Requests go only to `https://api.github.com` (the CSP's `connect-src`). GraphQL is `https://api.github.com/graphql`.
- `backup.js`, `github.js` and their imports stay free of DOM, `window` and `localStorage`: they run in the service worker.
- Every request goes through `request()` in `github.js`: 60 s timeout mapped to `busy`, `cache: "no-store"`, the token only in `Authorization`.
- A new failure mode gets a new `GithubError` kind with a Hebrew message in `MESSAGES`.
- Automatic work swallows failures. A prune failure never reaches the caller of `backupIfChanged()`.
- `PRUNE_ABOVE = 60`, kept versions `VERSIONS_LIMIT = 30`.
- No token beyond Contents read/write and Metadata read.
- Tests live in the scratchpad copy of the suites and never enter git. Never run anything against `LiorHalfon/journal-backup`.

## Review Focus

1. A repo whose first commit didn't touch the file (GitHub's "Initial commit" with a README): the prune counts branch commits, keeps the newest 30 of them, and the README survives in every kept tree.
2. A default branch not named `main`: the prune reads `default_branch` and moves `refs/heads/<that>`.
3. GraphQL answering HTTP 200 with `errors` and `data.updateRefs: null`: that is a failure (`rejected`), never a success.
4. A prune on a file over 1 MB: the prune never downloads contents, so it works the same and the head blob sha stays.
5. A token that may use REST but not GraphQL (`FORBIDDEN`): `denied`, swallowed, repo untouched.

---

### Task 1: The fake GitHub as a commit graph

**Files:**
- Modify: `<scratchpad>/tests/www/fake-github.js` (not in git)

**Interfaces:**
- Produces, on `createFakeGithub({ repo, token, isPrivate, persistKey, defaultBranch = "main" })`:
  - `fake.commits`: getter, the branch's first-parent chain newest-first, each `{ sha, commit: { tree: { sha }, message, author, committer }, parents: [{ sha }] }`, `author`/`committer` = `{ name, email, date }`.
  - `fake.head()`: the file's text at the branch tip, or `null`.
  - `fake.seed(text)`: commits `text` as an upload would; returns `{ text, blob, commit, date }`.
  - `fake.seedOther(name)`: a commit that adds a file other than the journal (README case).
  - `fake.seedMerge()`: a two-parent commit on the branch with the tip's tree.
  - `fake.failNext(status, headers)`, `fake.makePublic()`, `fake.setReadOnly()`, `fake.calls`, `fake.online`: unchanged.
  - `fake.graphqlErrors`: queue of `errors` arrays the next GraphQL calls answer with.
- Endpoints added: `GET /repos/{r}` returns `node_id` and `default_branch`; `GET /commits` honours `sha`, `path`, `per_page`, `page`; `POST /git/commits` (422 if the tree or a parent is unknown); `POST /graphql` with `updateRefs` (refuses with an `errors` entry if `beforeOid` doesn't match; 401 without the token). Unreachable commits stay readable through `contents?ref=`.

- [ ] **Step 1:** Rewrite the fake around `commits` (sha → object), `trees` (sha → `{ files: { path: blobSha } }`), `blobs` (sha → text) and one branch ref. Persist all of it under `persistKey`.
- [ ] **Step 2:** Run the existing suites. Expected: `github.test.mjs` 20/20, `vault.test.mjs` 11/11, `backup.check.html` `PASS 35/35`.

### Task 2: `pruneHistory()` in `github.js`

**Files:**
- Modify: `github.js`
- Test: `<scratchpad>/tests/node/github.test.mjs`

**Interfaces:**
- Consumes: Task 1's fake.
- Produces: `export async function pruneHistory(account): Promise<"short" | "skipped" | "pruned">`; `export const PRUNE_ABOVE = 60`; kind `rejected` with a Hebrew message.

- [ ] **Step 1: Write the failing tests**
  - `prune: 60 commits is short, with one request` — 60 uploads, `pruneHistory` returns `"short"`, one call, URL has `per_page=1&page=61`.
  - `prune: 61 commits keep the newest 30` — returns `"pruned"`; `fake.commits.length === 30`; each kept commit's tree, message, author, committer equal the originals; the oldest has `parents: []`; `fake.head()` and `currentSha()` unchanged.
  - `prune: updateRefs moves the branch only from the old head` — the GraphQL body has `beforeOid` = old head, `afterOid` = new tip, `force: true`, `name: "refs/heads/main"`.
  - `prune: a commit that lands mid-prune survives` — fetch wrapper seeds a commit before the GraphQL call; rejects `rejected`; the seeded commit is the tip; length 62.
  - `prune: a 502 midway leaves the branch as it was` — tip and length unchanged, rejects `busy`.
  - `prune: GraphQL errors are failures` — `FORBIDDEN` → `denied`, `NOT_FOUND` → `missing`, anything else → `rejected`; branch unchanged each time.
  - `prune: a merge commit in the kept range is skipped` — returns `"skipped"`, no POST.
  - `prune: another default branch and a README commit` — `defaultBranch: "master"`, a `seedOther("README.md")` first; ref name `refs/heads/master`; README present in the kept root tree.
  - Extend `KINDS` with `rejected`; add the prune to the "only api.github.com" test.
- [ ] **Step 2:** Run `REPO=<wt> node <tests>/node/github.test.mjs`. Expected: the new tests fail, the old 20 pass.
- [ ] **Step 3:** Implement. Steps from the spec: count (`per_page=1&page=61`), `GET /repos/{r}`, `GET /commits?sha=<branch>&per_page=31` with the linear-chain check, 30 sequential `POST /git/commits` checking each response's `tree.sha`, then `updateRefs`. A GraphQL call goes through `request()` with `POST /graphql`; an `errors` array maps by `type`.
- [ ] **Step 4:** Run it again. Expected: all pass.
- [ ] **Step 5:** Commit `github.js`.

### Task 3: Prune after an upload in `backup.js`

**Files:**
- Modify: `backup.js`
- Test: `<scratchpad>/tests/www/backup.check.js`

**Interfaces:**
- Consumes: `github.pruneHistory(account)`.
- Produces: `backupIfChanged()` unchanged in signature and results.

- [ ] **Step 1: Write the failing checks**
  - `prune: the 61st upload prunes to 30` (and the 60th doesn't).
  - `prune: another device's upload during a prune survives` — wrap fetch, PUT as another device before the GraphQL call; that commit stays the tip; result `"uploaded"`.
  - `prune: restore works after a prune` — restore the oldest kept and the newest.
  - `prune: a new device's block still works after a prune` — `remote-exists`, then restore of an older kept version merges the newest and lifts the block.
  - `prune: a failed prune leaves the repo untouched` — a 502 midway, a refused `updateRefs`, offline before the GraphQL call; each time the tip and length are unchanged and the result is `"uploaded"`, also with `force: true`.
  - `prune: after a prune the next upload needs no retry` — one PUT, sent with the stored `remote.sha`.
- [ ] **Step 2:** Load `/__tests__/backup.check.html`. Expected: the new checks fail, the old 35 pass.
- [ ] **Step 3:** After `settings.set("remote", …)` in `backupIfChanged()`, `await` a `pruneQuietly(account)` that calls `github.pruneHistory(account)` and swallows any error.
- [ ] **Step 4:** Reload. Expected: `PASS` on every check. Then `/?fake=1`: the app loads, a save backs up, no console errors.
- [ ] **Step 5:** Commit `backup.js`.

### Task 4: Docs

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1:** `CLAUDE.md`: add `rejected` to the `GithubError` kinds; in the backups paragraph, the history holds at most 60 commits and a prune keeps the newest 30, how it moves the branch, and that a prune failure is swallowed; an editing gotcha that the branch must only move through `updateRefs` with `beforeOid`.
- [ ] **Step 2:** `README.md`: the versions bullet says the repo keeps the newest 30 to 60 versions; the "one writer device" paragraph says a covered version stays only while it is among them.
- [ ] **Step 3:** Commit.

### Task 5: Real GitHub check, then the PR

- [ ] **Step 1:** Ask Lior before creating a throwaway private repo. He creates a fine-grained token for it and pastes it into the app himself.
- [ ] **Step 2:** Seed it with 60 commits with git from the Mac, then let the app upload once from `http://localhost:8090/` (no fake). Check with `gh api`: 30 commits, the head tree unchanged, dates kept, restore lists 30.
- [ ] **Step 3:** Push the branch and open the PR against `main`: option chosen and why, Merge Danger, what the phone hasn't verified. Don't merge.
