# Encrypted backup to a private GitHub repo

Replaces the Google Drive backup, which never ran: `config.js` still holds the placeholder Client ID, and its login can't outlive an app restart, so "back up when online again" could not work.

Decided with the owner on 2026-11-22. One Android phone, one writer, sensitive content. Security matters more than convenience.

## Decisions

1. **The phone encrypts before anything leaves it.** AES-256-GCM through WebCrypto, no library. GitHub only ever holds sealed data.
2. **The key is random, not a password.** The app makes 32 random bytes and shows them once as a recovery code for the owner's password manager.
3. **On the phone the key is non-extractable.** It is stored as a `CryptoKey` in IndexedDB with `extractable: false`, so code in the page can use it but can't read it out. That's also what lets backups run without asking for the code each time.
4. **The backup goes to a separate private GitHub repo** through a fine-grained token that can touch only that repo. The app's own repo is public (GitHub Pages on a free plan), so it can't be the backup repo. The app refuses any repo that isn't private.
5. **One device, so upload only.** No merging on upload. Restore stays additive (`store.addMissing`), as it is today.
6. **Every upload is a commit,** so GitHub's history is the version list. The "dated snapshot" action goes away.
7. **Backups go out by themselves:** at launch, when the app returns to the foreground or goes to the background, when the network returns, and 20 s after a change. When one fails for lack of network, Android's Background Sync retries it with the app closed.
8. **Google is removed completely:** `drive.js`, `config.js`, the Google sign-in script and Google Fonts. The fonts are served with the app.
9. **Exports are sealed too.** Import still accepts old plain JSON exports, because the export/import pair is the only way to move hosts.
10. **A page security policy lets the page send data only to `https://api.github.com`.**

## The recovery code

- Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), most significant bit first.
- 56 characters in 14 groups of 4 joined by `-`. The first 52 characters encode the 32 key bytes followed by 4 zero bits. The last 4 encode the first 20 bits of SHA-256(key bytes), a checksum that catches typos.
- When reading a code, the app uppercases it, drops spaces and hyphens, reads `O` as `0` and `I`/`L` as `1`, and rejects anything else, including `U`. A code is accepted only if it has 56 characters, zero padding bits and a matching checksum.
- The **key id** (`kid`) is the first 4 bytes of SHA-256(key bytes) in lowercase hex, for example `1a2b3c4d`. It's stored next to the key and written into every sealed file, so the app can tell "sealed with another key" from "damaged".

## The sealed file

The plaintext is today's backup JSON (`serializeEntries`, schema 1), unchanged. It is sealed into:

```json
{"app":"tiny-journal","sealed":1,"kid":"1a2b3c4d","iv":"<base64 of 12 random bytes>","data":"<base64 of the AES-GCM ciphertext and tag>"}
```

A fresh IV for every seal, and no additional authenticated data. The same envelope is used for the GitHub file and for exports.

## On GitHub

- File `journal.sealed.json` at the repo root. Every commit message is `backup`, so the history says nothing about the content.
- The app checks the repo when the account is saved, and refuses it unless `private` is true.
- The token needs exactly one permission: Contents, read and write, on that one repo.
- GitHub sees when backups happen and roughly how big the file is. Nothing else.

## On the phone

The entries database (`journal` v1, store `entries`) is not touched.

A new IndexedDB database `journal-backup` v1, object store `settings`, holds three records. It's IndexedDB rather than `localStorage` so the service worker can read it.

| Name | Value |
|---|---|
| `key` | `{ key: CryptoKey, kid: string }` |
| `github` | `{ repo: "owner/name", token: string }` |
| `remote` | `{ sha: string \| null, fingerprint: string, confirmedAt: number \| null }`, the last upload from this device |

`fingerprint` is the hex SHA-256 of `kid + "\n" + JSON.stringify(entries)`, so a changed entry or a new key triggers an upload, and nothing else does. `confirmedAt` is the last time the app confirmed the backup matches the phone.

## The rules that keep a backup safe

- **A device that has never uploaded doesn't cover an existing backup.** If `remote` is missing and the repo already has the file, automatic backup stops and says to restore first. A restore, or a manual "back up now", lifts the block. Saving a different repo clears `remote`, so the check runs again. A renewed token for the same repo keeps it.
- **A failed backup changes nothing on the phone.** Automatic backups fail silently. Manual actions show the message.
- **Only one backup runs at a time,** under the Web Lock `journal-backup`, shared by the page and the service worker.
- **A stale `sha` is retried once:** the app fetches the current one and uploads again.
- **A backup is stale after 3 days** without a confirmation. The header dot turns red and the sheet says how many days it has been. An unchanged journal counts as confirmed without a request, so the warning means changes have been failing to go out, not just a quiet week.

## Hebrew copy

| Where | Text |
|---|---|
| Status, not set up | הגיבוי עוד לא הוגדר. הרשומות שמורות רק במכשיר הזה. |
| Status, set up but never backed up | עוד לא גובה. |
| Status, fresh | גובה לאחרונה: {stamp} |
| Status, stale (≥ 3 days) | הגיבוי האחרון לפני {N} ימים. |
| Status, backup already in the repo | במאגר כבר יש גיבוי. שחזר ממנו קודם, ואז הגיבוי מהמכשיר הזה ימשיך ממנו. |
| Dot title | גיבוי לא הוגדר / גובה לאחרונה: {stamp} / הגיבוי האחרון לפני {N} ימים |
| Key section title | מפתח הצפנה |
| Action, no key | יצירת מפתח · small: קוד שחזור לשמירה במנהל הסיסמאות |
| Action, no key | יש לי קוד שחזור · small: למכשיר חדש, או אחרי התקנה מחדש |
| Key line | מפתח פעיל · {kid} · button: מפתח חדש |
| New-key panel | heading: קוד השחזור שלך · note: שמור אותו במנהל הסיסמאות. בלי הקוד ובלי הטלפון אי אפשר לפתוח את הגיבוי, ואף אחד לא יכול לאפס אותו. · buttons: העתקה, שמרתי את הקוד, ביטול |
| New-key panel, replacing a key | extra note: גיבויים קודמים יישארו נעולים במפתח הישן. |
| After copying | toast: הקוד הועתק. אחרי ששמרת אותו, מחק אותו מהיסטוריית הלוח. |
| Code panel | placeholder: קוד השחזור · buttons: שמירה, ביטול |
| Account section title | מאגר GitHub |
| Account form | placeholders: owner/repo, טוקן גישה · note: מאגר פרטי, וטוקן שיש לו גישה רק אליו. · button: שמירה |
| Account line | {repo} · button: שינוי |
| Action | גיבוי עכשיו · small: מעלה עותק מוצפן למאגר |
| Action | שחזור · small: מוסיף רשומות שחסרות — לא מוחק כלום |
| Version list heading | בחר גרסה לשחזור. רשומות שכבר קיימות לא ישוכפלו. |
| No versions | אין עדיין גרסאות במאגר. |
| Action | ייצוא לקובץ מוצפן · small: נפתח רק עם קוד השחזור · without a key: צריך קודם מפתח הצפנה |
| Action | ייבוא מקובץ · small: קובץ מוצפן, או קובץ JSON ישן. מיזוג לפי מזהה רשומה |
| Backed up | notice: גובה. {count} רשומות. · toast: גובה |
| Restored | שוחזרו {n} רשומות. / כל הרשומות בגרסה כבר קיימות. |
| Error `no-key` | צריך קודם מפתח הצפנה. |
| Error `bad-code` | הקוד לא תקין. בדוק שהעתקת את כולו. |
| Error `wrong-key` | הקובץ הוצפן במפתח אחר. הזן את קוד השחזור שלו. |
| Error `corrupt` | הקובץ פגום או שונה, ולכן לא נפתח. |
| Error `bad-repo` | כתוב את המאגר בצורה owner/repo. |
| Error `public` | המאגר ציבורי. הגיבוי נשמר רק במאגר פרטי. |
| Error `offline` | אין חיבור לרשת. הרשומות שמורות במכשיר, והגיבוי יעלה כשהרשת תחזור. |
| Error `auth` | הטוקן לא תקף או שפג. צור טוקן חדש והדבק אותו ב“מאגר GitHub”. |
| Error `denied` | לטוקן אין הרשאת כתיבה למאגר הזה. |
| Error `missing` | המאגר לא נמצא, או שלטוקן אין גישה אליו. |
| Error `busy` | GitHub לא זמין כרגע. הרשומות שמורות במכשיר — נסה שוב בעוד רגע. |
| Error `http` | GitHub החזיר שגיאה {status}. |
| Any other error | הגיבוי נכשל. |

## The page security policy

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src https://api.github.com; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'
```

Set as a `<meta http-equiv>`, because GitHub Pages can't send headers. Styles keep `'unsafe-inline'` for the `<style>` block. With images, fonts and requests all limited, injected CSS has nowhere to send anything. Add `<meta name="referrer" content="no-referrer">` too.

## What this doesn't protect against

- Someone holding the unlocked phone. The entries sit unencrypted in IndexedDB, as they do today.
- Someone who takes over the GitHub account and pushes a malicious version of the app. Two-factor login, ideally a passkey, covers it.
- Losing both the phone and the recovery code. The backup is then unreadable, and nobody can reset it.
- Android's clipboard history keeping the code after "העתקה". The toast says to delete it.
- The token is readable by code in the page. With the policy above, that code can only send it to GitHub, and the token only reaches one repo of sealed files.
