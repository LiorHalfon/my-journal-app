/* יומן — כל מה שנוגע ל-DOM.
   המודול הזה יודע למצוא אלמנטים ולבנות HTML; אף מודול אחר לא צריך.
   כל טקסט שמגיע מהמשתמש עובר ב-escapeHtml לפני שהוא נכנס ל-innerHTML. */

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

function entryHtml(entry, { query, editingId, pendingDeleteId }) {
  const time = escapeHtml(timeOf.format(new Date(entry.createdAtMs)));
  const head =
    `<div class="entry-top"><span class="entry-time">${time}</span>` +
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
    `<div class="row">` +
    `<button class="tbtn primary" data-act="save">שמירה</button>` +
    `<button class="tbtn" data-act="cancel">ביטול</button>` +
    `<button class="tbtn danger" data-act="delete">${deleteLabel}</button>` +
    `</div></div></article>`
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
  const { entries, query, editingId } = state;
  const list = byId("list");
  const shown = entries.filter((entry) => entryMatchesQuery(entry, query));

  byId("searchMeta").textContent = query
    ? shown.length
      ? `${shown.length} רשומות תואמות`
      : "אין התאמות"
    : "";

  if (!entries.length) {
    list.innerHTML =
      `<p class="empty">עוד אין כאן כלום.<br>` +
      `כתוב משהו למעלה — התאריך והשעה נשמרים לבד.</p>`;
    return;
  }
  if (!shown.length) {
    list.innerHTML = `<p class="empty">אין רשומה שמתאימה ל“${escapeHtml(query)}”.</p>`;
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
