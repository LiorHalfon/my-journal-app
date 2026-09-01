/* יומן — חיווט.
   מחזיק את מצב המסך, מחבר אירועים למודולים, ומעלה הכל.
   הלוגיקה עצמה יושבת ב-entries-store, drive, backup-file ו-view. */

import * as store from "./entries-store.js";
import * as drive from "./drive.js";
import * as view from "./view.js";
import {
  serializeEntries,
  readEntries,
  timestampedFilename,
} from "./backup-file.js";
import { readLocal, writeLocal } from "./local-storage.js";

const DRAFT_KEY = "journal.draft.v1";
const AUTO_SYNC_DELAY_MS = 20000;
const BAD_BACKUP_MESSAGE = "הקובץ לא נקרא כקובץ גיבוי תקין.";

/* ================= מצב המסך ================= */

let entries = [];
let query = "";
let editingId = null;
let pendingDeleteId = null;
let busy = false;
let autoSyncTimer = null;

function render() {
  view.renderEntries({ entries, query, editingId, pendingDeleteId });
}

function renderSyncStatus() {
  view.renderSyncStatus({
    connected: drive.isConnected(),
    lastSyncAt: drive.lastSyncAt(),
  });
}

async function refreshEntries() {
  entries = await store.readAll();
  render();
}

/* ================= רשומות ================= */

async function addEntry(text) {
  const now = new Date();
  await store.put({
    id: store.createEntryId(),
    text,
    createdAt: now.toISOString(),
    createdAtMs: now.getTime(),
  });
  await refreshEntries();
  scheduleAutoSync();
}

async function updateEntry(id, text) {
  const existing = entries.find((entry) => entry.id === id);
  if (!existing) return;
  await store.put({ ...existing, text, updatedAtMs: Date.now() });
  await refreshEntries();
  scheduleAutoSync();
}

async function deleteEntry(id) {
  await store.remove(id);
  await refreshEntries();
  scheduleAutoSync();
}

/** סנכרון שקט אחרי שינוי. כישלון לא מדווח — הרשומות במכשיר, ויש כפתור ידני. */
function scheduleAutoSync() {
  if (!drive.isConnected()) return;
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    drive.syncLatestIfConnected(serializeEntries(entries));
  }, AUTO_SYNC_DELAY_MS);
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
    view.showNotice(drive.describeDriveError(error), true);
  } finally {
    busy = false;
    restoreLabel();
  }
}

async function connectToDrive() {
  view.showNotice("");
  try {
    await drive.connect();
    view.showNotice("מחובר לדרייב.");
    view.showToast("מחובר לדרייב");
  } catch (error) {
    view.showNotice(drive.describeDriveError(error), true);
  }
}

function syncNow() {
  view.showNotice("");
  return runExclusive("syncSub", "מסנכרן…", async () => {
    const filename = await drive.syncLatest(serializeEntries(entries));
    view.showNotice(`סונכרן — ${entries.length} רשומות בקובץ ${filename}.`);
    view.showToast("סונכרן לדרייב");
  });
}

function saveSnapshot() {
  view.showNotice("");
  return runExclusive("syncSub", "שומר גרסה…", async () => {
    const name = await drive.saveSnapshot(
      timestampedFilename(),
      serializeEntries(entries)
    );
    view.showNotice(`נשמרה גרסה: ${name}`);
    view.showToast("גרסה נשמרה בדרייב");
  });
}

function showBackups() {
  view.showNotice("");
  view.showBackupMessage("מחפש גיבויים…", { busy: true });
  return runExclusive("syncSub", "מחפש…", async () => {
    const files = await drive.listBackups();
    if (!files.length) {
      view.showBackupMessage("לא נמצאו קובצי גיבוי בתיקייה.");
      return;
    }
    view.renderBackupList(files);
  });
}

function restoreFrom(fileId) {
  view.showBackupMessage("משחזר…", { busy: true });
  return runExclusive("syncSub", "משחזר…", async () => {
    const text = await drive.downloadBackup(fileId);

    let incoming;
    try {
      incoming = readEntries(text);
    } catch {
      view.showBackupMessage(BAD_BACKUP_MESSAGE);
      return;
    }

    const added = await store.addMissing(incoming);
    await refreshEntries();
    view.showBackupMessage(
      added ? `שוחזרו ${added} רשומות.` : "כל הרשומות בקובץ כבר קיימות."
    );
    if (added) view.showToast(`שוחזרו ${added} רשומות`);
  });
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
      scheduleAutoSync();
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
    render();
  });

  input.addEventListener("input", (event) => {
    query = event.target.value.trim();
    render();
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
        return render();

      case "cancel":
        editingId = null;
        pendingDeleteId = null;
        return render();

      case "save": {
        const box = article.querySelector('[data-role="editbox"]');
        const text = box ? box.value.trim() : "";
        if (!text) return view.showToast("רשומה ריקה לא נשמרת");
        editingId = null;
        pendingDeleteId = null;
        return updateEntry(id, text);
      }

      case "delete":
        /* מחיקה דורשת לחיצה שנייה. */
        if (pendingDeleteId !== id) {
          pendingDeleteId = id;
          return render();
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

  view.byId("connectBtn").addEventListener("click", connectToDrive);
  view.byId("syncBtn").addEventListener("click", syncNow);
  view.byId("snapshotBtn").addEventListener("click", saveSnapshot);
  view.byId("restoreBtn").addEventListener("click", showBackups);
  view.byId("exportBtn").addEventListener("click", exportToFile);

  const fileInput = view.byId("importFile");
  view.byId("importBtn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (event) => {
    const [file] = event.target.files || [];
    if (file) importFromFile(file);
    event.target.value = "";
  });

  view.byId("backupList").addEventListener("click", (event) => {
    const item = event.target.closest("[data-file]");
    if (item) restoreFrom(item.dataset.file);
  });
}

/* ================= עלייה ================= */

/** ספריית גוגל נטענת async, ולכן שווה לנסות שוב אחרי טעינת הדף. */
function reconnectWhenReady() {
  const attempt = async () => {
    const connected = await drive.reconnectSilently();
    if (connected) view.byId("connectSub").textContent = "מחובר";
    return connected;
  };

  attempt().then((connected) => {
    if (connected) return;
    window.addEventListener("load", () => setTimeout(attempt, 500));
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .catch((error) => console.warn("service worker registration failed", error));
  });
}

async function boot() {
  wireComposer();
  wireSearch();
  wireEntryList();
  wireBackupSheet();

  drive.onConnectionChange(renderSyncStatus);
  renderSyncStatus();
  window.addEventListener("online", scheduleAutoSync);

  try {
    await store.open();
    await refreshEntries();
  } catch {
    view.byId("list").innerHTML =
      `<p class="empty">הדפדפן חוסם אחסון מקומי, ולכן אי אפשר לשמור רשומות.` +
      `<br>בדוק הרשאות אתר או מצב פרטי.</p>`;
    return;
  }

  if (drive.isConfigured()) {
    reconnectWhenReady();
  } else {
    view.byId("connectSub").textContent = "חסר Client ID ב-config.js";
    view.byId("connectBtn").disabled = true;
  }

  registerServiceWorker();
}

boot();
