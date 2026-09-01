/* יומן — service worker
   מטרה: האפליקציה נפתחת ועובדת בלי רשת. הרשומות עצמן ב-IndexedDB,
   כאן רק שלד האפליקציה והפונטים. */

const VERSION = "v2";
const SHELL = "journal-shell-" + VERSION;
const FONTS = "journal-fonts-" + VERSION;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
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
        keys.filter((k) => k !== SHELL && k !== FONTS).map((k) => caches.delete(k))
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

  // אף פעם לא לשמור בקאש קריאות מול גוגל — טוקנים ונתוני דרייב חייבים להיות טריים.
  if (
    url.hostname.endsWith("googleapis.com") ||
    url.hostname === "accounts.google.com"
  ) return;

  // פונטים: מהקאש קודם, ורענון ברקע.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(
      caches.open(FONTS).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req)
          .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
          .catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // ניווטים והשלד: רשת קודם, ובנפילה — מהקאש.
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, "./index.html"));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req, req));
  }
});
