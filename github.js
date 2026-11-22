/* יומן — לקוח GitHub לקובץ הגיבוי המוצפן.
   חסר מצב ותלוי רק ב-fetch וב-navigator.onLine, כדי שיעבוד גם בדף וגם
   ב-service worker. הטוקן עובר רק בכותרת Authorization ולא נכתב לשום מקום. */

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

/* קובץ של 1 עד 100 MB נענה רק בסוגי המדיה raw ו-object. ברירת המחדל עונה עליו 403. */
const JSON_TYPE = "application/vnd.github+json";
const OBJECT_TYPE = "application/vnd.github.object+json";
const RAW_TYPE = "application/vnd.github.raw+json";

/* בקשה שנתקעה מחזיקה את ה-Web Lock, ואיתו כל גיבוי, שחזור ושמירת מאגר. אחרי דקה מוותרים. */
const TIMEOUT_MS = 60000;

export const FILE_PATH = "journal.sealed.json";

const COMMIT_MESSAGE = "backup";
const VERSIONS_LIMIT = 30;

/** כשל מול GitHub. ה-kind הוא מה שקובע את ההודעה למשתמש. */
export class GithubError extends Error {
  constructor(kind, status) {
    super(status ? `github ${kind} ${status}` : `github ${kind}`);
    this.name = "GithubError";
    this.kind = kind;
    this.status = status;
  }
}

const MESSAGES = {
  "bad-repo": "כתוב את המאגר בצורה owner/repo.",
  public: "המאגר ציבורי. הגיבוי נשמר רק במאגר פרטי.",
  offline: "אין חיבור לרשת. הרשומות שמורות במכשיר, והגיבוי יעלה כשהרשת תחזור.",
  auth: "הטוקן לא תקף או שפג. צור טוקן חדש והדבק אותו ב“מאגר GitHub”.",
  denied: "לטוקן אין הרשאת כתיבה למאגר הזה.",
  missing: "המאגר לא נמצא, או שלטוקן אין גישה אליו.",
  busy: "GitHub לא זמין כרגע. הרשומות שמורות במכשיר — נסה שוב בעוד רגע.",
};

/** ההודעה בעברית. conflict נבלע בגיבוי עצמו ולכן מקבל את הטקסט הכללי. */
export function describeGithubError(error) {
  if (error.kind === "http") return `GitHub החזיר שגיאה ${error.status}.`;
  return MESSAGES[error.kind] ?? "הגיבוי נכשל.";
}

/** "owner/name" מתוך טקסט שהודבק או כתובת GitHub, או "" אם אין התאמה. */
export function parseRepo(raw) {
  const cleaned = String(raw)
    .trim()
    .replace(/^(https:\/\/)?github\.com\//, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(cleaned) ? cleaned : "";
}

/** הבדיקה בלי בקשה: אין רשת, אין טעם לנסות. */
function assertOnline() {
  if (globalThis.navigator?.onLine === false) throw new GithubError("offline");
}

function kindForStatus(status, method, headers) {
  if (method === "PUT" && (status === 409 || status === 422)) return "conflict";
  if (status === 401) return "auth";
  if (status === 403) return headers.get("x-ratelimit-remaining") === "0" ? "busy" : "denied";
  if (status === 404) return "missing";
  if (status === 429 || status >= 500) return "busy";
  return "http";
}

/** חריגה מהזמן נחשבת כמו GitHub עמוס: יש רשת, וניסיון מאוחר יותר יכול להצליח. */
const timedOut = (error) => error?.name === "TimeoutError" || error?.name === "AbortError";

/** בקשה אחת. מחזירה את גוף התשובה, JSON או טקסט, או זורקת GithubError.
    הזמן הקצוב חל גם על קריאת הגוף, כך שגם הורדה שנתקעה באמצע משחררת את הנעילה. */
async function request(account, method, path, { body, accept = JSON_TYPE, text = false } = {}) {
  assertOnline();
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      cache: "no-store", // GitHub מחזיר Cache-Control של דקה, וגרסה ישנה תשבש ניסיון חוזר
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${account.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": API_VERSION,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
    });
  } catch (error) {
    throw new GithubError(timedOut(error) ? "busy" : "offline");
  }
  if (!response.ok) {
    throw new GithubError(kindForStatus(response.status, method, response.headers), response.status);
  }
  try {
    return await (text ? response.text() : response.json());
  } catch (error) {
    if (timedOut(error)) throw new GithubError("busy");
    throw error;
  }
}

const contentsPath = (account) => `/repos/${account.repo}/contents/${FILE_PATH}`;

/** המאגר קיים, הטוקן תקף, והמאגר פרטי. */
export async function checkAccount(account) {
  const repo = await request(account, "GET", `/repos/${account.repo}`);
  if (repo.private !== true) throw new GithubError("public");
}

/** ה-sha של הקובץ במאגר, או null אם עוד אין קובץ.
    סוג המדיה object: הוא מחזיר sha גם לקובץ מעל 1 MB, שעליו ברירת המחדל עונה 403. */
export async function currentSha(account) {
  try {
    return (await request(account, "GET", contentsPath(account), { accept: OBJECT_TYPE })).sha;
  } catch (error) {
    if (error.kind === "missing") return null;
    throw error;
  }
}

/** מעלה גרסה חדשה. sha הוא של הגרסה שמעליה בונים, או null ליצירה. */
export async function upload(account, text, sha) {
  const body = JSON.stringify({
    message: COMMIT_MESSAGE,
    content: btoa(text), // המעטפה היא ASCII
    ...(sha ? { sha } : {}),
  });
  return (await request(account, "PUT", contentsPath(account), { body })).content.sha;
}

/** הגרסאות מהחדשה לישנה, עד 30. */
export async function listVersions(account) {
  const path = `/repos/${account.repo}/commits?path=${FILE_PATH}&per_page=${VERSIONS_LIMIT}`;
  let commits;
  try {
    commits = await request(account, "GET", path);
  } catch (error) {
    /* מאגר ריק לגמרי, בלי אף commit: GitHub עונה 409 "Git Repository is empty". */
    if (error.status === 409) return [];
    throw error;
  }
  return commits.map((item) => ({ commit: item.sha, at: item.commit.committer.date }));
}

/** הטקסט של הקובץ, בגרסה האחרונה או בגרסה של commit מסוים. */
export async function download(account, commit) {
  const ref = commit ? `?ref=${encodeURIComponent(commit)}` : "";
  return request(account, "GET", contentsPath(account) + ref, { accept: RAW_TYPE, text: true });
}
