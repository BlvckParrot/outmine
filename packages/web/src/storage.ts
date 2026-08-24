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
