# The WASM miner is built from C sources, so the image needs emscripten once.
FROM emscripten/emsdk:4.0.7 AS wasm
WORKDIR /build
RUN git clone --depth 1 https://github.com/litecoincash-project/cpuminer-multi.git vendor/cpuminer-multi
COPY wasm ./wasm
RUN ./wasm/build.sh

FROM oven/bun:1 AS web
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY vite.config.ts ./
COPY web ./web
COPY --from=wasm /build/web/public/ ./web/public/
RUN bun run build:web

FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production
COPY src ./src
COPY --from=web /app/web/dist ./web/dist
RUN mkdir -p data
EXPOSE 3000
CMD ["bun", "src/server.ts"]
