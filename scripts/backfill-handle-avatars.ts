// One-off: fills in the X avatar for @handle listings that predate this feature.
// New listings get this automatically at creation (see server/src/avatar.ts) - this
// just catches up the backlog. Safe to re-run: `icon IS NULL` skips anything already set.
//
// Usage: bun --env-file=.env scripts/backfill-handle-avatars.ts
// Needs AVATAR_PROXY_ORIGIN set, same as the live feature.
import { db } from "../packages/server/src/db";
import { fetchHandleAvatar } from "../packages/server/src/avatar";
import { setHandleAvatar } from "../packages/server/src/listings";

const rows = db.query<{ id: string; target: string }, []>(
  `SELECT id, target FROM listings WHERE kind = 'handle' AND icon IS NULL`,
).all();

console.log(`${rows.length} handle listing(s) without an icon`);

for (const { id, target } of rows) {
  const icon = await fetchHandleAvatar(target);
  if (icon) {
    setHandleAvatar(id, icon);
    console.log(`  @${target}: set`);
  } else {
    console.log(`  @${target}: no avatar (skipped - rerun later to retry)`);
  }
  await Bun.sleep(250); // don't burst a service capped at 25 req/day
}
