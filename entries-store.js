/* יומן — הרשומות במכשיר.
   עוטף IndexedDB מאחורי חמש פעולות. שמות מסד הנתונים והחנות הם חוזה
   מול הדפדפן: שינוי שלהם ינתק את המשתמש מכל מה שכתב עד היום. */

const DB_NAME = "journal";
const DB_VERSION = 1;
const STORE_NAME = "entries";

let db = null;

/** עוטף בקשת IndexedDB כ-Promise. */
function toPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(mode) {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

/** מזהה נוצר במכשיר, ולכן מיזוג בין מכשירים עובד בלי התנגשויות. */
export function createEntryId() {
  return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** נפתח פעם אחת בעלייה. כל שאר הפעולות מניחות שזה כבר קרה. */
export async function open() {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const opening = request.result;
    if (!opening.objectStoreNames.contains(STORE_NAME)) {
      const store = opening.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("createdAtMs", "createdAtMs");
    }
  };
  db = await toPromise(request);
}

/** כל הרשומות, החדשה קודם. */
export async function readAll() {
  const entries = await toPromise(transaction("readonly").getAll());
  return entries.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

export function put(entry) {
  return toPromise(transaction("readwrite").put(entry));
}

export function remove(id) {
  return toPromise(transaction("readwrite").delete(id));
}

/** מוסיף רק רשומות שה-id שלהן עוד לא כאן. מחזיר כמה נוספו.
    לא מוחק ולא דורס — שחזור אף פעם לא מפסיד מידע קיים. */
export async function addMissing(incoming) {
  const known = new Set((await readAll()).map((entry) => entry.id));
  const missing = incoming.filter((entry) => !known.has(entry.id));
  for (const entry of missing) await put(entry);
  return missing.length;
}
