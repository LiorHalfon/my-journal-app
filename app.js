/* ============================================================
   יומן — app.js
   אחסון: IndexedDB במכשיר. גיבוי: Google Drive (scope drive.file).
   ============================================================ */
"use strict";

/* ---------- הגדרה: הדבק כאן את ה-Client ID מ-Google Cloud ---------- */
const GOOGLE_CLIENT_ID = "PASTE-YOUR-CLIENT-ID.apps.googleusercontent.com";
/* ------------------------------------------------------------------ */

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Journal Backups";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MAIN_FILE = "journal-latest.json";
const SCHEMA = 1;

const DB_NAME = "journal";
const DB_VERSION = 1;
const STORE = "entries";
const LS_DRAFT = "journal.draft.v1";
const LS_FOLDER = "journal.folderId.v1";
const LS_MAINFILE = "journal.mainFileId.v1";
const LS_LASTSYNC = "journal.lastSync.v1";

/* ================= state ================= */
let entries = [];
let query = "";
let editingId = null;
let pendingDeleteId = null;
let busy = false;

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;
let gisReady = false;
let syncTimer = null;

/* ================= helpers ================= */
const $ = (id) => document.getElementById(id);

const newId = () =>
  "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

let toastTimer = null;
function toast(msg) {
  $("toastText").textContent = msg;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3600);
}

function notice(msg, bad) {
  $("sheetNotice").innerHTML = msg
    ? `<div class="notice${bad ? " bad" : ""}">${esc(msg)}</div>`
    : "";
}

const lsGet = (k, d) => {
  try { const v = localStorage.getItem(k); return v === null ? d : v; }
  catch { return d; }
};
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };

/* ================= dates ================= */
const fmtTime  = new Intl.DateTimeFormat("he-IL", { hour: "2-digit", minute: "2-digit", hour12: false });
const fmtDay   = new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long" });
const fmtDayY  = new Intl.DateTimeFormat("he-IL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtStamp = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  const k = dayKey(ms);
  if (k === dayKey(now.getTime())) return "היום · " + fmtDay.format(d);
  if (k === dayKey(now.getTime() - 86400000)) return "אתמול · " + fmtDay.format(d);
  if (d.getFullYear() !== now.getFullYear()) return fmtDayY.format(d);
  return fmtDay.format(d);
}
function stampName() {
  return "journal-" + new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z") + ".json";
}

/* ================= IndexedDB ================= */
let idb = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("createdAtMs", "createdAtMs");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode) {
  return idb.transaction(STORE, mode).objectStore(STORE);
}

function idbAll() {
  return new Promise((resolve, reject) => {
    const req = tx("readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(entry) {
  return new Promise((resolve, reject) => {
    const req = tx("readwrite").put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
function idbDel(id) {
  return new Promise((resolve, reject) => {
    const req = tx("readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function reload() {
  const all = await idbAll();
  entries = all.sort((a, b) => b.createdAtMs - a.createdAtMs);
  render();
}

/* ================= rendering ================= */
function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const parts = q.trim().split(/\s+/).filter(Boolean)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!parts.length) return safe;
  try {
    return safe.replace(new RegExp(`(${parts.join("|")})`, "gi"), "<mark>$1</mark>");
  } catch { return safe; }
}

function matches(e, q) {
  if (!q) return true;
  const t = e.text.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => t.includes(w));
}

function render() {
  const list = $("list");
  const shown = entries.filter((e) => matches(e, query));

  $("searchMeta").textContent = query
    ? (shown.length ? `${shown.length} רשומות תואמות` : "אין התאמות")
    : "";

  if (!entries.length) {
    list.innerHTML = `<p class="empty">עוד אין כאן כלום.<br>כתוב משהו למעלה — התאריך והשעה נשמרים לבד.</p>`;
    return;
  }
  if (!shown.length) {
    list.innerHTML = `<p class="empty">אין רשומה שמתאימה ל“${esc(query)}”.</p>`;
    return;
  }

  let html = "", lastKey = null;
  for (const e of shown) {
    const k = dayKey(e.createdAtMs);
    if (k !== lastKey) {
      if (lastKey !== null) html += "</section>";
      html += `<section class="daygroup"><div class="dayhead">${esc(dayLabel(e.createdAtMs))}</div>`;
      lastKey = k;
    }
    html += `<article class="entry" data-id="${esc(e.id)}">`;
    html += `<div class="entry-top"><span class="entry-time">${esc(fmtTime.format(new Date(e.createdAtMs)))}</span>`;
    html += `<span class="entry-rule"></span>`;
    html += `<button class="entry-menu" data-act="edit" aria-label="עריכת הרשומה">⋯</button></div>`;

    if (editingId === e.id) {
      html += `<div class="entry-edit"><textarea data-role="editbox">${esc(e.text)}</textarea>`;
      html += `<div class="row"><button class="tbtn primary" data-act="save">שמירה</button>`;
      html += `<button class="tbtn" data-act="cancel">ביטול</button>`;
      html += `<button class="tbtn danger" data-act="delete">${pendingDeleteId === e.id ? "לחיצה נוספת תמחק" : "מחיקה"}</button></div></div>`;
    } else {
      html += `<p class="entry-text">${highlight(e.text, query)}</p>`;
    }
    html += `</article>`;
  }
  if (lastKey !== null) html += "</section>";
  list.innerHTML = html;

  if (editingId) {
    const box = list.querySelector('[data-role="editbox"]');
    if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); autogrow(box); }
  }
}

function setSyncDot() {
  const dot = $("syncDot");
  dot.className = "dot" + (accessToken ? " on" : "");
  const last = lsGet(LS_LASTSYNC, "");
  dot.title = accessToken
    ? (last ? "סונכרן לאחרונה: " + fmtStamp.format(new Date(Number(last))) : "מחובר לדרייב")
    : "לא מחובר לדרייב";
}

/* ================= entry actions ================= */
async function addEntry(text) {
  const now = new Date();
  const e = { id: newId(), text, createdAt: now.toISOString(), createdAtMs: now.getTime() };
  await idbPut(e);
  await reload();
  scheduleSync();
}

async function updateEntry(id, text) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  await idbPut({ ...e, text, updatedAtMs: Date.now() });
  await reload();
  scheduleSync();
}

async function deleteEntry(id) {
  await idbDel(id);
  await reload();
  scheduleSync();
}

/* ================= Google auth ================= */
function gisAvailable() {
  return typeof google !== "undefined" && google.accounts && google.accounts.oauth2;
}

function initAuth() {
  if (!gisAvailable()) return false;
  if (GOOGLE_CLIENT_ID.startsWith("PASTE-")) {
    $("connectSub").textContent = "חסר Client ID ב-app.js";
    $("connectBtn").disabled = true;
    return false;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: SCOPE,
    callback: () => {},
  });
  gisReady = true;
  return true;
}

/** מבקש access token. interactive=false מנסה בשקט, בלי חלון הרשאות. */
function getToken(interactive) {
  if (accessToken && Date.now() < tokenExpiry - 60000) return Promise.resolve(accessToken);
  if (!gisReady && !initAuth()) return Promise.reject({ kind: "no_gis" });

  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) {
        reject({ kind: resp.error === "access_denied" ? "denied" : "auth", detail: resp.error });
        return;
      }
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + (Number(resp.expires_in || 3600) * 1000);
      setSyncDot();
      resolve(accessToken);
    };
    try {
      tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
    } catch (err) {
      reject({ kind: "auth", detail: String(err) });
    }
  });
}

function authErrMsg(err) {
  if (!err) return "הפעולה מול דרייב נכשלה.";
  switch (err.kind) {
    case "no_gis":
      return "ספריית ההתחברות של גוגל לא נטענה. בלי רשת אין גיבוי — הרשומות עצמן נשמרות רגיל.";
    case "denied":
      return "ההרשאה לא ניתנה. בלי הרשאת דרייב אין גיבוי.";
    case "auth":
      return "ההתחברות לגוגל נכשלה. נסה “חיבור לגוגל דרייב” שוב.";
    case "http":
      if (err.status === 401 || err.status === 403)
        return "ההרשאה פגה או נדחתה. לחץ “חיבור לגוגל דרייב” והרשה מחדש.";
      if (err.status === 404) return "הקובץ לא נמצא בדרייב. ייתכן שנמחק.";
      if (err.status === 429 || err.status >= 500)
        return "דרייב לא זמין כרגע. הרשומות שמורות במכשיר — נסה סנכרון שוב בעוד רגע.";
      return `דרייב החזיר שגיאה ${err.status}.`;
    case "offline":
      return "אין חיבור לרשת. הרשומות נשמרות במכשיר והסנכרון ימתין.";
    default:
      return "הפעולה מול דרייב נכשלה.";
  }
}

/* ================= Drive REST ================= */
async function api(url, options = {}) {
  if (!navigator.onLine) throw { kind: "offline" };
  const token = await getToken(false);
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (res.status === 401) {
    accessToken = null; tokenExpiry = 0; setSyncDot();
    throw { kind: "http", status: 401 };
  }
  if (!res.ok) throw { kind: "http", status: res.status };
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

async function driveList(q, fields = "files(id,name,createdTime,modifiedTime,size)") {
  const url = "https://www.googleapis.com/drive/v3/files"
    + `?q=${encodeURIComponent(q)}`
    + `&fields=${encodeURIComponent(fields)}`
    + "&orderBy=createdTime desc&pageSize=50&spaces=drive";
  const data = await api(url);
  return (data && data.files) || [];
}

async function ensureFolder() {
  const cached = lsGet(LS_FOLDER, "");
  if (cached) {
    try { await api(`https://www.googleapis.com/drive/v3/files/${cached}?fields=id,trashed`); return cached; }
    catch { lsDel(LS_FOLDER); }
  }
  const found = await driveList(
    `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`,
    "files(id,name)"
  );
  if (found.length) { lsSet(LS_FOLDER, found[0].id); return found[0].id; }

  const created = await api("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  lsSet(LS_FOLDER, created.id);
  return created.id;
}

function payload() {
  return JSON.stringify({
    app: "tiny-journal",
    schema: SCHEMA,
    exportedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  }, null, 2);
}

function multipartBody(metadata, content, boundary) {
  return (
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    content +
    `\r\n--${boundary}--`
  );
}

async function driveCreate(name, folderId, content) {
  const boundary = "jrnl" + Math.random().toString(36).slice(2);
  return api("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipartBody({ name, parents: [folderId] }, content, boundary),
  });
}

async function driveUpdate(fileId, content) {
  return api(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: content,
  });
}

/** מסנכרן את קובץ הגיבוי הראשי — עדכון במקום, לא קובץ חדש בכל פעם. */
async function syncMain() {
  const folderId = await ensureFolder();
  const content = payload();
  let fileId = lsGet(LS_MAINFILE, "");

  if (fileId) {
    try { await driveUpdate(fileId, content); }
    catch (err) { if (err.kind === "http" && err.status === 404) { lsDel(LS_MAINFILE); fileId = ""; } else throw err; }
  }
  if (!fileId) {
    const found = await driveList(
      `name='${MAIN_FILE}' and '${folderId}' in parents and trashed=false`,
      "files(id,name)"
    );
    if (found.length) { fileId = found[0].id; await driveUpdate(fileId, content); }
    else { const created = await driveCreate(MAIN_FILE, folderId, content); fileId = created.id; }
    lsSet(LS_MAINFILE, fileId);
  }
  lsSet(LS_LASTSYNC, String(Date.now()));
  setSyncDot();
}

/** סנכרון אוטומטי אחרי שינוי — רק אם כבר יש הרשאה חיה. */
function scheduleSync() {
  if (!accessToken) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncMain().catch(() => { /* שקט: הרשומות שמורות מקומית, יש כפתור ידני */ });
  }, 20000);
}

/* ================= merge / import ================= */
async function mergeEntries(incoming) {
  if (!Array.isArray(incoming)) throw new Error("bad");
  const have = new Set(entries.map((e) => e.id));
  const toAdd = incoming.filter(
    (e) => e && typeof e.text === "string" && e.id && !have.has(e.id)
  );
  for (const e of toAdd) {
    await idbPut({
      id: e.id,
      text: e.text,
      createdAt: e.createdAt || new Date(e.createdAtMs || Date.now()).toISOString(),
      createdAtMs: e.createdAtMs || Date.parse(e.createdAt) || Date.now(),
      updatedAtMs: e.updatedAtMs,
    });
  }
  await reload();
  return toAdd.length;
}

/* ================= sheet actions ================= */
async function doConnect() {
  notice("");
  try {
    await getToken(true);
    notice("מחובר לדרייב.");
    toast("מחובר לדרייב");
  } catch (err) { notice(authErrMsg(err), true); }
}

async function withBusy(subId, label, fn) {
  if (busy) return;
  busy = true;
  const el = $(subId);
  const old = el ? el.textContent : "";
  if (el) el.innerHTML = `<span class="spin"></span> ${esc(label)}`;
  try { await fn(); }
  catch (err) { notice(authErrMsg(err), true); }
  finally { busy = false; if (el) el.textContent = old; }
}

function doSync() {
  notice("");
  return withBusy("syncSub", "מסנכרן…", async () => {
    await getToken(false).catch(() => getToken(true));
    await syncMain();
    notice(`סונכרן — ${entries.length} רשומות בקובץ ${MAIN_FILE}.`);
    toast("סונכרן לדרייב");
  });
}

function doSnapshot() {
  notice("");
  return withBusy("syncSub", "שומר גרסה…", async () => {
    await getToken(false).catch(() => getToken(true));
    const folderId = await ensureFolder();
    const created = await driveCreate(stampName(), folderId, payload());
    notice(`נשמרה גרסה: ${created.name}`);
    toast("גרסה נשמרה בדרייב");
  });
}

function doRestoreList() {
  notice("");
  $("backupList").innerHTML = `<div class="notice"><span class="spin"></span> מחפש גיבויים…</div>`;
  return withBusy("syncSub", "מחפש…", async () => {
    await getToken(false).catch(() => getToken(true));
    const folderId = await ensureFolder();
    const files = await driveList(`'${folderId}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`);
    if (!files.length) {
      $("backupList").innerHTML = `<div class="notice">לא נמצאו קובצי גיבוי בתיקייה.</div>`;
      return;
    }
    let html = `<div class="divider"></div><p class="sub">בחר קובץ לשחזור. רשומות שכבר קיימות לא ישוכפלו.</p>`;
    for (const f of files) {
      const when = f.createdTime ? fmtStamp.format(new Date(f.createdTime)) : "";
      html += `<button class="backup-item" data-file="${esc(f.id)}">`
            + `<span class="ico" style="width:1.6rem;height:1.6rem;border-radius:.4rem;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;flex:none;font-size:.8rem">↓</span>`
            + `<span>${esc(f.name)}<time>${esc(when)}</time></span></button>`;
    }
    $("backupList").innerHTML = html;
  });
}

function doRestore(fileId) {
  $("backupList").innerHTML = `<div class="notice"><span class="spin"></span> משחזר…</div>`;
  return withBusy("syncSub", "משחזר…", async () => {
    const text = await api(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    let data;
    try { data = typeof text === "string" ? JSON.parse(text) : text; }
    catch { throw { kind: "parse" }; }
    const n = await mergeEntries(data && data.entries);
    $("backupList").innerHTML = `<div class="notice">${n ? `שוחזרו ${n} רשומות.` : "כל הרשומות בקובץ כבר קיימות."}</div>`;
    if (n) toast(`שוחזרו ${n} רשומות`);
  });
}

function doExport() {
  const blob = new Blob([payload()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = stampName();
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function doImport(file) {
  try {
    const data = JSON.parse(await file.text());
    const n = await mergeEntries(data && data.entries);
    notice(n ? `יובאו ${n} רשומות.` : "כל הרשומות בקובץ כבר קיימות.");
    if (n) { toast(`יובאו ${n} רשומות`); scheduleSync(); }
  } catch {
    notice("הקובץ לא נקרא כקובץ גיבוי תקין.", true);
  }
}

/* ================= composer ================= */
function autogrow(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 420) + "px";
}

function wireComposer() {
  const composer = $("composer");
  composer.value = lsGet(LS_DRAFT, "") || "";
  autogrow(composer);
  $("saveBtn").disabled = !composer.value.trim();

  composer.addEventListener("input", () => {
    autogrow(composer);
    lsSet(LS_DRAFT, composer.value);
    $("saveBtn").disabled = !composer.value.trim();
  });
  composer.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") { ev.preventDefault(); submit(); }
  });
  $("saveBtn").addEventListener("click", submit);

  async function submit() {
    const text = composer.value.trim();
    if (!text || busy) return;
    busy = true; $("saveBtn").disabled = true;
    try {
      await addEntry(text);
      composer.value = ""; lsSet(LS_DRAFT, ""); autogrow(composer);
      $("hint").textContent = "";
    } catch {
      $("hint").textContent = "השמירה נכשלה. הטקסט נשאר בתיבה.";
    } finally {
      busy = false; $("saveBtn").disabled = !composer.value.trim();
    }
  }
}

/* ================= wiring ================= */
function wire() {
  $("searchBtn").addEventListener("click", () => {
    const bar = $("searchBar");
    const open = bar.classList.toggle("open");
    $("searchBtn").setAttribute("aria-expanded", open ? "true" : "false");
    if (open) $("searchInput").focus();
    else { $("searchInput").value = ""; query = ""; render(); }
  });
  $("searchInput").addEventListener("input", (ev) => {
    query = ev.target.value.trim();
    render();
  });

  $("list").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const art = ev.target.closest(".entry");
    if (!art) return;
    const id = art.dataset.id;
    const act = btn.dataset.act;

    if (act === "edit")   { editingId = id; pendingDeleteId = null; render(); return; }
    if (act === "cancel") { editingId = null; pendingDeleteId = null; render(); return; }
    if (act === "save") {
      const box = art.querySelector('[data-role="editbox"]');
      const text = box ? box.value.trim() : "";
      if (!text) { toast("רשומה ריקה לא נשמרת"); return; }
      editingId = null; pendingDeleteId = null;
      await updateEntry(id, text);
      return;
    }
    if (act === "delete") {
      if (pendingDeleteId !== id) { pendingDeleteId = id; render(); return; }
      editingId = null; pendingDeleteId = null;
      await deleteEntry(id);
    }
  });
  $("list").addEventListener("input", (ev) => {
    if (ev.target.matches('[data-role="editbox"]')) autogrow(ev.target);
  });

  const openSheet = () => {
    $("scrim").classList.add("open");
    $("sheet").classList.add("open");
    notice(""); $("backupList").innerHTML = "";
  };
  const closeSheet = () => {
    $("scrim").classList.remove("open");
    $("sheet").classList.remove("open");
  };
  $("menuBtn").addEventListener("click", openSheet);
  $("scrim").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeSheet(); });

  $("connectBtn").addEventListener("click", doConnect);
  $("syncBtn").addEventListener("click", doSync);
  $("snapshotBtn").addEventListener("click", doSnapshot);
  $("restoreBtn").addEventListener("click", doRestoreList);
  $("exportBtn").addEventListener("click", doExport);
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) doImport(f);
    ev.target.value = "";
  });
  $("backupList").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-file]");
    if (b) doRestore(b.dataset.file);
  });

  window.addEventListener("online", () => { if (accessToken) scheduleSync(); });
}

/* ================= boot ================= */
(async function boot() {
  wireComposer();
  wire();
  setSyncDot();

  try {
    idb = await openDB();
    await reload();
  } catch {
    $("list").innerHTML = `<p class="empty">הדפדפן חוסם אחסון מקומי, ולכן אי אפשר לשמור רשומות.<br>בדוק הרשאות אתר או מצב פרטי.</p>`;
    return;
  }

  // ניסיון התחברות שקט — בלי חלון הרשאות. נכשל בשקט אם אין הסכמה קודמת.
  const trySilent = () => {
    if (!initAuth()) return;
    getToken(false)
      .then(() => { $("connectSub").textContent = "מחובר"; })
      .catch(() => {});
  };
  if (gisAvailable()) trySilent();
  else window.addEventListener("load", () => setTimeout(trySilent, 500));

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
