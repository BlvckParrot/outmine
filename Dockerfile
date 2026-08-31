# check=skip=FromPlatformFlagConstDisallowed
# The line above has to be the first in the file - a parser directive after a comment is
# read as a comment. It silences the warning about the constant --platform on the wasm
# stage: BuildKit assumes anyone writing one has misunderstood $BUILDPLATFORM, and this is
# the case the rule is not written for. emscripten/emsdk exists for exactly one
# architecture, so naming it is accurate and $BUILDPLATFORM is what breaks.

# The WASM miner is built from C sources, so the image needs emscripten once.
# Kept identical to the `container:` in .github/workflows/wasm.yml on purpose: that
# workflow is the only thing that checks the miner's output against known vectors, and
# if it ran a different emcc than this line, it would be checking a different miner than
# the one that ships - with nothing anywhere going red to say so.
#
# Pinned to amd64, which is not a preference but the only thing that exists: this tag is
# a bare image manifest rather than a manifest list, so there is no arm64 emsdk to pull.
# Without this line a build targeting arm64 fails here, and $BUILDPLATFORM would not save
# it either - that resolves to linux/arm64 on an Apple Silicon machine and fails the same
# way. Emulated on an arm64 builder, native on the x86 runner that actually ships images.
#
# It costs nothing to fix it here: what this stage emits is WebAssembly, which is the same
# bytes whatever compiled it, so only the runtime stage below follows the target.
FROM --platform=linux/amd64 emscripten/emsdk:4.0.7 AS wasm
WORKDIR /build/packages/wasm
# No clone and no fetch. The upstream sources are submodules of this repository, pinned
# by the commits it records, and they arrive in the build context - so the same commit
# produces the same miner, and a change upstream has to be a gitlink change somebody
# reviewed. That means the build context must actually carry them: `actions/checkout`
# needs `submodules: recursive`, and a local `docker build` needs them checked out.
# build.sh fails with the command to run rather than compiling against empty directories.
COPY packages/wasm ./
RUN ./build.sh

# Same patch as `bun-version` in both workflows, and the same in the final stage below.
# `oven/bun:1` meant CI checked one runtime and the host ran whatever the tag resolved to
# on build day. Four literals rather than one ARG: they move together about once a year,
# and a build argument would hide in the layer cache what a grep for the version finds.
#
# Also the build platform, for the same reason the wasm stage is: what leaves here is
# dist/, which is JavaScript and CSS and carries no architecture. Running Vite, rolldown
# and Tailwind's oxide binding natively rather than under emulation is the difference
# between seconds and minutes on a cross build, and the output is byte-identical.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.0 AS web
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

# The only stage that follows the *target* platform, and the reason the two above do not
# have to. Nothing is compiled here - `bun install --production` resolves prebuilt
# binaries, and @resvg/resvg-js is the one native package that matters - so this is cheap
# to build under emulation for an architecture the builder is not.
FROM oven/bun:1.4.0
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

# Documentation, not a binding: on a user-defined bridge network every port is already
# reachable between containers. PORT is what actually moves the server - see config.ts,
# and docker-compose.yml, which hands the same value to the edge Caddy.
EXPOSE 3000
CMD ["bun", "packages/server/src/server.ts"]
