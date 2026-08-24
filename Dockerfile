# The WASM miner is built from C sources, so the image needs emscripten once.
FROM emscripten/emsdk:4.0.7 AS wasm
WORKDIR /build/packages/wasm
# Cloned here rather than left to build.sh so the sources cache in their own layer,
# independent of the COPY below. build.sh skips a clone that is already present.
# Pinned by commit, and the loose file by digest. What is compiled here becomes the
# WebAssembly every visitor's browser runs, so "whatever those three refs point at on
# the day the image is built" is not a thing this project can afford to leave open: the
# same Dockerfile has to produce the same miner, and a change upstream has to be a
# change here that someone reviewed.
#
# These are the commits the unpinned build was already resolving to, so pinning them
# changes nothing about what is built today - it only fixes what is built tomorrow.
ARG CPUMINER_MULTI_SHA=5710e52b064d2077a53d3db3ae6b1a7febbec45b
ARG CPUMINER_RIN_SHA=d1d0784523479aa2379e00dd5750af619fb10db3
ARG ARGON2_SHA=f57e61e19229e23c4445b85494dbf7c07de721cb
ARG ARGON2_REF_C_SHA256=9ac347fd8dc737af69bbb93d56ac8b4ab5488152f606880c8d7fc4592e207647

RUN git clone --filter=blob:none https://github.com/litecoincash-project/cpuminer-multi.git vendor/cpuminer-multi \
 && git -C vendor/cpuminer-multi checkout --quiet "$CPUMINER_MULTI_SHA" \
 && git clone --filter=blob:none --sparse https://github.com/Rin-coin/cpuminer-opt-rin.git vendor/cpuminer-opt-rin \
 && git -C vendor/cpuminer-opt-rin sparse-checkout set algo/rinhash \
 && git -C vendor/cpuminer-opt-rin checkout --quiet "$CPUMINER_RIN_SHA" \
 && curl -sSfL -o vendor/cpuminer-opt-rin/algo/rinhash/argon2d/ref.c \
      "https://raw.githubusercontent.com/P-H-C/phc-winner-argon2/$ARGON2_SHA/src/ref.c" \
 && echo "$ARGON2_REF_C_SHA256  vendor/cpuminer-opt-rin/algo/rinhash/argon2d/ref.c" | sha256sum -c -
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
# Laid out as in the repo so the server's default WEB_DIST (../../web/dist relative to
# its own source) resolves without configuration.
COPY --from=web /app/packages/web/dist ./packages/web/dist

# The database lives here and is the only thing the process writes, so it is the only
# thing it owns. Everything else stays root-owned and read-only to the app.
RUN mkdir -p data && chown bun:bun data
USER bun

EXPOSE 3000
CMD ["bun", "packages/server/src/server.ts"]
