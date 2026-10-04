/* יומן — כל מה שנוגע ל-DOM.
   המודול הזה יודע למצוא אלמנטים ולבנות HTML; אף מודול אחר לא צריך.
   כל טקסט שמגיע מהמשתמש עובר ב-escapeHtml לפני שהוא נכנס ל-innerHTML. */

import { matches } from "./folders.js";

export const byId = (id) => document.getElementById(id);

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);

/* ================= תאריכים ================= */

const HEBREW = "he-IL";
const timeOf = new Intl.DateTimeFormat(HEBREW, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dayOf = new Intl.DateTimeFormat(HEBREW, {
  weekday: "long",
  day: "numeric",
  month: "long",
});
const dayWithYearOf = new Intl.DateTimeFormat(HEBREW, {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const shortStampOf = new Intl.DateTimeFormat(HEBREW, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const ONE_DAY_MS = 86400000;

function dayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function dayLabel(ms) {
  const date = new Date(ms);
  const now = new Date();
  const key = dayKey(ms);

  if (key === dayKey(now.getTime())) return "היום · " + dayOf.format(date);
  if (key === dayKey(now.getTime() - ONE_DAY_MS))
    return "אתמול · " + dayOf.format(date);
  if (date.getFullYear() !== now.getFullYear())
    return dayWithYearOf.format(date);
  return dayOf.format(date);
}

/* ================= חיפוש ================= */

const searchWords = (query) =>
  query.toLowerCase().split(/\s+/).filter(Boolean);

function entryMatchesQuery(entry, query) {
  if (!query) return true;
  const text = entry.text.toLowerCase();
  return searchWords(query).every((word) => text.includes(word));
}

/** מסמן את מילות החיפוש. מבריח קודם, ורק אז מוסיף את התגית. */
function highlightMatches(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;

  const patterns = searchWords(query).map((word) =>
    word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  if (!patterns.length) return safe;

  try {
    const pattern = new RegExp(`(${patterns.join("|")})`, "gi");
    return safe.replace(pattern, "<mark>$1</mark>");
  } catch {
    return safe;
  }
}

/* ================= רשימת הרשומות ================= */

function entryHtml(entry, { folder, folderNames, query, editingId, pendingDeleteId }) {
  const time = escapeHtml(timeOf.format(new Date(entry.createdAtMs)));
  /* בתוך תיקייה כל הרשומות שלה, ולכן התווית מופיעה רק תחת "הכל". */
  const label =
    !folder && entry.folder
      ? `<span class="entry-folder">${escapeHtml(entry.folder)}</span>`
      : "";
  const head =
    `<div class="entry-top"><span class="entry-time">${time}</span>${label}` +
    `<span class="entry-rule"></span>` +
    `<button class="entry-menu" data-act="edit" aria-label="עריכת הרשומה">⋯</button></div>`;

  if (editingId !== entry.id) {
    return (
      `<article class="entry" data-id="${escapeHtml(entry.id)}">${head}` +
      `<p class="entry-text">${highlightMatches(entry.text, query)}</p></article>`
    );
  }

  const deleteLabel =
    pendingDeleteId === entry.id ? "לחיצה נוספת תמחק" : "מחיקה";
  return (
    `<article class="entry" data-id="${escapeHtml(entry.id)}">${head}` +
    `<div class="entry-edit">` +
    `<textarea data-role="editbox">${escapeHtml(entry.text)}</textarea>` +
    folderPickHtml(entry.folder || "", folderNames) +
    `<div class="row">` +
    `<button class="tbtn primary" data-act="save">שמירה</button>` +
    `<button class="tbtn" data-act="cancel">ביטול</button>` +
    `<button class="tbtn danger" data-act="delete">${deleteLabel}</button>` +
    `</div></div></article>`
  );
}

/** "ללא תיקייה" ראשון, ואחריו התיקיות באותו סדר כמו בשורה. */
function folderPickHtml(current, folderNames) {
  const options = ["", ...folderNames].map((name) => {
    const selected = name === current ? " selected" : "";
    const label = name ? escapeHtml(name) : "ללא תיקייה";
    return `<option value="${escapeHtml(name)}"${selected}>${label}</option>`;
  });
  return (
    `<label class="entry-folder-pick">תיקייה ` +
    `<select data-role="folderbox">${options.join("")}</select></label>`
  );
}

function groupedByDayHtml(entries, state) {
  const sections = [];
  let openKey = null;

  for (const entry of entries) {
    const key = dayKey(entry.createdAtMs);
    if (key !== openKey) {
      if (openKey !== null) sections.push("</section>");
      sections.push(
        `<section class="daygroup"><div class="dayhead">` +
          `${escapeHtml(dayLabel(entry.createdAtMs))}</div>`
      );
      openKey = key;
    }
    sections.push(entryHtml(entry, state));
  }
  if (openKey !== null) sections.push("</section>");

  return sections.join("");
}

/** מצייר את הרשימה כולה מחדש מתוך המצב שהועבר. */
export function renderEntries(state) {
  const { entries, folder, query, editingId } = state;
  const list = byId("list");
  const inFolder = entries.filter((entry) => matches(entry, folder));
  const shown = inFolder.filter((entry) => entryMatchesQuery(entry, query));

  byId("searchMeta").textContent = query
    ? shown.length
      ? `${shown.length} רשומות תואמות`
      : "אין התאמות"
    : "";

  if (!inFolder.length) {
    list.innerHTML = folder
      ? `<p class="empty">עוד אין כאן כלום ב“${escapeHtml(folder)}”.</p>`
      : `<p class="empty">עוד אין כאן כלום.<br>` +
        `כתוב משהו למעלה — התאריך והשעה נשמרים לבד.</p>`;
    return;
  }
  if (!shown.length) {
    const where = folder ? `ב“${escapeHtml(folder)}” ` : "";
    list.innerHTML = `<p class="empty">אין רשומה ${where}שמתאימה ל“${escapeHtml(query)}”.</p>`;
    return;
  }

  list.innerHTML = groupedByDayHtml(shown, state);

  if (editingId) focusEditBox(list);
}

function focusEditBox(list) {
  const box = list.querySelector('[data-role="editbox"]');
  if (!box) return;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
  autoGrow(box);
}

/* ================= תיקיות ================= */

const NEW_FOLDER_BUTTON =
  `<button class="chip chip-add" data-act="new-folder">+ תיקייה</button>`;

const NEW_FOLDER_FIELD =
  `<input class="chip chip-input" data-role="newfolder" maxlength="30" ` +
  `placeholder="שם התיקייה" aria-label="שם התיקייה החדשה" ` +
  `autocomplete="off" enterkeyhint="done">`;

function chipHtml(name, label, open) {
  const isOpen = name === open;
  /* ⋯ רק על התיקייה הפתוחה: לחיצה עליה פותחת שינוי שם ומחיקה. */
  const more = isOpen && name ? `<span class="chip-more" aria-hidden="true">⋯</span>` : "";
  return (
    `<button class="chip" data-folder="${escapeHtml(name)}" ` +
    `aria-pressed="${isOpen}">${escapeHtml(label)}${more}</button>`
  );
}

function managePanelHtml(folder, pendingDelete) {
  const deleteLabel = pendingDelete ? "לחיצה נוספת תמחק" : "מחיקת התיקייה";
  const note = pendingDelete
    ? `<p class="note">הרשומות לא יימחקו. הן יישארו תחת “הכל”, בלי תיקייה.</p>`
    : "";
  return (
    `<div class="folder-panel">` +
    `<input data-role="renamefolder" value="${escapeHtml(folder)}" maxlength="30" ` +
    `aria-label="שם התיקייה" autocomplete="off" enterkeyhint="done">` +
    `<div class="row">` +
    `<button class="tbtn primary" data-act="rename-folder">שינוי שם</button>` +
    `<button class="tbtn" data-act="cancel-folder">ביטול</button>` +
    `<button class="tbtn danger" data-act="delete-folder">${deleteLabel}</button>` +
    `</div>${note}</div>`
  );
}

/** מצייר את שורת התיקיות מחדש. שומר את מיקום הגלילה ואת מה שהוקלד,
    כי השורה נבנית מחדש גם אחרי שמירה, כשאולי יש בה שדה פתוח. */
export function renderFolders(
  { names, folder, panel, pendingFolderDelete },
  { focus = false, reveal = false } = {}
) {
  const box = byId("folders");
  const oldInput = box.querySelector("input");
  const oldScroll = box.querySelector(".chips")?.scrollLeft ?? 0;

  const chips = [
    chipHtml("", "הכל", folder),
    ...names.map((name) => chipHtml(name, name, folder)),
    panel === "create" ? NEW_FOLDER_FIELD : NEW_FOLDER_BUTTON,
  ];
  box.innerHTML =
    `<div class="chips" role="group" aria-label="תיקיות">${chips.join("")}</div>` +
    (panel === "manage" && folder ? managePanelHtml(folder, pendingFolderDelete) : "");
  const row = box.querySelector(".chips");
  row.scrollLeft = oldScroll;
  if (reveal) revealOpenChip(row);

  const input = box.querySelector("input");
  if (!input) return;
  if (oldInput && oldInput.dataset.role === input.dataset.role) {
    input.value = oldInput.value;
  }
  if (focus) input.focus();
}

/** גולל את השורה לבד, בלי לגלול את הדף, עד שהתיקייה הפתוחה נראית.
    בלי זה, אחרי טעינה או יצירה, אפשר לכתוב לתיקייה שלא רואים. */
function revealOpenChip(row) {
  const chip = row.querySelector('[aria-pressed="true"]');
  if (!chip) return;
  const edges = row.getBoundingClientRect();
  const box = chip.getBoundingClientRect();
  if (box.left < edges.left) row.scrollLeft -= edges.left - box.left;
  else if (box.right > edges.right) row.scrollLeft += box.right - edges.right;
}

/* ================= מצב הסנכרון ================= */

export function renderSyncStatus({ connected, lastSyncAt }) {
  const dot = byId("syncDot");
  dot.className = "dot" + (connected ? " on" : "");

  if (!connected) {
    dot.title = "לא מחובר לדרייב";
    return;
  }
  dot.title = lastSyncAt
    ? "סונכרן לאחרונה: " + shortStampOf.format(new Date(lastSyncAt))
    : "מחובר לדרייב";
}

/* ================= הודעות ================= */

let toastTimer = null;
const TOAST_MS = 3600;

export function showToast(message) {
  byId("toastText").textContent = message;
  byId("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => byId("toast").classList.remove("show"), TOAST_MS);
}

export function showNotice(message, isError = false) {
  byId("sheetNotice").innerHTML = message
    ? `<div class="notice${isError ? " bad" : ""}">${escapeHtml(message)}</div>`
    : "";
}

/** מחליף תווית בכפתור בספינר, ומחזיר את הפונקציה שמשיבה אותה. */
export function showBusyLabel(id, label) {
  const element = byId(id);
  if (!element) return () => {};
  const original = element.textContent;
  element.innerHTML = `<span class="spin"></span> ${escapeHtml(label)}`;
  return () => {
    element.textContent = original;
  };
}

/* ================= רשימת הגיבויים ================= */

export function showBackupMessage(message, { busy = false } = {}) {
  const spinner = busy ? `<span class="spin"></span> ` : "";
  byId("backupList").innerHTML = message
    ? `<div class="notice">${spinner}${escapeHtml(message)}</div>`
    : "";
}

export function renderBackupList(files) {
  const items = files.map((file) => {
    const when = file.createdTime
      ? shortStampOf.format(new Date(file.createdTime))
      : "";
    return (
      `<button class="backup-item" data-file="${escapeHtml(file.id)}">` +
      `<span class="backup-ico">↓</span>` +
      `<span>${escapeHtml(file.name)}<time>${escapeHtml(when)}</time></span></button>`
    );
  });

  byId("backupList").innerHTML =
    `<div class="divider"></div>` +
    `<p class="sub">בחר קובץ לשחזור. רשומות שכבר קיימות לא ישוכפלו.</p>` +
    items.join("");
}

/* ================= הכתיבה ================= */

const MAX_COMPOSER_PX = 420;

/** תיבת טקסט שגדלה עם התוכן, עד גבול. */
export function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, MAX_COMPOSER_PX) + "px";
}
