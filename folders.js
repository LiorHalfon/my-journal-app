/* יומן — תיקיות.
   התיקייה של רשומה היא שדה `folder` עליה. המודול הזה זוכר אילו תיקיות
   קיימות, מתי נכתב בכל אחת לאחרונה, ואיזו פתוחה. לא נוגע ב-DOM ולא ב-IndexedDB. */

import { readLocal, writeLocal } from "./local-storage.js";

const RECORDS_KEY = "journal.folders.v1";
const SELECTED_KEY = "journal.folder.v1";
const MAX_NAME_LENGTH = 30;

const collate = new Intl.Collator("he").compare;

/* רשומה לכל תיקייה מוכרת: { name, at }, כש-at הוא הפעילות האחרונה בה.
   נשמרת גם כשהתיקייה מתרוקנת, ולכן תיקייה נעלמת רק כשמוחקים אותה.
   הרשימה חיה בזיכרון ו-localStorage רק משמר אותה, כך שבגלישה פרטית
   התיקיות עובדות עד שסוגרים את האפליקציה. */
let records = loadRecords();
let selectedName = readLocal(SELECTED_KEY);

function loadRecords() {
  try {
    const parsed = JSON.parse(readLocal(RECORDS_KEY, "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (record) =>
        record &&
        typeof record.name === "string" &&
        record.name &&
        Number.isFinite(record.at)
    );
  } catch {
    return [];
  }
}

function saveRecords() {
  writeLocal(RECORDS_KEY, JSON.stringify(records));
}

function find(name) {
  return records.find((record) => record.name === name);
}

/** כתיבה או עריכה. זה מה שמקדם תיקייה לראש השורה, לא פתיחה שלה. */
function activityOf(entry) {
  return Math.max(entry.createdAtMs || 0, entry.updatedAtMs || 0);
}

/** מסיר רווחים בקצוות, מאחד רווחים כפולים ומגביל ל-30 תווים.
    מחזיר "" כשלא נשאר שם. */
export function cleanName(raw) {
  if (typeof raw !== "string") return "";
  const collapsed = raw.trim().replace(/\s+/g, " ");
  return Array.from(collapsed).slice(0, MAX_NAME_LENGTH).join("").trim();
}

/** מעדכן את הרשימה מתוך הרשומות. נקרא אחרי כל קריאה מהמסד. */
export function learn(entries) {
  let changed = false;
  for (const entry of entries) {
    if (!entry.folder) continue;
    const at = activityOf(entry);
    const record = find(entry.folder);
    if (!record) {
      records.push({ name: entry.folder, at });
      changed = true;
    } else if (at > record.at) {
      record.at = at;
      changed = true;
    }
  }
  if (changed) saveRecords();
}

/** שמות התיקיות, זו שנכתב בה לאחרונה קודם. */
export function names() {
  return [...records]
    .sort((a, b) => b.at - a.at || collate(a.name, b.name))
    .map((record) => record.name);
}

/** תיקייה חדשה נכנסת ראשונה. שם קיים מוחזר בלי לזוז ממקומו. */
export function create(raw) {
  const name = cleanName(raw);
  if (!name) return "";
  if (!find(name)) {
    records.push({ name, at: Date.now() });
    saveRecords();
  }
  return name;
}

/** התיקייה שומרת על מקומה. שם של תיקייה קיימת ממזג את שתיהן. */
export function rename(from, to) {
  const record = find(from);
  if (!record || from === to) return;
  const target = find(to);
  if (target) {
    target.at = Math.max(target.at, record.at);
    records = records.filter((each) => each !== record);
  } else {
    record.name = to;
  }
  saveRecords();
}

export function forget(name) {
  records = records.filter((record) => record.name !== name);
  saveRecords();
}

/** התיקייה הפתוחה, או "" (הכל) אם היא כבר לא קיימת. */
export function selected() {
  return find(selectedName) ? selectedName : "";
}

export function select(name) {
  selectedName = name;
  writeLocal(SELECTED_KEY, name);
}

/** "" היא "הכל", ומתאימה לכל רשומה. */
export function matches(entry, folder) {
  return !folder || entry.folder === folder;
}

/** עותק של הרשומה בתיקייה אחרת. "" מסיר את השדה, שאף פעם לא נשמר ריק. */
export function withFolder(entry, name) {
  const { folder: _previous, ...rest } = entry;
  return name ? { ...rest, folder: name } : rest;
}
