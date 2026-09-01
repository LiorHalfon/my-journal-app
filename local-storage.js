/* יומן — localStorage שלא מפיל את האפליקציה.
   בגלישה פרטית ובחסימת אחסון הגישה זורקת. כאן היא פשוט לא מצליחה. */

export function readLocal(key, fallback = "") {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function writeLocal(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* אין אחסון — אפשר להמשיך בלי לזכור. */
  }
}

export function clearLocal(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* כנ"ל. */
  }
}
