import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ErrorCode } from "./error-codes";

/**
 * `ErrorCode` is a PUBLIC, one-way surface: clients (the console, the
 * playground, third parties) branch on these strings, so a rename or removal
 * is a breaking change and an addition is a permanent name. This spec makes
 * that mechanical (#182):
 *
 *  - the shipped set is pinned by SET-EQUALITY, not superset — adding a code
 *    without appending it to SHIPPED below fails too, so every new public
 *    name is a deliberate, reviewed diff line;
 *  - every value equals its key;
 *  - every value is SCREAMING_SNAKE, so it can never collide with a
 *    registry's lowercase RFC-ACDP-0007 §5.1 `error.code` (the console keys
 *    on exact match across both vocabularies).
 */
const SHIPPED: readonly string[] = [
  "RUN_NOT_FOUND",
  "REGISTRY_NOT_FOUND",
  "AGENT_NOT_FOUND",
  "CONTEXT_NOT_FOUND",
  "FEDERATION_UPSTREAM_RATE_LIMITED",
  "CONTEXT_ID_MISMATCH",
  "CONTEXT_BINDING_UNVERIFIABLE",
  "INVALID_PAYLOAD",
  "INVALID_SIGNATURE",
  "INVALID_LOG_PROOF",
  "INVALID_WITNESS_COSIGNATURE",
  "VALIDATION_ERROR",
  "INTERNAL_ERROR",
  // #182 Phase 1 — generic status-keyed fallbacks.
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "REQUEST_REJECTED",
  // #182 Phase 2 — authorization / tenancy 403s.
  "ADMIN_REQUIRED",
  "TENANT_RESERVED",
  "TENANT_MISMATCH",
  "TENANT_REQUIRED",
  // #182 Phase 3 — credentials, ingest gating, policy, quota.
  "INVALID_WEBHOOK_SIGNATURE",
  "REGISTRY_DISABLED",
  "ISSUER_READ_ONLY",
  "REGISTRY_NOT_ENROLLED",
  "POLICY_DENIED",
  "QUOTA_EXCEEDED",
  // #200 — federation proxy upstream failure (502).
  "FEDERATION_UPSTREAM_ERROR",
  // #192 — the shutdown drain gate (503).
  "SERVICE_DRAINING",
  // #210 — /readyz: a required backing dependency is down (503).
  "DEPENDENCY_UNAVAILABLE",
];

describe("ErrorCode public surface", () => {
  const values = Object.values(ErrorCode) as string[];

  it("set-equals the shipped list (no silent rename, removal, or addition)", () => {
    expect([...values].sort()).toEqual([...SHIPPED].sort());
    expect(new Set(SHIPPED).size).toBe(SHIPPED.length);
  });

  it("every value equals its key", () => {
    for (const [k, v] of Object.entries(ErrorCode)) {
      expect(v).toBe(k);
    }
  });

  it("every code has a row in the docs/API.md error-code table", () => {
    const doc = readFileSync(
      resolve(__dirname, "..", "..", "docs", "API.md"),
      "utf8",
    );
    for (const v of values) {
      expect({ code: v, inTable: new RegExp("^\\| `" + v + "` \\|", "m").test(doc) })
        .toEqual({ code: v, inTable: true });
    }
  });

  it("every value is SCREAMING_SNAKE (never collides with RFC lowercase codes)", () => {
    for (const v of values) {
      expect(v).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
