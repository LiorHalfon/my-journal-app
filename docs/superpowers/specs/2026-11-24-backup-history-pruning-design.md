# Pruning the backup repo's history

Decided with the owner on 2026-11-24: prune in the app, above 60 commits, down to the newest 30.

## Why

Git can't delta-compress ciphertext, so every backup commit stores a full copy of `journal.sealed.json`. The file is about 20 KB today and grows with the journal. At today's pace the history would pass GitHub's recommended 1 GB within about a year. Restore only ever offers the newest 30 versions.

## Goals

- `main` in the backup repo holds at most 60 commits. A prune leaves exactly the newest 30.
- The newest version is never lost or changed, and every device's stored `remote.sha` stays valid.
- An upload from another device that lands during a prune survives.
- Restore, the new-device block and its merge with the newest version work as before.

Non-goals: shrinking the repo at once (GitHub deletes unreachable objects on its own schedule), pruning a history with merge commits, any UI for pruning.

Anti-goals: a new token permission, a host besides `api.github.com`, a prune failure that shows up as a backup failure.

## Approaches

- **(a) In the app. Chosen.** No new token, no setup, works for any backup repo, and the history never passes 60. It costs about 120 lines in the backup path and a burst of requests every 30 uploads or so.
- **(b) A scheduled GitHub Action in the backup repo.** Real git and `--force-with-lease`, and no app change. Rejected: GitHub refuses a push that creates a file under `.github/workflows/` from a token without the Workflows permission, and the Action's `GITHUB_TOKEN` can't get it. A rewritten root commit creates the workflow file, so the Action would probably need a second long-lived token stored as a secret, plus a manual setup step.
- **(c) A script on the Mac.** Rejected: it only works if someone remembers to run it.

Building the chain locally and pushing it once isn't possible from the page. `git push` goes to `github.com`, which sends no CORS headers and isn't in the CSP. The REST API creates one commit per `POST /git/commits`, and each one has to name a parent GitHub already has.

## Design

`github.js` gets `pruneHistory(account)`. `backup.js` calls it after a successful upload, inside the same Web Lock, and swallows every failure, so `backupIfChanged()` still returns `"uploaded"`. Constants in `github.js`: `VERSIONS_LIMIT = 30` (listed by restore and kept by a prune) and `PRUNE_ABOVE = 60`.

`pruneHistory(account)`:

1. `GET /repos/{repo}/commits?per_page=1&page=61`. An empty list means 60 commits or fewer: return `"short"`. This is the only request a normal upload adds.
2. `GET /repos/{repo}` for `node_id` and `default_branch`.
3. `GET /repos/{repo}/commits?sha={branch}&per_page=31`. The first item is the head `H`. Each of the first 30 must have exactly one parent, the next item in the list. Otherwise (a merge commit, or the history shrank meanwhile) return `"skipped"` and write nothing.
4. From the oldest kept commit to the newest, `POST /repos/{repo}/git/commits` with the same tree, message, author and committer (names, emails, dates). The oldest gets `parents: []`. Each call names the commit the previous call made, so the 30 calls run one after another. Each response's tree sha must equal the original's.
5. GraphQL `updateRefs` with `name: refs/heads/{branch}`, `beforeOid: H`, `afterOid: <new tip>`, `force: true`. GitHub applies it atomically and refuses it if the branch no longer points at `H`.
6. Return `"pruned"`.

**Failures.** Every call goes through `request()`, so the 60 s timeout and the status-to-kind mapping apply. A GraphQL answer with `errors` becomes the new kind `rejected` (`FORBIDDEN` maps to `denied`, `NOT_FOUND` to `missing`), with a Hebrew message beside it, though a prune failure is never shown. Nothing before step 5 changes the branch. Commits made before a failure are unreachable, and GitHub drops them.

**Concurrency.**
- Another device uploads before step 5: the branch no longer points at `H`, `updateRefs` refuses, and the upload survives. The next upload from either device prunes.
- Another device uploads after step 5: the new tip has `H`'s tree, so the file's blob sha hasn't changed, and its PUT with its stored sha lands on top of the new tip. If GitHub had already read the old head for that PUT, it answers 409, and the existing stale-sha retry uploads onto the new tip.
- The same device: the page and the service worker share the Web Lock.

**Cost.** One small request per upload. About every 30th upload, 33 more requests of roughly 300 bytes each, holding the lock for 5 to 15 s. A manual "גיבוי עכשיו" that happens to prune waits that long.

**Restore.** `listVersions()` doesn't change: it lists the newest 30 commits that touch the file, which is exactly what a prune keeps. Known gap: a version list opened on one device just before another device prunes can name a dropped commit. GitHub may still serve it by sha until it collects it. Otherwise restore shows `missing`.

**Risk.** The first real rewrite runs unattended on the phone, once the real repo passes 60 commits. Steps 3 and 4 are the guards: a straight-line history only, and the same trees.

## Testing

The fake GitHub becomes a commit graph: commits, trees and a `main` ref, keeping unreachable commits as GitHub does. It learns `POST /git/commits`, the `page` and `sha` parameters, and GraphQL `updateRefs` with `beforeOid`. Checks:

- 60 uploads don't prune. The 61st prunes to 30 with the same trees, messages and dates, a root as the oldest, and the same head file and blob sha.
- An upload from another device during a prune survives, and the prune is refused.
- Restore works after a prune.
- A new device's block works after a prune, and so does its merge with the newest version.
- A failed prune (a 502 midway, a refused `updateRefs`, going offline) leaves the repo untouched, and the backup still returns `"uploaded"`.
- After a prune, the next upload uses the stored `remote.sha` without a retry.
- A history with a merge commit is skipped.
- Requests go only to `api.github.com`, and every kind has a Hebrew message.

Unverified until a run against real GitHub, which needs the owner's OK for a throwaway private repo and a token he pastes himself: that a fine-grained token may call `updateRefs`, that `api.github.com/graphql` answers the page's cross-origin request, and that GitHub keeps the dates.

## Docs

`CLAUDE.md`: the `GithubError` kinds, the backup paragraph on versions, and the prune's guards. `README.md`: the versions bullet.

## Left to the builder

The exact Hebrew for `rejected`, and the layout of the code inside `github.js`.
