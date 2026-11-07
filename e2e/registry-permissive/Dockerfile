# syntax=docker/dockerfile:1
#
# E2E-only build of acdp-registry-rs that permits `http://` webhook URLs.
#
# The upstream registry uses `SsrfPolicy::default()` to validate webhook URLs,
# which forbids `http://` (HTTPS-only) and IP literals. That's the right
# production stance, but the local E2E stack needs the registry to POST to
# `http://playground:8000/webhooks/acdp` — a Docker-internal hostname.
#
# This Dockerfile applies two E2E-only seds:
#
#   1. `SsrfPolicy::default()` → struct-literal-with-allow_http at the
#      line-leading call sites (startup config check in
#      crates/acdp-registry-server/src/main.rs, emitter `try_spawn` check in
#      crates/acdp-registry-webhook/src/lib.rs). This only lets the URL pass
#      validation.
#   2. The webhook DELIVERY client (`worker()` in
#      crates/acdp-registry-webhook/src/lib.rs) is built by
#      `acdp::safe_http::safe_client(&policy, …)` with the STRICT default
#      policy (`try_spawn` → `spawn` → `spawn_with_policy(default)`), which
#      refuses `http://` and filters every resolved IP — and the
#      Docker-network address `playground` resolves to (172.x, RFC 1918) is
#      refused by every `SsrfPolicy` setting. So the E2E build swaps that one
#      client for a plain `reqwest` client. Without (2) the registry accepts
#      the config, then silently fails every delivery and the control plane
#      never sees an event.
#
# Each sed is followed by a `grep -q` on the patched text, so when upstream
# moves a call site the build FAILS here instead of producing a registry that
# boots but never delivers.
#
# We DO NOT use cargo-chef here. Earlier attempts that did, paired with sed,
# produced a 332KB stub binary: chef cooked the workspace crates against the
# (patched) sources during the cook step, then the final `cargo build` saw
# no source change and link-only-built. Skipping chef costs us dep-cache
# reuse but guarantees the patched source actually compiles into the final
# binary. First build: ~5–10 min; subsequent runs reuse the BuildKit layer.
#
# The registry's other outbound HTTP clients (DID resolution, federation)
# keep the strict `acdp::safe_http` guard — only the webhook URL check and
# the webhook delivery client are relaxed, and only in this E2E image.
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
 && sed -i 's|acdp::safe_http::safe_client(&policy, Duration::from_secs(config.timeout_seconds))|({ let _ = \&policy; reqwest::Client::builder().timeout(Duration::from_secs(config.timeout_seconds)).build() })|' \
        /workspace/acdp-registry-rs/crates/acdp-registry-webhook/src/lib.rs \
 && echo "── patched call sites ──" \
 && grep -n "SsrfPolicy {\|reqwest::Client::builder()" \
        /workspace/acdp-registry-rs/crates/acdp-registry-server/src/main.rs \
        /workspace/acdp-registry-rs/crates/acdp-registry-webhook/src/lib.rs \
 && grep -q "SsrfPolicy { allow_http: true" /workspace/acdp-registry-rs/crates/acdp-registry-server/src/main.rs \
 && grep -q "SsrfPolicy { allow_http: true" /workspace/acdp-registry-rs/crates/acdp-registry-webhook/src/lib.rs \
 && grep -q "let _ = &policy; reqwest::Client::builder()" /workspace/acdp-registry-rs/crates/acdp-registry-webhook/src/lib.rs \
 || { echo "e2e SSRF patch no longer matches acdp-registry-rs — update e2e/registry-permissive/Dockerfile" >&2; exit 1; }

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
