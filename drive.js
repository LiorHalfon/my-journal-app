/* יומן — גיבוי לגוגל דרייב.
   ה-scope הוא drive.file בלבד: האפליקציה רואה רק קבצים שהיא עצמה יצרה,
   ולכן חיפוש התיקייה לפי שם עובד רק כי היא זו שיצרה אותה.

   הזרימה היא token client, בלי refresh tokens. הטוקן חי בזיכרון כשעה
   ונעלם עם רענון הדף — שום דבר רגיש לא נכתב לדיסק. */

import { GOOGLE_CLIENT_ID } from "./config.js";
import { readLocal, writeLocal, clearLocal } from "./local-storage.js";

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Journal Backups";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const LATEST_FILE_NAME = "journal-latest.json";

const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";

/* מפתחות אחסון — חוזה מול הדפדפן, לא לשנות. */
const CACHED_FOLDER_ID = "journal.folderId.v1";
const CACHED_LATEST_ID = "journal.mainFileId.v1";
const LAST_SYNC_AT = "journal.lastSync.v1";

/** כשל מול דרייב. ה-kind הוא מה שקובע את ההודעה למשתמש. */
export class DriveError extends Error {
  constructor(kind, status) {
    super(status ? `drive ${kind} ${status}` : `drive ${kind}`);
    this.name = "DriveError";
    this.kind = kind;
    this.status = status;
  }
}

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let notifyConnectionChanged = () => {};

/* ================= חיבור ================= */

/** האם הודבק Client ID אמיתי. בלעדיו אין טעם להציע חיבור. */
export function isConfigured() {
  return !GOOGLE_CLIENT_ID.startsWith("PASTE-");
}

export function isConnected() {
  return Boolean(accessToken) && Date.now() < tokenExpiresAt;
}

export function lastSyncAt() {
  const stored = Number(readLocal(LAST_SYNC_AT, ""));
  return stored || null;
}

/** מודיע כשמצב החיבור משתנה, כדי שהתצוגה תוכל להתעדכן. */
export function onConnectionChange(listener) {
  notifyConnectionChanged = listener;
}

function isGisLoaded() {
  return (
    typeof google !== "undefined" && google.accounts && google.accounts.oauth2
  );
}

function initTokenClient() {
  if (tokenClient) return true;
  if (!isConfigured() || !isGisLoaded()) return false;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: () => {},
  });
  return true;
}

function forgetToken() {
  accessToken = null;
  tokenExpiresAt = 0;
  notifyConnectionChanged();
}

/** interactive=false מנסה בשקט; נכשל אם המשתמש עוד לא נתן הסכמה. */
function requestToken(interactive) {
  const stillFresh = accessToken && Date.now() < tokenExpiresAt - 60000;
  if (stillFresh) return Promise.resolve(accessToken);
  if (!initTokenClient()) return Promise.reject(new DriveError("no-gis"));

  return new Promise((resolve, reject) => {
    tokenClient.callback = (response) => {
      if (response.error) {
        const denied = response.error === "access_denied";
        reject(new DriveError(denied ? "denied" : "auth"));
        return;
      }
      accessToken = response.access_token;
      tokenExpiresAt = Date.now() + Number(response.expires_in || 3600) * 1000;
      notifyConnectionChanged();
      resolve(accessToken);
    };
    try {
      tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
    } catch {
      reject(new DriveError("auth"));
    }
  });
}

/** חיבור מפורש, עם חלון ההרשאות של גוגל. */
export function connect() {
  return requestToken(true);
}

/** מנסה להתחבר בלי להפריע. נכשל בשקט אם אין הסכמה קודמת. */
export async function reconnectSilently() {
  try {
    await requestToken(false);
    return true;
  } catch {
    return false;
  }
}

/** בשקט אם אפשר, ואם לא — מבקש הרשאה. לפני כל פעולה שהמשתמש ביקש. */
function ensureConnected() {
  return requestToken(false).catch(() => requestToken(true));
}

/* ================= בקשות ================= */

async function driveRequest(url, options = {}) {
  if (!navigator.onLine) throw new DriveError("offline");
  const token = await requestToken(false);
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });

  if (response.status === 401) {
    forgetToken();
    throw new DriveError("http", 401);
  }
  if (!response.ok) throw new DriveError("http", response.status);

  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json")
    ? response.json()
    : response.text();
}

async function listFiles(query, fields) {
  const params = new URLSearchParams({
    q: query,
    fields,
    orderBy: "createdTime desc",
    pageSize: "50",
    spaces: "drive",
  });
  const data = await driveRequest(`${FILES_URL}?${params}`);
  return (data && data.files) || [];
}

/** מוצא או יוצר את תיקיית הגיבוי. ה-id נשמר כדי לא לחפש בכל פעם. */
async function ensureBackupFolder() {
  const cachedId = readLocal(CACHED_FOLDER_ID);
  if (cachedId) {
    try {
      await driveRequest(`${FILES_URL}/${cachedId}?fields=id,trashed`);
      return cachedId;
    } catch {
      clearLocal(CACHED_FOLDER_ID);
    }
  }

  const existing = await listFiles(
    `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`,
    "files(id,name)"
  );
  if (existing.length) {
    writeLocal(CACHED_FOLDER_ID, existing[0].id);
    return existing[0].id;
  }

  const created = await driveRequest(`${FILES_URL}?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  writeLocal(CACHED_FOLDER_ID, created.id);
  return created.id;
}

function multipartBody(metadata, content, boundary) {
  const part = "Content-Type: application/json; charset=UTF-8\r\n\r\n";
  return (
    `--${boundary}\r\n${part}${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n${part}${content}\r\n` +
    `--${boundary}--`
  );
}

function uploadNewFile(name, folderId, content) {
  const boundary = "jrnl" + Math.random().toString(36).slice(2);
  return driveRequest(`${UPLOAD_URL}?uploadType=multipart&fields=id,name`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipartBody({ name, parents: [folderId] }, content, boundary),
  });
}

function overwriteFile(fileId, content) {
  return driveRequest(`${UPLOAD_URL}/${fileId}?uploadType=media&fields=id`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: content,
  });
}

/* ================= פעולות ================= */

/** מעדכן את קובץ הגיבוי הראשי במקום. קובץ אחד שמתעדכן, לא ערימה. */
export async function syncLatest(content) {
  await ensureConnected();
  const folderId = await ensureBackupFolder();
  let fileId = readLocal(CACHED_LATEST_ID);

  if (fileId) {
    try {
      await overwriteFile(fileId, content);
    } catch (error) {
      const gone = error instanceof DriveError && error.status === 404;
      if (!gone) throw error;
      clearLocal(CACHED_LATEST_ID);
      fileId = "";
    }
  }

  if (!fileId) {
    const [existing] = await listFiles(
      `name='${LATEST_FILE_NAME}' and '${folderId}' in parents and trashed=false`,
      "files(id,name)"
    );
    if (existing) {
      fileId = existing.id;
      await overwriteFile(fileId, content);
    } else {
      fileId = (await uploadNewFile(LATEST_FILE_NAME, folderId, content)).id;
    }
    writeLocal(CACHED_LATEST_ID, fileId);
  }

  writeLocal(LAST_SYNC_AT, String(Date.now()));
  notifyConnectionChanged();
  return LATEST_FILE_NAME;
}

/** עותק נפרד עם חותמת זמן, שלא נדרס. לנקודות ציון. */
export async function saveSnapshot(filename, content) {
  await ensureConnected();
  const folderId = await ensureBackupFolder();
  const created = await uploadNewFile(filename, folderId, content);
  return created.name;
}

/** סנכרון ברקע אחרי שינוי — רק כשכבר יש הרשאה חיה, ובלי להטריד. */
export async function syncLatestIfConnected(content) {
  if (!isConnected()) return false;
  try {
    await syncLatest(content);
    return true;
  } catch {
    return false;
  }
}

export async function listBackups() {
  await ensureConnected();
  const folderId = await ensureBackupFolder();
  return listFiles(
    `'${folderId}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`,
    "files(id,name,createdTime,modifiedTime,size)"
  );
}

export function downloadBackup(fileId) {
  return driveRequest(`${FILES_URL}/${fileId}?alt=media`);
}

/* ================= הודעות ================= */

/** מתרגם כשל להודעה שאפשר לפעול לפיה. */
export function describeDriveError(error) {
  const kind = error && error.kind;

  if (kind === "no-gis")
    return "ספריית ההתחברות של גוגל לא נטענה. בלי רשת אין גיבוי — הרשומות עצמן נשמרות רגיל.";
  if (kind === "denied") return "ההרשאה לא ניתנה. בלי הרשאת דרייב אין גיבוי.";
  if (kind === "auth")
    return "ההתחברות לגוגל נכשלה. נסה “חיבור לגוגל דרייב” שוב.";
  if (kind === "offline")
    return "אין חיבור לרשת. הרשומות נשמרות במכשיר והסנכרון ימתין.";

  if (kind === "http") {
    const { status } = error;
    if (status === 401 || status === 403)
      return "ההרשאה פגה או נדחתה. לחץ “חיבור לגוגל דרייב” והרשה מחדש.";
    if (status === 404) return "הקובץ לא נמצא בדרייב. ייתכן שנמחק.";
    if (status === 429 || status >= 500)
      return "דרייב לא זמין כרגע. הרשומות שמורות במכשיר — נסה סנכרון שוב בעוד רגע.";
    return `דרייב החזיר שגיאה ${status}.`;
  }

  return "הפעולה מול דרייב נכשלה.";
}
