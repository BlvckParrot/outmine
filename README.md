<div align="center">

# outmine

**A leaderboard you cannot buy. Rank is paid in CPU time.**

### [outmine.lol](https://outmine.lol)

[![licence: GPL-2.0](https://img.shields.io/badge/licence-GPL--2.0-2f6f4e)](LICENSE)
[![image](https://github.com/BlvckParrot/outmine/actions/workflows/image.yml/badge.svg)](https://github.com/BlvckParrot/outmine/actions/workflows/image.yml)
[![runtime: Bun](https://img.shields.io/badge/runtime-Bun%201.4-b8860b)](https://bun.sh)

<img src="docs/board.png" width="900" alt="The outmine board: the price of first place, a field to claim a spot, trending and activity side by side, then the top three as cards">

</div>

Live at **[outmine.lol](https://outmine.lol)**. Same shape as
[outbid.lol](https://outbid.lol) — one board, listings competing for the top slot — except
the currency is browser mining, and the proceeds go to whoever runs the site.

No accounts. A visitor picks a listing and mines for it, exactly as an outbid.lol visitor
pays for someone's position. That also kills sybil farming on its own: fifty tabs means
fifty times the real work.

## How it works

- **Claim a spot.** Any domain or `@handle`. Free, no sign-up.
- **Mine for it.** The browser hashes in a WebAssembly worker while the tab is open.
- **Shares are the score.** Every share the pool accepts moves that listing up the board.

A new listing does not reach the board until enough shares have been mined for it. That is
the entire spam filter: a spammer pays in the same currency everyone else competes in.
Until then it sits in "waiting for hashes" with a progress bar — a gate that hid listings
from the very people who would mine them onto the board would be a wall.

## Nothing mines unless you ask

A banner is the first thing on the page, and it says what this is in one line: this site
mines cryptocurrency with your CPU, the proceeds go to the site owner, it will drain a battery.

Accepting it is not the same as starting. **A stored consent still does not start the CPU.**
A returning visitor is not asked twice, but they still press a button before a single hash
is computed — `scripts/browser-check.ts` reloads with consent already stored and fails if
anything is mining afterwards.

While it runs there is a thread count and a throttle, both movable mid-run, and a stop
button. Mining only happens while the tab is open.

## Licence

[GPL-2.0](LICENSE), for the whole repository.

Not a preference. The miner is compiled from cpuminer-multi and cpuminer-opt-rin, and the
latter states plain version 2 with no "or later" clause, which fixes the licence for
everything built with it. Both are submodules under `packages/wasm/vendor`, pinned by
commit, so the corresponding source of any shipped `mine-*.wasm` is whatever
`git submodule status` names. Argon2's portable `ref.c` is vendored separately, with
[its provenance beside it](packages/wasm/argon2-ref/README.md). The bundled DM Sans and
JetBrains Mono are under the SIL Open Font License.
