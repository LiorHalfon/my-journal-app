/* יומן — המפתח, קוד השחזור והקובץ החתום.
   מודול טהור: רק crypto, TextEncoder, TextDecoder, btoa ו-atob, כדי שירוץ
   כמו שהוא בדף, ב-service worker וב-Node. */

const APP_ID = "tiny-journal";
const SEALED_VERSION = 1;

/* Crockford base32: בלי I, L, O, U */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_BYTES = 32;
const DATA_CHARS = 52; // 256 סיביות + 4 סיביות ריפוד באפס
const CHECK_CHARS = 4; // 20 הסיביות הראשונות של SHA-256
const IV_BYTES = 12;

/** כשל בהצפנה או בקוד. ה-kind הוא מה שקובע את ההודעה למשתמש. */
export class VaultError extends Error {
  constructor(kind) {
    super(`vault ${kind}`);
    this.name = "VaultError";
    this.kind = kind;
  }
}

/* ================= מפתח וקוד שחזור ================= */

/** 32 בתים אקראיים. הבתים האלה לא נשמרים לשום מקום, רק הקוד והמפתח המיובא. */
export function newKeyBytes() {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** base32 מהסיבית הגבוהה לנמוכה. סיביות חסרות בתו האחרון מרופדות באפס. */
function encodeBase32(bytes) {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** סכום הביקורת: 4 התווים הראשונים בקידוד של ה-hash. */
async function checksum(bytes) {
  return encodeBase32((await sha256(bytes)).slice(0, 3)).slice(0, CHECK_CHARS);
}

/** 14 קבוצות של 4 תווים, מופרדות במקף. */
export async function toRecoveryCode(bytes) {
  const flat = encodeBase32(bytes) + (await checksum(bytes));
  return flat.match(/.{4}/g).join("-");
}

/** מחזיר את 32 הבתים, או null אם הקוד לא תקין. סלחני להקלדה ביד. */
export async function fromRecoveryCode(code) {
  const flat = String(code)
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replaceAll("O", "0")
    .replace(/[IL]/g, "1");
  if (flat.length !== DATA_CHARS + CHECK_CHARS) return null;

  const bytes = new Uint8Array(KEY_BYTES);
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const char of flat.slice(0, DATA_CHARS)) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) return null;
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes[at++] = (acc >> (bits - 8)) & 255;
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) return null; // סיביות הריפוד חייבות להיות אפס

  const given = flat.slice(DATA_CHARS);
  if ([...given].some((char) => !ALPHABET.includes(char))) return null;
  return given === (await checksum(bytes)) ? bytes : null;
}

/** 4 הבתים הראשונים של ה-hash, כ-hex קטן. נכתב בכל קובץ חתום. */
export async function keyId(bytes) {
  const head = (await sha256(bytes)).slice(0, 4);
  return [...head].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** מפתח AES-GCM שאי אפשר לייצא. מי שקורא לזה מאפס את הבתים מיד אחריו. */
export function importKey(bytes) {
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/* ================= הקובץ החתום ================= */

/** base64 דרך מחרוזת בינארית, בנתחים כדי שיומן גדול לא יפיל את ה-stack. */
function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** המעטפה: JSON עם כל השדות שהאפליקציה צריכה כדי לדעת איך לפתוח. */
export async function seal(key, kid, text) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(text)
  );
  return JSON.stringify({
    app: APP_ID,
    sealed: SEALED_VERSION,
    kid,
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(data)),
  });
}

function parseEnvelope(text) {
  try {
    const env = JSON.parse(text);
    const ok =
      env &&
      typeof env === "object" &&
      env.app === APP_ID &&
      env.sealed === SEALED_VERSION &&
      typeof env.kid === "string" &&
      typeof env.iv === "string" &&
      typeof env.data === "string";
    return ok ? env : null;
  } catch {
    return null;
  }
}

/** האם זה קובץ חתום, להבדיל מגיבוי רגיל או מזבל. */
export function isSealed(text) {
  return parseEnvelope(text) !== null;
}

/** פותח מעטפה. kid אחר זה wrong-key, וכל כשל אחר בפענוח זה corrupt. */
export async function unseal(key, kid, sealed) {
  const env = parseEnvelope(sealed);
  if (!env) throw new VaultError("corrupt");
  if (env.kid !== kid) throw new VaultError("wrong-key");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(env.iv) },
      key,
      fromBase64(env.data)
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new VaultError("corrupt");
  }
}

/* ================= הודעות ================= */

/** מתרגם כשל להודעה שאפשר לפעול לפיה. */
export function describeVaultError(error) {
  const kind = error && error.kind;

  if (kind === "no-key") return "צריך קודם מפתח הצפנה.";
  if (kind === "bad-code") return "הקוד לא תקין. בדוק שהעתקת את כולו.";
  if (kind === "wrong-key")
    return "הקובץ הוצפן במפתח אחר. הזן את קוד השחזור שלו.";
  if (kind === "corrupt") return "הקובץ פגום או שונה, ולכן לא נפתח.";

  return "הפעולה מול ההצפנה נכשלה.";
}
