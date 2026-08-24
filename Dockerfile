# The WASM miner is built from C sources, so the image needs emscripten once.
FROM emscripten/emsdk:4.0.7 AS wasm
WORKDIR /build/packages/wasm
RUN git clone --depth 1 https://github.com/litecoincash-project/cpuminer-multi.git vendor/cpuminer-multi
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
RUN bun install --frozen-lockfile || bun install
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
RUN bun install --production --frozen-lockfile || bun install --production
COPY packages/protocol ./packages/protocol
COPY packages/server ./packages/server
# Laid out as in the repo so the server's default WEB_DIST (../../web/dist relative to
# its own source) resolves without configuration.
COPY --from=web /app/packages/web/dist ./packages/web/dist
RUN mkdir -p data
EXPOSE 3000
CMD ["bun", "packages/server/src/server.ts"]
