/* יומן — פורמט קובץ הגיבוי.
   מקור אמת יחיד לכל מה שיוצא לדרייב או לקובץ מקומי, ולכל מה שנקרא בחזרה. */

const APP_ID = "tiny-journal";
const SCHEMA = 1;

export function serializeEntries(entries) {
  return JSON.stringify(
    {
      app: APP_ID,
      schema: SCHEMA,
      exportedAt: new Date().toISOString(),
      count: entries.length,
      entries,
    },
    null,
    2
  );
}

/** קורא קובץ גיבוי ומחזיר רשומות תקינות ומנורמלות.
    זורק אם זה לא קובץ גיבוי. מתעלם בשקט מרשומות פגומות בתוך קובץ תקין. */
export function readEntries(text) {
  const parsed = typeof text === "string" ? JSON.parse(text) : text;
  const entries = parsed && parsed.entries;
  if (!Array.isArray(entries)) throw new Error("not a journal backup file");
  return entries.filter(isUsable).map(normalize);
}

function isUsable(entry) {
  return Boolean(entry) && typeof entry.text === "string" && Boolean(entry.id);
}

/** משלים שדות שחסרים בקבצים ישנים או שנערכו ביד. */
function normalize(entry) {
  const createdAtMs =
    entry.createdAtMs || Date.parse(entry.createdAt) || Date.now();
  return {
    id: entry.id,
    text: entry.text,
    createdAt: entry.createdAt || new Date(createdAtMs).toISOString(),
    createdAtMs,
    updatedAtMs: entry.updatedAtMs,
  };
}

/** journal-2026-09-01T16-47-30Z.json */
export function timestampedFilename() {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
  return `journal-${stamp}.json`;
}
