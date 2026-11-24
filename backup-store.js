/* יומן — הגדרות הגיבוי במכשיר.
   מסד נפרד מהרשומות, ב-IndexedDB ולא ב-localStorage, כדי שגם ה-service worker
   יוכל לקרוא אותו. ארבע רשומות בלבד: key, github, remote, ו-prune (מתי מותר
   לנסות שוב לקצר את ההיסטוריה אחרי קיצוץ שנכשל).
   הערך נשמר כמו שהוא, וכך נשמר גם CryptoKey בלי שאפשר לייצא אותו. */

const DB_NAME = "journal-backup";
const DB_VERSION = 1;
const STORE_NAME = "settings";

let opening = null;

/** עוטף בקשת IndexedDB כ-Promise. */
function toPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** נפתח בשימוש הראשון. כשדף אחר מוחק או משדרג את המסד, החיבור נסגר ונפתח מחדש בשימוש הבא. */
function database() {
  if (!opening) {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    opening = toPromise(request).then(
      (db) => {
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        return db;
      },
      (error) => {
        opening = null;
        throw error;
      },
    );
  }
  return opening;
}

async function settings(mode) {
  return (await database()).transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

/** הערך השמור, או undefined אם אין. */
export async function get(name) {
  return toPromise((await settings("readonly")).get(name));
}

export async function set(name, value) {
  await toPromise((await settings("readwrite")).put(value, name));
}

export async function remove(name) {
  await toPromise((await settings("readwrite")).delete(name));
}
