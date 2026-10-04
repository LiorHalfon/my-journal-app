# Folders design

Date: 2026-10-04. Branch: `folders`.

## Goal

The journal should hold separate streams, for example one folder for tracking health and one for thoughts. Entries stay free text. A folder is where an entry lives. It is not a form with fields.

Done means:

- Opening a folder shows only its entries, and anything written while it is open lands in it.
- Existing entries keep working with no migration.
- Folders survive export, import, Drive sync and restore.
- Text typed in the composer is never lost by a folder action. A successful save is the only thing that clears it.

## Decisions

| Question | Decision | Rejected |
|---|---|---|
| How many folders per entry | One, optional | Tags (several per entry), hashtags parsed from the text |
| Entries with no folder | Valid. They show only under הכל. Writing under הכל saves with no folder. | A default "כללי" folder with a migration, a read-only הכל |
| Storage | Folder name on the entry | A separate `folders` store with ids (IndexedDB v2, backup schema 2) |
| Switcher | Chip row directly under the composer textarea | Folder menu in the header title |
| Chip order | הכל first, then folders by most recent entry activity, then "+ תיקייה" | Alphabetical, last opened |

"Most recent activity" means writing, not opening. A folder moves to the front when an entry in it is created, edited or moved into it. Opening a folder never reorders the row, so a chip never jumps out from under the finger that tapped it.

## Data

### Entry

Entries gain one optional field:

```json
{ "id": "e...", "text": "...", "createdAt": "...", "createdAtMs": 0, "folder": "בריאות" }
```

`folder` holds a cleaned name (see `cleanName` below). An entry with no folder has no `folder` key. The app never stores an empty string there; it deletes the key instead.

IndexedDB stays at version 1. The store needs no index on `folder`, because the app already reads every entry into memory.

### Backup file

`normalize()` in `backup-file.js` keeps `folder` after running it through `cleanName`, and drops it when the result is empty. `SCHEMA` stays 1, because the field is optional and files without it are still correct.

A device still running the pre-folders code drops `folder` when it imports a new file. The shell is served network-first, so a device picks up the new code on its next launch and this window is short.

### localStorage (per device)

| Key | Value |
|---|---|
| `journal.folders.v1` | JSON array of `{ "name": string, "at": number }`, one record per known folder. `at` is the folder's latest activity in ms. |
| `journal.folder.v1` | The open folder's name, or `""` for הכל. |

The records keep folders from vanishing. Without them, a folder whose last entry was moved out would disappear, and an empty folder couldn't exist at all. A folder disappears only when the user deletes it on this device.

`local-storage.js` returns a fallback in private mode instead of throwing. `folders.js` keeps the records in memory and writes them through, so folders still work for the session when storage is blocked.

## Modules

### `folders.js` (new)

This module owns the folder list, its order, the open folder and the naming rule. It touches neither the DOM nor IndexedDB.

```js
cleanName(raw)          // trims, collapses whitespace runs, caps at 30 chars; "" if nothing is left
learn(entries)          // upserts a record per folder seen in entries; at = max(stored at, newest activity)
names()                 // known folder names, latest activity first, ties by localeCompare("he")
create(raw)             // cleans; records { name, at: now } unless it already exists; returns the name or ""
rename(from, to)        // moves the record and keeps its at; merging into an existing name keeps the larger at
forget(name)            // drops the record
selected()              // the stored open folder, or "" if it is no longer in names()
select(name)            // stores the open folder ("" for הכל)
matches(entry, folder)  // true when folder is "" or entry.folder === folder
```

An entry's activity is `Math.max(createdAtMs, updatedAtMs || 0)`.

### `entries-store.js`

Add `putAll(entries)`, which writes every entry in one readwrite transaction. It resolves on the transaction's `complete` event and rejects on `error` or `abort`. Renaming or deleting a folder then changes every affected entry or none of them.

### `app.js`

Screen state gains:

- `folder`: the open folder, `""` for הכל.
- `folderPanel`: `null`, `"create"` or `"manage"`.
- `pendingFolderDelete`: true after the first tap on delete.

`refreshEntries()` calls `folders.learn(entries)` before rendering. Every mutation keeps the existing shape: write to the store, then `refreshEntries()`, then `scheduleAutoSync()`.

| Action | Behaviour |
|---|---|
| Save from the composer | `addEntry(text)` adds `folder` when one is open. |
| Save from the edit view | `updateEntry(id, text, folder)` writes the text and folder together, sets `updatedAtMs`, and deletes the key for "ללא תיקייה". |
| Create | `folders.create(raw)`. An empty result closes the field. An existing name opens that folder. Either way the new or existing folder becomes the open one. No sync, since no entry changed. |
| Rename | Same name: no-op. Otherwise copy each entry in the folder with the new name, `store.putAll`, `folders.rename`, open the new name. `updatedAtMs` is untouched, so the order holds. |
| Delete | Two taps. Copy each entry in the folder without the `folder` key, `store.putAll`, `folders.forget`, open הכל. Entries are never deleted. |

Create, rename and delete close the panel when they finish. Cancel, Escape and switching folders also close it. Closing the panel always resets `pendingFolderDelete`.

The composer guarantee: only the success path of `submit()` writes to `#composer`. No folder action, render or search touches it, and the draft key stays as it is. The new-folder field and the rename field are separate inputs.

### `view.js`

- `renderFolders(state)` builds `#folders`.
  - The chips are buttons with `data-folder` and `aria-pressed`. The open folder's chip shows ⋯, and tapping it opens the manage panel.
  - "+ תיקייה" turns into a text input when `folderPanel` is `"create"`. Enter creates the folder. Escape or blur cancels.
  - The manage panel holds a name input, "שינוי שם", "ביטול" and the delete button.
  - The view focuses the input that opens. It renders only on clicks, never on input events, so typing in these fields is never rebuilt away.
- `renderEntries(state)` filters by `folders.matches` and then by the query.
  - Under הכל, each entry shows its folder as a small label after the time.
  - Inside a folder the label is hidden, since every entry in view shares it.
  - The edit view gains a `<select>` with "ללא תיקייה" first, then the folders in chip order, with the entry's current folder selected.
  - Search and the match count are scoped to the open folder.
- Every folder name passes through `escapeHtml`, including in attributes.

### `index.html`

- Add `<div class="folders" id="folders"></div>` between the textarea and `.composer-row`.
- The chip row scrolls sideways when it overflows. It hides the scrollbar and never causes the page itself to scroll sideways.
- Chips, the "+ תיקייה" chip, the manage panel's buttons and the edit view's folder select have touch targets at least 44px tall.
- Use logical properties, as the rest of the stylesheet does. Colours come from the existing tokens only.

### `sw.js`

Add `"./folders.js"` to `SHELL_FILES`. One 404 there fails the whole install silently, so testing confirms the file is in the cache.

### Docs

- README: a file-list row for `folders.js`, `folder` in the format example, and a note under "דברים ששווה לדעת" about the sync limits below.
- CLAUDE.md:
  - A module-table row for `folders.js`.
  - The new screen state in the Architecture paragraph.
  - One sentence in the sync paragraph saying that folder renames, deletes and moves do not reach entries already on another device.

## Hebrew copy (drafts)

| Where | Text |
|---|---|
| All chip | הכל |
| New chip | + תיקייה |
| New-folder input placeholder | שם התיקייה |
| Manage panel | שינוי שם · ביטול · מחיקת התיקייה |
| Delete, armed | לחיצה נוספת תמחק |
| Delete, explanation while armed | הרשומות לא יימחקו. הן יישארו תחת “הכל”, בלי תיקייה. |
| Edit view select label | תיקייה |
| Edit view "no folder" option | ללא תיקייה |
| Empty folder | עוד אין כאן כלום ב“{name}”. |
| No search match inside a folder | אין רשומה ב“{name}” שמתאימה ל“{query}”. |

## Known limits

- Restore and import never overwrite an entry that already exists, which is the same reason edits don't sync today. A folder rename, delete or move on one device does not reach entries already on another device. After a rename, the other device shows both names until it is renamed there too.
- Empty folders and the open folder are per device.

## Out of scope

- Resizing the existing buttons. That follows as its own commit after this feature.
- Folder colours or icons, manual ordering, nested folders, one draft per folder, structured health fields, and syncing renames or moves across devices.

## Testing

The repo has no test suite and keeps it that way.

**Pure functions (a throwaway Node script in the scratchpad, not committed):**

- `cleanName`: whitespace, the length cap, empty input.
- Order from `learn` and `names`: activity from `updatedAtMs`, ties, and a created empty folder going to the front.
- `rename`: plain, and merging into an existing name.
- `normalize()`: an entry with `folder`, an old entry without it, `folder: "   "`, and a non-string `folder`.

**In Chrome at `localhost:8080`:**

1. Existing entries load under הכל with no label, and the database is still version 1.
2. Create a folder. It opens, sits first, shows the empty-folder message and survives a reload.
3. Type a draft, then do each of these in turn: switch folders, open and cancel "+ תיקייה", open and cancel the manage panel, search, rename a folder, delete a folder, reload. The draft is intact after every step.
4. Save inside a folder. The entry lands there, that chip moves to the front and the text box clears.
5. Move an entry with the edit view. It leaves the current folder's list and shows the new label under הכל.
6. Rename a folder, including a merge into an existing one. Delete one with two taps. Its entries stay under הכל with no label.
7. Export JSON and check it contains `folder`. Clear site data and import it, and the folders come back. Import a backup made before this change, and it still works.
8. Name a folder `<b>"x"` and check it renders as literal text everywhere it appears.
9. Cache Storage holds `folders.js` after the service worker installs.
10. Check dark mode. At 375px wide the chip row scrolls and the page has no horizontal scroll.
