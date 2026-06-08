# syntax=docker/dockerfile:1
#
# E2E-only build of acdp-registry-rs that permits `http://` webhook URLs.
#
# The upstream registry uses `SsrfPolicy::default()` to validate webhook URLs,
# which forbids `http://` (HTTPS-only) and IP literals. That's the right
# production stance, but the local E2E stack needs the registry to POST to
# `http://playground:8000/webhooks/acdp` — a Docker-internal hostname.
#
# This Dockerfile seds `SsrfPolicy::default()` → struct-literal-with-allow_http
# at the two webhook call sites:
#
#   crates/acdp-registry-server/src/main.rs:82  (startup config check)
#   crates/acdp-registry-webhook/src/lib.rs:53  (emitter spawn check)
#
# We DO NOT use cargo-chef here. Earlier attempts that did, paired with sed,
# produced a 332KB stub binary: chef cooked the workspace crates against the
# (patched) sources during the cook step, then the final `cargo build` saw
# no source change and link-only-built. Skipping chef costs us dep-cache
# reuse but guarantees the patched source actually compiles into the final
# binary. First build: ~5–10 min; subsequent runs reuse the BuildKit layer.
#
# The runtime SSRF guard in `acdp::safe_http` for *outbound HTTP clients* is
# unaffected — only the webhook URL validation is relaxed.
#
# Build context: the parent of acdp-registry-rs/acdp-rs (i.e. the
# `agentcontextdistributionprotocol/` directory). docker-compose.e2e.yml sets
# the `context:` to `../..` and the `dockerfile:` to this file's path.

FROM rust:1.88-bookworm AS builder
ARG STORAGE_FEATURE=storage-sqlite

WORKDIR /workspace
COPY ./acdp-rs            /workspace/acdp-rs
COPY ./acdp-registry-rs   /workspace/acdp-registry-rs

# ── SSRF patch ────────────────────────────────────────────────────────
# Anchor to start-of-line + leading whitespace so the doc-comment line
# (`/// (`...`)`) is not matched. Print the result for build-time audit.
RUN sed -i 's|^\([[:space:]]*\)acdp::safe_http::SsrfPolicy::default()|\1acdp::safe_http::SsrfPolicy { allow_http: true, reject_ip_literals: true, allow_loopback_resolved: false }|' \
        /workspace/acdp-registry-rs/crates/acdp-registry-server/src/main.rs \
        /workspace/acdp-registry-rs/crates/acdp-registry-webhook/src/lib.rs \
 && echo "── patched call sites ──" \
 && grep -n "SsrfPolicy {" \
        /workspace/acdp-registry-rs/crates/acdp-registry-server/src/main.rs \
        /workspace/acdp-registry-rs/crates/acdp-registry-webhook/src/lib.rs

WORKDIR /workspace/acdp-registry-rs
RUN cargo build --release \
        --no-default-features --features "${STORAGE_FEATURE}" \
        -p acdp-registry-server
RUN strip /workspace/acdp-registry-rs/target/release/acdp-registry

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 1001 --home /app acdp
COPY --from=builder /workspace/acdp-registry-rs/target/release/acdp-registry /usr/local/bin/acdp-registry
USER acdp
WORKDIR /app
EXPOSE 8100 8200
ENTRYPOINT ["/usr/local/bin/acdp-registry"]
