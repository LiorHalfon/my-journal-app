/* יומן — service worker
   מטרה: האפליקציה נפתחת ועובדת בלי רשת. הרשומות עצמן ב-IndexedDB,
   כאן רק שלד האפליקציה והפונטים. */

const VERSION = "v3";
const SHELL = "journal-shell-" + VERSION;

/* כל קובץ כאן חייב להיות קיים: addAll נכשל אטומית, וכישלון אחד
   מפיל את ההתקנה כולה ומשאיר את האפליקציה בלי מצב אופליין. */
const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./local-storage.js",
  "./folders.js",
  "./entries-store.js",
  "./backup-file.js",
  "./vault.js",
  "./github.js",
  "./backup-store.js",
  "./backup.js",
  "./view.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./fonts/assistant-hebrew.woff2",
  "./fonts/assistant-latin.woff2",
  "./fonts/heebo-hebrew.woff2",
  "./fonts/heebo-latin.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* רשת קודם, קאש כרשת ביטחון.
   `cache: "no-cache"` שולח בקשה מותנית ועוקף את ה-max-age=600 של GitHub Pages,
   כך שגרסה חדשה נתפסת בפתיחה הראשונה אחרי הפריסה ולא עשר דקות אחריה.
   ETag מחזיר 304 כשאין שינוי, אז המחיר זניח. בלי רשת — מה שבקאש. */
async function networkFirst(req, key) {
  try {
    const res = await fetch(req, { cache: "no-cache" });
    if (res.ok) {
      const copy = res.clone();
      caches.open(SHELL).then((c) => c.put(key, copy));
    }
    return res;
  } catch {
    const hit = await caches.match(key);
    if (hit) return hit;
    throw new Error("offline, not cached: " + req.url);
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // ניווטים והשלד: רשת קודם, ובנפילה — מהקאש.
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, "./index.html"));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req, req));
  }
});
