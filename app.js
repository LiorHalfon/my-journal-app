/* יומן — חיווט.
   מחזיק את מצב המסך, מחבר אירועים למודולים, ומעלה הכל.
   הלוגיקה עצמה יושבת ב-entries-store, backup, backup-file ו-view. */

import * as store from "./entries-store.js";
import * as backup from "./backup.js";
import * as view from "./view.js";
import * as folders from "./folders.js";
import {
  serializeEntries,
  readEntries,
  timestampedFilename,
} from "./backup-file.js";
import { readLocal, writeLocal } from "./local-storage.js";

const DRAFT_KEY = "journal.draft.v1";
const BACKUP_DELAY_MS = 20000;
const BAD_BACKUP_MESSAGE = "הקובץ לא נקרא כקובץ גיבוי תקין.";

/* ================= מצב המסך ================= */

let entries = [];
let folder = "";
let folderPanel = null;
let pendingFolderDelete = false;
/* בעלייה, ובכל פעם שנפתחת תיקייה, השורה נגללת אליה. */
let revealOpenFolder = true;
let query = "";
let editingId = null;
let pendingDeleteId = null;
let busy = false;
let backupTimer = null;
/* הגדרת הגיבוי: איזה פאנל פתוח (null, "new-key", "enter-code" או "account"),
   קוד השחזור שמוצג ועוד לא נשמר, וההודעה של הכישלון האחרון בפאנל. הקוד רק בזיכרון. */
let setupPanel = null;
let pendingCode = null;
let setupError = null;
/* הגיבוי האוטומטי האחרון מצא גיבוי במאגר ממכשיר שעוד לא העלה. */
let backupBlocked = false;

function render() {
  renderFolderBar();
  renderList();
}

/** הרשימה לבד. חיפוש ועריכה לא בונים מחדש את שורת התיקיות,
    כדי לא למחוק שם תיקייה שבאמצע הקלדה. */
function renderList() {
  view.renderEntries({
    entries,
    folder,
    folderNames: folders.names(),
    query,
    editingId,
    pendingDeleteId,
  });
}

function renderFolderBar({ focus = false } = {}) {
  view.renderFolders(
    { names: folders.names(), folder, panel: folderPanel, pendingFolderDelete },
    { focus, reveal: revealOpenFolder }
  );
  revealOpenFolder = false;
}

async function renderBackupStatus() {
  view.renderBackupStatus({ ...(await backup.status()), blocked: backupBlocked });
}

/** רק פעולות ההגדרה קוראות לזה, כדי שרענון של המצב לא ימחק שדה באמצע הקלדה. */
async function renderBackupSetup() {
  const { kid, repo } = await backup.status();
  view.renderBackupSetup({
    kid,
    repo,
    panel: setupPanel,
    code: pendingCode,
    error: setupError,
  });
}

async function refreshEntries() {
  entries = await store.readAll();
  folders.learn(entries);
  render();
}

/* ================= רשומות ================= */

/** נשמרת לתוך התיקייה הפתוחה, או בלי תיקייה כשפתוח "הכל". */
async function addEntry(text) {
  const now = new Date();
  const entry = {
    id: store.createEntryId(),
    text,
    createdAt: now.toISOString(),
    createdAtMs: now.getTime(),
  };
  await store.put(folders.withFolder(entry, folder));
  await refreshEntries();
  scheduleBackup();
}

/** הטקסט והתיקייה נשמרים יחד. "" מוציא את הרשומה מכל תיקייה. */
async function updateEntry(id, text, folderName) {
  const existing = entries.find((entry) => entry.id === id);
  if (!existing) return;
  const edited = { ...existing, text, updatedAtMs: Date.now() };
  await store.put(folders.withFolder(edited, folderName));
  await refreshEntries();
  scheduleBackup();
}

async function deleteEntry(id) {
  await store.remove(id);
  await refreshEntries();
  scheduleBackup();
}

/** גיבוי שקט 20 שניות אחרי שינוי. שינוי נוסף בזמן הזה דוחה אותו. */
function scheduleBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(backupQuietly, BACKUP_DELAY_MS);
}

/** גיבוי אוטומטי. כישלון לא מדווח: הרשומות במכשיר, והטריגר הבא ינסה שוב.
    מחזיר את התוצאה של backupIfChanged, או null אם נכשל. */
async function backupQuietly() {
  try {
    const result = await backup.backupIfChanged();
    backupBlocked = result === "remote-exists";
    await renderBackupStatus();
    return result;
  } catch {
    return null;
  }
}

/* ================= תיקיות ================= */

/** פותח תיקייה ("" היא הכל) וסוגר את מה שהיה פתוח. לא מצייר. */
function openFolder(name) {
  folder = name;
  folders.select(name);
  closeFolderPanel();
  editingId = null;
  pendingDeleteId = null;
  revealOpenFolder = true;
}

function closeFolderPanel() {
  folderPanel = null;
  pendingFolderDelete = false;
}

/** לחיצה על התיקייה הפתוחה פותחת או סוגרת את הפאנל שלה. כל תיקייה אחרת נפתחת.
    לחיצה על "הכל" כשהוא כבר פתוח רק סוגרת שדה פתוח: עריכה פתוחה ברשימה נשארת. */
function chooseFolder(name) {
  if (name === folder) {
    const opening = name && folderPanel !== "manage";
    closeFolderPanel();
    if (opening) folderPanel = "manage";
    return renderFolderBar();
  }
  openFolder(name);
  render();
}

/** שם ריק סוגר את השדה. שם שכבר קיים פותח את התיקייה הקיימת. */
function createFolder(raw) {
  const name = folders.create(raw);
  if (name) openFolder(name);
  else closeFolderPanel();
  render();
}

/** שם ריק לא עושה כלום, ואותו שם רק סוגר את הפאנל. שם של תיקייה אחרת
    ממזג לתוכה. updatedAtMs לא משתנה, ולכן התיקייה נשארת במקומה בשורה. */
async function renameFolder(from, raw) {
  const to = folders.cleanName(raw);
  if (!to) return;
  if (to === from) {
    closeFolderPanel();
    return renderFolderBar();
  }
  const moved = entries
    .filter((entry) => entry.folder === from)
    .map((entry) => folders.withFolder(entry, to));
  await store.putAll(moved);
  folders.rename(from, to);
  openFolder(to);
  await refreshEntries();
  if (moved.length) scheduleBackup();
}

/** הרשומות לא נמחקות. הן נשארות תחת "הכל", בלי תיקייה. */
async function deleteFolder(name) {
  const moved = entries
    .filter((entry) => entry.folder === name)
    .map((entry) => folders.withFolder(entry, ""));
  await store.putAll(moved);
  folders.forget(name);
  openFolder("");
  await refreshEntries();
  if (moved.length) scheduleBackup();
}

/* ================= פעולות הגיבוי ================= */

/** פעולה אחת בכל רגע, עם ספינר על התווית וטיפול אחיד בשגיאות. */
async function runExclusive(labelId, label, task) {
  if (busy) return;
  busy = true;
  const restoreLabel = view.showBusyLabel(labelId, label);
  try {
    await task();
  } catch (error) {
    view.showNotice(backup.describeBackupError(error), true);
  } finally {
    busy = false;
    restoreLabel();
  }
}

/** מעלה גם כשלא השתנה כלום, וגם מעל גיבוי שכבר במאגר. */
function backupNow() {
  view.showNotice("");
  return runExclusive("backupSub", "מעלה עותק מוצפן למאגר", async () => {
    if ((await backup.backupIfChanged({ force: true })) !== "uploaded") return;
    backupBlocked = false;
    await renderBackupStatus();
    view.showNotice(`גובה. ${entries.length} רשומות.`);
    view.showToast("גובה");
  });
}

/* ================= הגדרת הגיבוי ================= */

/** פותח פאנל אחד וסוגר את מה שהיה פתוח. null סוגר הכל, וזה גם הביטול. */
function openSetupPanel(panel, code = null) {
  setupPanel = panel;
  pendingCode = code;
  setupError = null;
  return renderBackupSetup();
}

/** הצלחה סוגרת את הפאנל ומריצה גיבוי. כישלון משאיר את הפאנל ואת מה שהוקלד, עם ההודעה. */
async function runSetup(panel, task) {
  try {
    await task();
  } catch (error) {
    setupPanel = panel;
    setupError = backup.describeBackupError(error);
    return renderBackupSetup();
  }
  setupPanel = null;
  pendingCode = null;
  setupError = null;
  await Promise.all([renderBackupSetup(), renderBackupStatus()]);
  backupQuietly();
}

/** בלי גישה ללוח הקוד עדיין מסומן כולו בלחיצה, להעתקה ידנית. */
async function copyCode() {
  try {
    await navigator.clipboard.writeText(pendingCode);
    view.showToast("הקוד הועתק. אחרי ששמרת אותו, מחק אותו מהיסטוריית הלוח.");
  } catch {
    /* אין הודעה: הקוד עדיין על המסך. */
  }
}

function exportToFile() {
  const blob = new Blob([serializeEntries(entries)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = timestampedFilename();
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importFromFile(file) {
  try {
    const added = await store.addMissing(readEntries(await file.text()));
    await refreshEntries();
    view.showNotice(
      added ? `יובאו ${added} רשומות.` : "כל הרשומות בקובץ כבר קיימות."
    );
    if (added) {
      view.showToast(`יובאו ${added} רשומות`);
      scheduleBackup();
    }
  } catch {
    view.showNotice(BAD_BACKUP_MESSAGE, true);
  }
}

/* ================= חיווט ================= */

function wireComposer() {
  const composer = view.byId("composer");
  const saveButton = view.byId("saveBtn");

  const syncSaveButton = () => {
    saveButton.disabled = !composer.value.trim();
  };

  composer.value = readLocal(DRAFT_KEY);
  view.autoGrow(composer);
  syncSaveButton();

  composer.addEventListener("input", () => {
    view.autoGrow(composer);
    writeLocal(DRAFT_KEY, composer.value);
    syncSaveButton();
  });

  composer.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });

  saveButton.addEventListener("click", submit);

  async function submit() {
    const text = composer.value.trim();
    if (!text || busy) return;

    busy = true;
    saveButton.disabled = true;
    try {
      await addEntry(text);
      composer.value = "";
      writeLocal(DRAFT_KEY, "");
      view.autoGrow(composer);
      view.byId("hint").textContent = "";
    } catch {
      view.byId("hint").textContent = "השמירה נכשלה. הטקסט נשאר בתיבה.";
    } finally {
      busy = false;
      syncSaveButton();
    }
  }
}

function wireFolderBar() {
  const bar = view.byId("folders");

  bar.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-folder]");
    if (chip) return chooseFolder(chip.dataset.folder);

    const button = event.target.closest("[data-act]");
    if (!button) return;

    switch (button.dataset.act) {
      case "new-folder":
        closeFolderPanel();
        folderPanel = "create";
        return renderFolderBar({ focus: true });

      case "rename-folder":
        return renameFolder(
          folder,
          bar.querySelector('[data-role="renamefolder"]').value
        );

      case "cancel-folder":
        closeFolderPanel();
        return renderFolderBar();

      case "delete-folder":
        /* מחיקה דורשת לחיצה שנייה, כמו ברשומות. */
        if (!pendingFolderDelete) {
          pendingFolderDelete = true;
          return renderFolderBar();
        }
        return deleteFolder(folder);
    }
  });

  bar.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    if (event.target.matches('[data-role="newfolder"]')) {
      event.preventDefault();
      return createFolder(event.target.value);
    }
    if (event.target.matches('[data-role="renamefolder"]')) {
      event.preventDefault();
      return renameFolder(folder, event.target.value);
    }
  });

  /* נגיעה מחוץ לשורה סוגרת את שדה התיקייה החדשה. לא סוגרים כשהשדה מאבד
     פוקוס: זה קורה לפני שהלחיצה נוחתת, וסגירת השדה מזיזה שורה גלולה, כך
     שהלחיצה על תיקייה הייתה נופלת לידה. composedPath ולא contains, כי
     הכפתור שנלחץ כבר הוחלף כשהאירוע מגיע לכאן. */
  document.addEventListener("click", (event) => {
    if (folderPanel !== "create" || event.composedPath().includes(bar)) return;
    closeFolderPanel();
    renderFolderBar();
  });

  /* Escape ברמת המסמך: לחיצה על כפתור בשורה בונה אותה מחדש, והפוקוס נופל
     ל-body, כך שמאזין על השורה עצמה לא היה שומע אותו. */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !folderPanel) return;
    closeFolderPanel();
    renderFolderBar();
  });
}

function wireSearch() {
  const bar = view.byId("searchBar");
  const input = view.byId("searchInput");
  const button = view.byId("searchBtn");

  button.addEventListener("click", () => {
    const open = bar.classList.toggle("open");
    button.setAttribute("aria-expanded", open ? "true" : "false");

    if (open) {
      input.focus();
      return;
    }
    input.value = "";
    query = "";
    renderList();
  });

  input.addEventListener("input", (event) => {
    query = event.target.value.trim();
    renderList();
  });
}

function wireEntryList() {
  const list = view.byId("list");

  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    const article = event.target.closest(".entry");
    if (!button || !article) return;

    const { id } = article.dataset;

    switch (button.dataset.act) {
      case "edit":
        editingId = id;
        pendingDeleteId = null;
        return renderList();

      case "cancel":
        editingId = null;
        pendingDeleteId = null;
        return renderList();

      case "save": {
        const box = article.querySelector('[data-role="editbox"]');
        const text = box ? box.value.trim() : "";
        if (!text) return view.showToast("רשומה ריקה לא נשמרת");
        const folderName = article.querySelector('[data-role="folderbox"]').value;
        editingId = null;
        pendingDeleteId = null;
        return updateEntry(id, text, folderName);
      }

      case "delete":
        /* מחיקה דורשת לחיצה שנייה. */
        if (pendingDeleteId !== id) {
          pendingDeleteId = id;
          return renderList();
        }
        editingId = null;
        pendingDeleteId = null;
        return deleteEntry(id);
    }
  });

  list.addEventListener("input", (event) => {
    if (event.target.matches('[data-role="editbox"]')) {
      view.autoGrow(event.target);
    }
  });
}

function wireBackupSheet() {
  const scrim = view.byId("scrim");
  const sheet = view.byId("sheet");

  const openSheet = () => {
    scrim.classList.add("open");
    sheet.classList.add("open");
    view.showNotice("");
    view.showBackupMessage("");
    renderBackupStatus();
  };
  const closeSheet = () => {
    scrim.classList.remove("open");
    sheet.classList.remove("open");
  };

  view.byId("menuBtn").addEventListener("click", openSheet);
  scrim.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSheet();
  });

  view.byId("backupBtn").addEventListener("click", backupNow);
  view.byId("exportBtn").addEventListener("click", exportToFile);

  const fileInput = view.byId("importFile");
  view.byId("importBtn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (event) => {
    const [file] = event.target.files || [];
    if (file) importFromFile(file);
    event.target.value = "";
  });

  wireBackupSetup();
}

function wireBackupSetup() {
  const box = view.byId("backupSetup");
  const field = (role) => box.querySelector(`[data-role="${role}"]`).value;

  box.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;

    switch (button.dataset.act) {
      case "new-key":
        return openSetupPanel("new-key", await backup.newRecoveryCode());

      case "enter-code":
        return openSetupPanel("enter-code");

      case "edit-account":
        return openSetupPanel("account");

      case "cancel-setup":
        return openSetupPanel(null);

      case "copy-code":
        return copyCode();

      case "confirm-code":
        return runSetup("new-key", () => backup.saveKey(pendingCode));

      case "save-code":
        return runSetup("enter-code", () => backup.saveKey(field("codebox")));

      case "save-account":
        return runSetup("account", () =>
          backup.saveAccount(field("repobox"), field("tokenbox"))
        );
    }
  });
}

/* ================= עלייה ================= */

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .catch((error) => console.warn("service worker registration failed", error));
  });
}

async function boot() {
  folder = folders.selected();
  wireComposer();
  wireFolderBar();
  wireSearch();
  wireEntryList();
  wireBackupSheet();

  try {
    await store.open();
    await refreshEntries();
    await Promise.all([renderBackupSetup(), renderBackupStatus()]);
  } catch {
    view.byId("list").innerHTML =
      `<p class="empty">הדפדפן חוסם אחסון מקומי, ולכן אי אפשר לשמור רשומות.` +
      `<br>בדוק הרשאות אתר או מצב פרטי.</p>`;
    return;
  }

  /* גיבוי שקט בעלייה, כשהרשת חוזרת, ובכל מעבר לרקע ובחזרה ממנו. */
  backupQuietly();
  window.addEventListener("online", backupQuietly);
  document.addEventListener("visibilitychange", backupQuietly);

  registerServiceWorker();
}

boot();
