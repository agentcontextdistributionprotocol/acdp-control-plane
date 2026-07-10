# syntax=docker/dockerfile:1
#
# The control plane depends on the published `acdp` npm package (the NAPI
# binding over `acdp-rs`) for ALL Ed25519 / ECDSA-P256 verification, JCS
# canonicalization, SSRF classification, and did:web parsing. `npm ci`
# fetches the right prebuilt `.node` for the image's platform via the
# package's optionalDependencies — no Rust toolchain in the build.
#
# NOTE: a glibc base (bookworm-slim) is required — the prebuilt triples
# are `*-unknown-linux-gnu`, not musl, so alpine cannot load them.

# ── Stage 1: build the control plane ─────────────────────────────────────
FROM node:26-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json nest-cli.json ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle

EXPOSE 3001
CMD ["node", "dist/main.js"]
