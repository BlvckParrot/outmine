import { config } from "./config";
import { checkedIcon } from "./listings";

const FETCH_TIMEOUT_MS = 5_000;
// A real X avatar can be a few hundred KB, well over listings.checkedIcon's default
// 64 KiB upload ceiling (tuned for the manual-upload UX, not a fetched photo), and its
// pixel dimensions are never pre-shrunk client-side the way a manual upload's are -
// unavatar.io has been seen serving 200x200, X itself goes up to a few hundred more.
// Both ceilings are still bounded, just sized for a real photo instead of a canvas
// export capped at ICON_MAX_PX.
const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_AVATAR_PIXELS = 2048 ** 2;

/** The X/Twitter avatar for a handle, resized and re-encoded exactly like an uploaded
 *  icon - or null for anything short of success. Best-effort on purpose: a listing is
 *  worth creating whether or not this works, so every failure here is silent.
 *
 *  `proxyOrigin` defaults to config so production needs no argument; tests pass one
 *  explicitly rather than depending on env read at module-import time.
 *
 *  ponytail: unavatar.io's public tier caps anonymous use at 25 requests/day per IP,
 *  shared by the whole server. Fine at this board's size; a paid token or a self-hosted
 *  unavatar instance is the upgrade if @handle listings start outpacing that. */
export async function fetchHandleAvatar(
  handle: string,
  proxyOrigin = config.avatar.proxyOrigin,
): Promise<Uint8Array | null> {
  if (!proxyOrigin) return null;
  try {
    // fallback=false: without it, unavatar.io hands back a generic placeholder for a
    // handle it can't resolve, and we would happily store that as if it were real.
    const res = await fetch(`${proxyOrigin}/x/${handle}?fallback=false`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return await checkedIcon(bytes, { maxBytes: MAX_AVATAR_BYTES, maxPixels: MAX_AVATAR_PIXELS });
  } catch {
    return null;
  }
}
