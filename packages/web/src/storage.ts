// What the browser remembers between visits.
//
// localStorage throws rather than returning null in a few real situations - Safari
// private browsing, storage disabled by policy, quota exhausted - and a throw here
// would take the whole page down before it painted. Every access is guarded.

/** Bumping this invalidates every stored consent, which is the only way to ask
 *  again after the terms of what we mine, or how much, have changed. */
const CONSENT_VERSION = "1";

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* nothing to do: the site works without memory, it just asks again */
  }
};

export const hasConsented = () => read("outmine:consent") === CONSENT_VERSION;
export const rememberConsent = () => write("outmine:consent", CONSENT_VERSION);

/** The listing this browser mined for last. Only ever used to offer a button - see
 *  the comment at the call site for why it never starts mining by itself. */
export const lastListing = () => read("outmine:listing");
export const rememberListing = (id: string | null) => write("outmine:listing", id);

/** Light or dark. The same key is read by the inline script in index.html, which has
 *  to run before React does or a stored dark theme flashes white on every load. */
export type Theme = "light" | "dark";
export const storedTheme = (): Theme => (read("outmine:theme") === "dark" ? "dark" : "light");
export const rememberTheme = (theme: Theme) => write("outmine:theme", theme);

/** A listing created in this browser, with the edit token handed back when it was
 *  created. The API prints that token exactly once and stores only its hash, so if it
 *  is not kept here it is gone for good and nothing can prove the listing is yours. */
export type Owned = { id: string; token: string };

const isOwned = (value: unknown): value is Owned =>
  typeof value === "object" && value !== null &&
  typeof (value as Owned).id === "string" && typeof (value as Owned).token === "string";

export const ownedListings = (): Owned[] => {
  try {
    const parsed: unknown = JSON.parse(read("outmine:owned") ?? "[]");
    // Every element checked, not just the array itself. `[null]` satisfied Array.isArray
    // and then reached `o.id` during render - and with no error boundary above it that
    // is a permanently blank site, because localStorage survives the reload.
    return Array.isArray(parsed) ? parsed.filter(isOwned) : [];
  } catch {
    return []; // hand-edited or written by an older shape: start over rather than throw
  }
};

export const rememberOwned = (owned: Owned) =>
  write("outmine:owned", JSON.stringify([owned, ...ownedListings().filter((o) => o.id !== owned.id)]));

export const forgetOwned = (id: string) =>
  write("outmine:owned", JSON.stringify(ownedListings().filter((o) => o.id !== id)));
