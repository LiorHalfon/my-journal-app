/* יומן — עבודת הגיבוי: מתי להעלות, מה לחתום, ואיך לשחזר.
   רץ גם בדף וגם ב-service worker, ולכן בלי DOM, בלי window ובלי localStorage.
   רק גיבוי אחד רץ בכל רגע, תחת Web Lock שהדף וה-service worker חולקים. */

import * as store from "./entries-store.js";
import * as settings from "./backup-store.js";
import * as vault from "./vault.js";
import * as github from "./github.js";
import { serializeEntries, readEntries } from "./backup-file.js";

/** שם ה-Web Lock וגם התג של Background Sync. */
export const SYNC_TAG = "journal-backup";

/* טוקן של GitHub הוא רק תווי ASCII נראים. ירידת שורה או תו לא לטיני שהודבקו איתו
   מפילים את fetch, והכשל היה נקרא כ"אין רשת". */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

const withLock = (task) => navigator.locks.request(SYNC_TAG, task);

async function readSettings() {
  const [keyRecord, account, remote] = await Promise.all([
    settings.get("key"),
    settings.get("github"),
    settings.get("remote"),
  ]);
  return { keyRecord, account, remote };
}

async function savedAccount() {
  const account = await settings.get("github");
  if (!account) throw new github.GithubError("missing");
  return account;
}

/** טביעה של היומן כפי שהוא אמור להיות במאגר. רשומה ששונתה או מפתח חדש משנים אותה, ושום דבר אחר. */
async function fingerprint(kid, entries) {
  const text = `${kid}\n${JSON.stringify(entries)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* ================= מצב והגדרה ================= */

/** מה שהמסך צריך כדי לתאר את הגיבוי. */
export async function status() {
  const { keyRecord, account, remote } = await readSettings();
  return {
    kid: keyRecord?.kid ?? null,
    repo: account?.repo ?? null,
    confirmedAt: remote?.confirmedAt ?? null,
  };
}

/** קוד שחזור למפתח חדש. המפתח נשמר רק כשהקוד חוזר דרך saveKey. */
export async function newRecoveryCode() {
  const bytes = vault.newKeyBytes();
  try {
    return await vault.toRecoveryCode(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** שומר את המפתח של הקוד ומחזיר את ה-kid. קוד שגוי לא נוגע במפתח הקיים.
    remote לא משתנה: ה-kid החדש משנה את הטביעה, והריצה הבאה מצפינה מחדש. */
export async function saveKey(code) {
  const bytes = await vault.fromRecoveryCode(code);
  if (!bytes) throw new vault.VaultError("bad-code");
  let record;
  try {
    record = { key: await vault.importKey(bytes), kid: await vault.keyId(bytes) };
  } finally {
    bytes.fill(0); // הבתים הגולמיים לא שורדים את הייבוא
  }
  await settings.set("key", record);
  return record.kid;
}

/** בודק את המאגר ואת הטוקן, ורק אז שומר. מחזיר את המאגר בצורה הנקייה.
    מאגר אחר מוחק את remote, כדי שגיבוי קיים שם לא יידרס. טוקן חדש לאותו מאגר משאיר אותו. */
export async function saveAccount(repo, token) {
  const account = { repo: github.parseRepo(repo), token: String(token ?? "").trim() };
  if (!account.repo) throw new github.GithubError("bad-repo");
  if (!TOKEN_PATTERN.test(account.token)) throw new github.GithubError("auth");
  await github.checkAccount(account);

  /* בתוך הנעילה: גיבוי שרץ עכשיו למאגר הקודם לא יכתוב remote אחרי שנמחק. */
  await withLock(async () => {
    const stored = await settings.get("github");
    if (stored?.repo !== account.repo) await settings.remove("remote");
    await settings.set("github", account);
  });
  return account.repo;
}

/* ================= גיבוי ================= */

/** מעלה את היומן החתום אם השתנה מאז ההעלאה האחרונה מהמכשיר הזה.
    כשל לא משנה כלום במכשיר: remote נכתב רק אחרי העלאה שהצליחה. */
export function backupIfChanged({ force = false } = {}) {
  return withLock(async () => {
    const { keyRecord, account, remote } = await readSettings();
    if (!keyRecord || !account) return "not-ready";

    const entries = await store.readAll();
    const print = await fingerprint(keyRecord.kid, entries);
    if (!force) {
      if (remote?.fingerprint === print) {
        /* יומן שלא השתנה נחשב מאושר בלי בקשה. */
        await settings.set("remote", { ...remote, confirmedAt: Date.now() });
        return "unchanged";
      }
      /* מכשיר שעוד לא העלה לא מכסה גיבוי קיים. שחזור או "גיבוי עכשיו" מסירים את החסימה. */
      if (!remote && (await github.currentSha(account)) !== null) return "remote-exists";
    }

    const sealed = await vault.seal(keyRecord.key, keyRecord.kid, serializeEntries(entries));
    let sha;
    try {
      sha = await github.upload(account, sealed, remote?.sha ?? null);
    } catch (error) {
      if (error?.kind !== "conflict" && error?.kind !== "missing") throw error;
      /* הבדיקה למעלה לא מצאה קובץ, ועכשיו יש: גיבוי הופיע בינתיים, ולא דורסים אותו. */
      if (error.kind === "conflict" && !remote && !force) return "remote-exists";
      /* sha שהתיישן מקבל ניסיון חוזר אחד, על ה-sha הנוכחי במאגר. */
      sha = await github.upload(account, sealed, await github.currentSha(account));
    }
    await settings.set("remote", { sha, fingerprint: print, confirmedAt: Date.now() });
    await pruneQuietly(account);
    return "uploaded";
  });
}

/* קיצוץ שנכשל מחכה יום. כל ניסיון עולה כ-34 בקשות ומשאיר 30 commits יתומים, וסירוב
   קבוע של GitHub היה מוסיף את זה לכל העלאה. */
const PRUNE_RETRY_MS = 24 * 60 * 60 * 1000;

/** מקצר את ההיסטוריה של המאגר אחרי העלאה. הגיבוי כבר הצליח, ולכן כשל כאן נבלע
    תמיד, גם ב"גיבוי עכשיו": ההיסטוריה נשארת כמו שהייתה, והניסיון הבא בעוד יום. */
async function pruneQuietly(account) {
  try {
    const waiting = await settings.get("prune");
    if (waiting && Date.now() < waiting.retryAt) return;
    await github.pruneHistory(account);
  } catch {
    await settings.set("prune", { retryAt: Date.now() + PRUNE_RETRY_MS }).catch(() => {});
  }
}

/* ================= שחזור, ייצוא וייבוא ================= */

/** הגרסאות במאגר, מהחדשה לישנה. */
export async function listVersions() {
  return github.listVersions(await savedAccount());
}

/** מוסיף מהגרסה רשומות שחסרות כאן, ומחזיר כמה נוספו. לא מוחק ולא דורס.
    כולו בתוך הנעילה: מאגר אחר שנשמר באמצע לא יקבל את הסרת החסימה של המאגר הזה. */
export function restoreVersion(commit) {
  return withLock(async () => {
    const account = await savedAccount();
    const text = await github.download(account, commit);
    const chosen = await readBackupText(text, { plainAllowed: false });
    if (await settings.get("remote")) return store.addMissing(chosen);

    /* מכשיר שעוד לא העלה: השחזור מסיר את החסימה, וההעלאה הבאה תכסה את הגרסה האחרונה
       במאגר. לכן גם הרשומות שלה נכנסות קודם. כשהיא לא נפתחת במפתח הזה, החסימה נשארת. */
    const latest = await latestEntries(account, commit);
    let added = await store.addMissing(chosen);
    if (!latest) return added;
    added += await store.addMissing(latest);
    /* הטביעה הריקה לא תואמת שום יומן, ולכן הריצה הבאה מעלה את היומן הממוזג. */
    await settings.set("remote", { sha: null, fingerprint: "", confirmedAt: null });
    return added;
  });
}

/** הרשומות של הגרסה האחרונה במאגר. [] כשהיא הגרסה שכבר הורדה, null כשהיא לא נפתחת כאן. */
async function latestEntries(account, chosenCommit) {
  if (!chosenCommit) return []; // בלי commit, מה שהורד הוא כבר הגרסה האחרונה
  const [latest] = await github.listVersions(account);
  if (!latest || latest.commit === chosenCommit) return [];
  try {
    return await readBackupText(await github.download(account), { plainAllowed: false });
  } catch (error) {
    if (error instanceof vault.VaultError) return null;
    throw error;
  }
}

/** היומן כקובץ חתום, שנפתח רק עם קוד השחזור. */
export async function exportFile() {
  const keyRecord = await settings.get("key");
  if (!keyRecord) throw new vault.VaultError("no-key");
  return vault.seal(keyRecord.key, keyRecord.kid, serializeEntries(await store.readAll()));
}

/** מוסיף מקובץ רשומות שחסרות כאן, ומחזיר כמה נוספו. מקבל גם ייצוא JSON ישן. */
export async function importFile(text) {
  return store.addMissing(await readBackupText(text, { plainAllowed: true }));
}

/** הרשומות מתוך קובץ גיבוי. קובץ חתום נפתח במפתח השמור.
    JSON רגיל מתקבל רק מקובץ מקומי: מהמאגר, רק מה שנחתם במפתח הזה. */
async function readBackupText(text, { plainAllowed }) {
  let plain = text;
  if (vault.isSealed(text)) {
    const keyRecord = await settings.get("key");
    if (!keyRecord) throw new vault.VaultError("no-key");
    plain = await vault.unseal(keyRecord.key, keyRecord.kid, text);
  } else if (!plainAllowed) {
    throw new vault.VaultError("corrupt");
  }
  try {
    return readEntries(plain);
  } catch {
    throw new vault.VaultError("corrupt");
  }
}

/* ================= הודעות ================= */

/** ההודעה בעברית לכל כשל בגיבוי, בשחזור, בייצוא או בייבוא. */
export function describeBackupError(error) {
  if (error instanceof vault.VaultError) return vault.describeVaultError(error);
  if (error instanceof github.GithubError) return github.describeGithubError(error);
  return "הגיבוי נכשל.";
}
