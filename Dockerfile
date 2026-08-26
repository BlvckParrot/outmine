# The WASM miner is built from C sources, so the image needs emscripten once.
FROM emscripten/emsdk:4.0.7 AS wasm
WORKDIR /build/packages/wasm
# No clone and no fetch. The upstream sources are submodules of this repository, pinned
# by the commits it records, and they arrive in the build context - so the same commit
# produces the same miner, and a change upstream has to be a gitlink change somebody
# reviewed. That means the build context must actually carry them: `actions/checkout`
# needs `submodules: recursive`, and a local `docker build` needs them checked out.
# build.sh fails with the command to run rather than compiling against empty directories.
COPY packages/wasm ./
RUN ./build.sh

FROM oven/bun:1 AS web
WORKDIR /app
# Workspace manifests first so the dependency layer caches independently of sources.
COPY package.json bun.lock* tsconfig.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/wasm/package.json ./packages/wasm/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
# No `|| bun install` fallback: that turned a lockfile that no longer matches - the
# one signal that a dependency moved - into a silent re-resolve.
RUN bun install --frozen-lockfile
COPY packages/protocol ./packages/protocol
COPY packages/wasm ./packages/wasm
COPY packages/web ./packages/web
COPY --from=wasm /build/packages/web/public/ ./packages/web/public/
RUN bun --filter @outmine/web build

FROM oven/bun:1
WORKDIR /app
# Every workspace in the lockfile must exist on disk, even ones this stage does not
# install from, or bun install refuses to resolve.
COPY package.json bun.lock* ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/wasm/package.json ./packages/wasm/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
RUN bun install --production --frozen-lockfile
COPY packages/protocol ./packages/protocol
COPY packages/server ./packages/server
# scripts/backup.ts runs inside this container, spawned by the server itself on
# BACKUP_CRON. Without this COPY the path does not exist and the nightly backup fails
# every night with ENOENT - which is exactly what happened while it was a crontab line
# on the host that only the README knew about.
COPY scripts ./scripts
# Laid out as in the repo so the server's default WEB_DIST (../../web/dist relative to
# its own source) resolves without configuration.
COPY --from=web /app/packages/web/dist ./packages/web/dist

# The database and the backups are the only things the process writes, so they are the
# only things it owns. Everything else stays root-owned and read-only to the app.
# Separate directories so they can be separate mounts: a backup on the same volume as
# the database survives a bad DELETE and not much else.
RUN mkdir -p data backups && chown bun:bun data backups
USER bun

EXPOSE 3000
CMD ["bun", "packages/server/src/server.ts"]
