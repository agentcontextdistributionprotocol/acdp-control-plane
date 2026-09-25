/**
 * `revocation-lineage.ts`'s own unit coverage, independent of the SDK/DID
 * machinery: `verifyMemberBody` is a plain injected stub here (see the
 * module's doc comment on why), so these tests prove the WALK's rules —
 * fetch discipline, fail-closed cases, the permanent-drop/transient-abort
 * asymmetry, and the fold over a lineage's surviving members — without
 * re-mocking `receipt-verify`/`revocation-verify`/DID resolution the way
 * `revocation-audit.service.spec.ts` does for the pipeline those rules feed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DidResolutionError } from '../auth/did-web/did-web-resolver.service';
import { FederationFetchError, FederationResponse } from '../contexts/safe-federation-client';
import { ParsedRevocation } from './revocation-verify';
import {
  classifyLineageFailure,
  LineageMemberVerdict,
  MAX_LINEAGE_WALKS,
  walkRevocationLineage,
} from './revocation-lineage';

const BASE_URL = 'https://reg.example';
const AUTHORITY = 'reg.example';
const LINEAGE = 'lin:sha256:' + 'a'.repeat(64);
const TENANT = 'default';

function revocation(overrides: Partial<ParsedRevocation> = {}): ParsedRevocation {
  return {
    revokedKeyFingerprint: 'sha256:' + 'b'.repeat(64),
    compromisedSince: '2026-05-01T00:00:00.000Z',
    reason: null,
    revokedKeyId: null,
    revokedKeyController: 'did:key:producer',
    publisher: 'did:key:producer',
    trustClass: 'producer_signed',
    ...overrides,
  };
}

function fullContext(ctxId: string, overrides: Record<string, unknown> = {}) {
  return {
    body: {
      ctx_id: ctxId,
      lineage_id: LINEAGE,
      origin_registry: AUTHORITY,
      type: 'key-revocation',
      content_hash: 'sha256:' + 'c'.repeat(64),
      agent_id: 'did:key:producer',
      ...overrides,
    },
    registry_state: { status: 'active' },
  };
}

/** Always verifies successfully with the same synthetic revocation, keyed by nothing — good enough when a test only cares about routing/fetch behavior. */
function alwaysVerified(rev: ParsedRevocation = revocation()) {
  return async (): Promise<LineageMemberVerdict> => ({ status: 'verified', revocation: rev });
}

describe('MAX_LINEAGE_WALKS', () => {
  // AC8's cap value, transcribed from the reference client
  // (acdp-client/src/revocation.rs:47) — enforcement itself is the SWEEP's
  // job (it alone knows how many distinct lineages it queued this pass), so
  // that behavior is covered in revocation-audit.service.spec.ts.
  it('is 100', () => {
    expect(MAX_LINEAGE_WALKS).toBe(100);
  });
});

describe('classifyLineageFailure', () => {
  // AC9: exhaustive over every member of both unions, by construction — a
  // ninth code added to either union must fail THIS test, not silently fall
  // through to a default.
  const FEDERATION_FETCH_CODES: FederationFetchError['code'][] = ['SSRF', 'FETCH', 'REDIRECT', 'BODY_TOO_LARGE'];
  const DID_RESOLUTION_CODES: DidResolutionError['code'][] = [
    'URL',
    'SSRF',
    'FETCH',
    'STATUS',
    'CONTENT_TYPE',
    'BODY_TOO_LARGE',
    'PARSE',
    'PICK',
  ];

  it.each([
    ['FETCH', 'transient'],
    ['BODY_TOO_LARGE', 'hard'],
    ['SSRF', 'permanent'],
    ['REDIRECT', 'permanent'],
  ] as const)('FederationFetchError %s classifies as %s', (code, expected) => {
    expect(classifyLineageFailure(new FederationFetchError(code, 'x'))).toBe(expected);
  });

  it('every FederationFetchError code is handled (no silent fallthrough)', () => {
    expect(FEDERATION_FETCH_CODES).toHaveLength(4);
    for (const code of FEDERATION_FETCH_CODES) {
      expect(() => classifyLineageFailure(new FederationFetchError(code, 'x'))).not.toThrow();
    }
  });

  it.each([
    ['FETCH', 'transient'],
    ['STATUS', 'transient'],
    ['BODY_TOO_LARGE', 'permanent'],
    ['CONTENT_TYPE', 'permanent'],
    ['URL', 'permanent'],
    ['SSRF', 'permanent'],
    ['PARSE', 'permanent'],
    ['PICK', 'permanent'],
  ] as const)('DidResolutionError %s classifies as %s', (code, expected) => {
    expect(classifyLineageFailure(new DidResolutionError(code, 'x'))).toBe(expected);
  });

  it('every DidResolutionError code is handled (no silent fallthrough)', () => {
    expect(DID_RESOLUTION_CODES).toHaveLength(8);
    for (const code of DID_RESOLUTION_CODES) {
      expect(() => classifyLineageFailure(new DidResolutionError(code, 'x'))).not.toThrow();
    }
  });

  it.each([500, 503, 429, 408])('HTTP status %d classifies as transient', (status) => {
    expect(classifyLineageFailure(status)).toBe('transient');
  });

  it.each([400, 403, 404, 410])('HTTP status %d classifies as permanent', (status) => {
    expect(classifyLineageFailure(status)).toBe('permanent');
  });
});

describe('walkRevocationLineage', () => {
  function deps(
    get: (url: string) => Promise<FederationResponse>,
    verifyMemberBody: (
      registryAuthority: string,
      tenantId: string,
      bodyJson: string,
      body: Record<string, unknown>,
    ) => Promise<LineageMemberVerdict> = alwaysVerified(),
  ) {
    return {
      federationClient: { get },
      verifyMemberBody,
      logger: { warn: jest.fn() },
    };
  }

  function params(overrides: Partial<Parameters<typeof walkRevocationLineage>[1]> = {}) {
    return {
      lineageId: LINEAGE,
      registryAuthority: AUTHORITY,
      baseUrl: BASE_URL,
      tenantId: TENANT,
      expectCtxId: 'ctx-1',
      ...overrides,
    };
  }

  // ── AC1 ──────────────────────────────────────────────────────────────
  it('issues GET /lineages/{lineage_id} and never /current', async () => {
    const calls: string[] = [];
    const d = deps(async (url) => {
      calls.push(url);
      return { status: 200, contentType: 'application/json', body: JSON.stringify([fullContext('ctx-1')]) };
    });
    await walkRevocationLineage(d, params());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`${BASE_URL}/lineages/${encodeURIComponent(LINEAGE)}`);
    expect(calls[0]).not.toContain('/current');
  });

  // ── AC2 ──────────────────────────────────────────────────────────────
  it('fails closed on an empty lineage response (HTTP 200 + []) — no fold, no partial success', async () => {
    const verify = jest.fn(alwaysVerified());
    const d = deps(async () => ({ status: 200, contentType: 'application/json', body: '[]' }), verify);
    const result = await walkRevocationLineage(d, params());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('empty');
      // AC4: a failure before the member loop starts reports all-zero, since no member was ever evaluated.
      expect(result.memberVerdictCounts).toEqual({ verified: 0, invalid: 0, unavailable: 0, unsupported: 0 });
    }
    expect(verify).not.toHaveBeenCalled();
  });

  // ── AC2b ─────────────────────────────────────────────────────────────
  it('fails closed when a non-empty response omits the ctx_id that named the walk', async () => {
    const d = deps(async () => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([fullContext('some-other-ctx')]),
    }));
    const result = await walkRevocationLineage(d, params({ expectCtxId: 'ctx-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('missing_named_ctx');
      // AC4: rejected before the member loop starts — all-zero.
      expect(result.memberVerdictCounts).toEqual({ verified: 0, invalid: 0, unavailable: 0, unsupported: 0 });
    }
  });

  // ── AC3 ──────────────────────────────────────────────────────────────
  it('drops a permanently-failing member with a warning; remaining members still fold', async () => {
    const bad = revocation({ compromisedSince: '2099-01-01T00:00:00.000Z' });
    const good = revocation({ compromisedSince: '2026-01-01T00:00:00.000Z' });
    const verify = jest.fn(async (_a: string, _b: string, _c: string, body: Record<string, unknown>): Promise<LineageMemberVerdict> => {
      if (body['ctx_id'] === 'ctx-1') return { status: 'invalid', reason: 'bad signature' };
      return { status: 'verified', revocation: good };
    });
    const d = deps(
      async () => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([fullContext('ctx-1'), fullContext('ctx-2')]),
      }),
      verify,
    );
    const result = await walkRevocationLineage(d, params({ expectCtxId: 'ctx-1' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members).toHaveLength(1);
      expect(result.members[0].ctxId).toBe('ctx-2');
      expect(result.members[0].revocation).toEqual(good);
      expect(result.memberVerdictCounts).toEqual({ verified: 1, invalid: 1, unavailable: 0, unsupported: 0 });
    }
    expect(d.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ctx-1'));
    void bad;
  });

  // ── issue #170: 'unsupported' drops like 'invalid', never aborts like 'unavailable' ──
  it(
    'a member verifying as unsupported (capability gap, e.g. ecdsa-p256) is dropped with a ' +
      'warning; the walk does NOT abort — unlike unavailable, and unlike the naive fix issue ' +
      '#170 rejected',
    async () => {
      const good = revocation({ compromisedSince: '2026-01-01T00:00:00.000Z' });
      const verify = jest.fn(async (_a: string, _b: string, _c: string, body: Record<string, unknown>): Promise<LineageMemberVerdict> => {
        if (body['ctx_id'] === 'ctx-1') return { status: 'unsupported', reason: 'ecdsa-p256 has no fingerprint helper' };
        return { status: 'verified', revocation: good };
      });
      const d = deps(
        async () => ({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([fullContext('ctx-1'), fullContext('ctx-2')]),
        }),
        verify,
      );
      const result = await walkRevocationLineage(d, params({ expectCtxId: 'ctx-1' }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.members).toHaveLength(1);
        expect(result.members[0].ctxId).toBe('ctx-2');
        expect(result.members[0].revocation).toEqual(good);
        expect(result.memberVerdictCounts).toEqual({ verified: 1, invalid: 0, unavailable: 0, unsupported: 1 });
      }
      // Both members were reached — proving the walk did not abort on ctx-1,
      // the exact contrast with the 'unavailable' case in AC4 below.
      expect(verify).toHaveBeenCalledTimes(2);
      expect(d.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ctx-1'));
    },
  );

  // ── Acceptance Criterion 3: an abort must still report tallies from every
  // member evaluated BEFORE it, not just zeros or just the aborting member ──
  it(
    'an unsupported member followed by an unavailable member still reports the unsupported ' +
      'count when the walk aborts',
    async () => {
      const verify = jest.fn(async (_a: string, _b: string, _c: string, body: Record<string, unknown>): Promise<LineageMemberVerdict> => {
        if (body['ctx_id'] === 'ctx-1') return { status: 'unsupported', reason: 'ecdsa-p256' };
        return { status: 'unavailable', reason: 'DID host unreachable' };
      });
      const d = deps(
        async () => ({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([fullContext('ctx-1'), fullContext('ctx-2')]),
        }),
        verify,
      );
      const result = await walkRevocationLineage(d, params({ expectCtxId: 'ctx-1' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('transient');
        expect(result.memberVerdictCounts).toEqual({ verified: 0, invalid: 0, unavailable: 1, unsupported: 1 });
      }
      expect(verify).toHaveBeenCalledTimes(2);
    },
  );

  // ── Runtime counterpart of the compile-time exhaustiveness guard ───────
  it('drops a member with a status outside the known union rather than crashing or folding it in', async () => {
    const good = revocation({ compromisedSince: '2026-01-01T00:00:00.000Z' });
    const verify = jest.fn(async (_a: string, _b: string, _c: string, body: Record<string, unknown>): Promise<LineageMemberVerdict> => {
      if (body['ctx_id'] === 'ctx-1') return { status: 'bogus' } as unknown as LineageMemberVerdict;
      return { status: 'verified', revocation: good };
    });
    const d = deps(
      async () => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([fullContext('ctx-1'), fullContext('ctx-2')]),
      }),
      verify,
    );
    const result = await walkRevocationLineage(d, params({ expectCtxId: 'ctx-1' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.members).toHaveLength(1);
      expect(result.members[0].ctxId).toBe('ctx-2');
      // Key-by-key, NOT a whole-object toEqual: the out-of-union 'bogus'
      // status also mints a dynamic `bogus: 1` key on memberVerdictCounts
      // (see Edge cases, plans/revocation-lineage-member-metric.md), which a
      // strict toEqual would reject. The four KNOWN keys are unaffected
      // either way — they are pre-initialized to 0, so `?? 0` is never
      // exercised for them. It's the DYNAMIC 'bogus' key below that proves
      // the guard: without `?? 0`, `memberVerdictCounts['bogus']` starts
      // `undefined`, and `undefined + 1` is `NaN`, not `1`.
      expect(result.memberVerdictCounts.verified).toBe(1);
      expect(result.memberVerdictCounts.invalid).toBe(0);
      expect(result.memberVerdictCounts.unavailable).toBe(0);
      expect(result.memberVerdictCounts.unsupported).toBe(0);
      expect((result.memberVerdictCounts as Record<string, number>)['bogus']).toBe(1);
    }
    expect(verify).toHaveBeenCalledTimes(2);
  });

  // ── AC4 ──────────────────────────────────────────────────────────────
  it('a transiently-failing member aborts the WHOLE walk — no partial fold recorded', async () => {
    const verify = jest.fn(async (_a: string, _b: string, _c: string, body: Record<string, unknown>): Promise<LineageMemberVerdict> => {
      if (body['ctx_id'] === 'ctx-1') return { status: 'unavailable', reason: 'DID host unreachable' };
      return { status: 'verified', revocation: revocation() };
    });
    const d = deps(
      async () => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([fullContext('ctx-1'), fullContext('ctx-2')]),
      }),
      verify,
    );
    const result = await walkRevocationLineage(d, params({ expectCtxId: 'ctx-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('transient');
      expect(result.memberVerdictCounts).toEqual({ verified: 0, invalid: 0, unavailable: 1, unsupported: 0 });
    }
    // ctx-2 (which would have verified fine) must never be reached/recorded once ctx-1 aborts the walk.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0][3]['ctx_id']).toBe('ctx-1');
  });

  // ── Edge case: non-revocation members never disarm, never error ───────
  it('filters out non-revocation members without treating them as an error', async () => {
    const d = deps(async () => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([fullContext('ctx-1'), fullContext('ctx-2', { type: 'analysis' })]),
    }));
    const result = await walkRevocationLineage(d, params({ expectCtxId: 'ctx-1' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.members.map((m) => m.ctxId)).toEqual(['ctx-1']);
  });

  it('counts the §10 interim spelling acdp:key-revocation as a revocation', async () => {
    const d = deps(async () => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([fullContext('ctx-1', { type: 'acdp:key-revocation' })]),
    }));
    const result = await walkRevocationLineage(d, params({ expectCtxId: 'ctx-1' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.members).toHaveLength(1);
  });

  // ── AC10 — the row the original table could not express ───────────────
  it('a 5xx lineage-fetch status (not a throw) aborts the walk as transient', async () => {
    const d = deps(async () => ({ status: 503, contentType: 'application/json', body: '' }));
    const result = await walkRevocationLineage(d, params());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('transient');
      // AC4: a non-2xx fetch status fails before the member loop starts — all-zero.
      expect(result.memberVerdictCounts).toEqual({ verified: 0, invalid: 0, unavailable: 0, unsupported: 0 });
    }
  });

  it('a 404 lineage-fetch status classifies as permanent', async () => {
    const d = deps(async () => ({ status: 404, contentType: 'application/json', body: '' }));
    const result = await walkRevocationLineage(d, params());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('permanent');
  });

  it('a BODY_TOO_LARGE lineage fetch is a hard failure — abort, never truncate', async () => {
    const d = deps(async () => {
      throw new FederationFetchError('BODY_TOO_LARGE', 'exceeded cap');
    });
    const result = await walkRevocationLineage(d, params());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('hard');
  });

  it('a FederationFetchError FETCH throw classifies as transient', async () => {
    const d = deps(async () => {
      throw new FederationFetchError('FETCH', 'ECONNRESET');
    });
    const result = await walkRevocationLineage(d, params());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('transient');
      // AC4: a thrown fetch error fails before the member loop starts — all-zero.
      expect(result.memberVerdictCounts).toEqual({ verified: 0, invalid: 0, unavailable: 0, unsupported: 0 });
    }
  });

  it('a malformed (non-array) lineage response is a permanent failure', async () => {
    const d = deps(async () => ({ status: 200, contentType: 'application/json', body: '{}' }));
    const result = await walkRevocationLineage(d, params());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('permanent');
  });

  // ── AC5-7: fold correctness (fixture-mirrored — see the conformance block below for the real data) ──
  it('folds to the EARLIEST compromised_since across superseded + retracted members alike', async () => {
    const earliest = revocation({ compromisedSince: '2026-03-01T00:00:00.000Z' });
    const later = revocation({ compromisedSince: '2026-05-01T00:00:00.000Z' });
    const retracted = revocation({ compromisedSince: '2026-06-01T00:00:00.000Z' });
    const byCtx: Record<string, ParsedRevocation> = { 'ctx-1': later, 'ctx-2': earliest, 'ctx-3': retracted };
    const d = deps(
      async () => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          fullContext('ctx-1'),
          fullContext('ctx-2', { supersedes: 'ctx-1' }),
          fullContext('ctx-3', { supersedes: 'ctx-2' }),
        ]),
      }),
      async (_a, _b, _c, body) => ({ status: 'verified', revocation: byCtx[body['ctx_id'] as string] }),
    );
    const result = await walkRevocationLineage(d, params({ expectCtxId: 'ctx-1' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const min = result.members.reduce((m, x) => (x.revocation.compromisedSince < m ? x.revocation.compromisedSince : m), '9999');
      expect(min).toBe('2026-03-01T00:00:00.000Z');
    }
  });
});

// ── Conformance cross-check: rev-002-before-after-boundary scenarios E-H ──
//
// Builds each scenario's lineage member set straight from the fixture's own
// `revocation_lineage.L1/L2/L3` data (not a hand-typed re-derivation), feeds
// it through `walkRevocationLineage`, and asserts the resulting member set's
// minimum `compromised_since` equals the scenario's documented effective
// boundary. `verifyMemberBody` is stubbed as always-succeeding here — this
// phase's job is proving the WALK assembles the right member set, not
// re-running full RFC-ACDP-0010 receipt verification (that is
// revocation-audit.service's / a later phase's job; see revocation-verify
// .spec.ts's rev-001 golden parity for the crypto-level check).
// Graceful-skip pattern lifted from revocation-verify.spec.ts.

function conformanceDir(): string | null {
  const candidates = [
    process.env.ACDP_SPEC_DIR ? path.join(process.env.ACDP_SPEC_DIR, 'schemas', 'conformance') : null,
    path.resolve(__dirname, '../../../agentcontextdistributionprotocol/schemas/conformance'),
  ].filter((c): c is string => c !== null);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'rev-002-before-after-boundary.json'))) return dir;
  }
  return null;
}

const CONFORMANCE_DIR = conformanceDir();
const load = (name: string): any => JSON.parse(fs.readFileSync(path.join(CONFORMANCE_DIR!, name), 'utf8'));
const REQUIRE_CONFORMANCE = typeof process.env.ACDP_REQUIRE_CONFORMANCE !== 'undefined';
const describeGolden = CONFORMANCE_DIR || REQUIRE_CONFORMANCE ? describe : describe.skip;
if (!CONFORMANCE_DIR && !REQUIRE_CONFORMANCE) {
  console.warn(
    '[revocation-lineage.spec] ACDP_SPEC_DIR / sibling spec not found — SKIPPING rev-002 lineage-fold conformance',
  );
}

function requireConformanceDir(): void {
  if (REQUIRE_CONFORMANCE && !CONFORMANCE_DIR) {
    throw new Error(
      'ACDP_REQUIRE_CONFORMANCE is set but no ACDP spec checkout was found — the rev-002 ' +
        'lineage-fold conformance fixture is required in this mode.',
    );
  }
}

interface FixtureMember {
  label: string;
  type: string;
  revoked_key_fingerprint?: string;
  compromised_since?: string;
}

describeGolden('RFC-ACDP-0014 §7 lineage-fold conformance (rev-002 scenarios E-H)', () => {
  beforeAll(requireConformanceDir);

  function memberToFullContext(m: FixtureMember) {
    return fullContext(m.label, {
      type: m.type,
      ...(m.revoked_key_fingerprint ? { revoked_key_fingerprint: m.revoked_key_fingerprint } : {}),
    });
  }

  function walkFixtureLineage(members: FixtureMember[], expectCtxId: string) {
    const d = {
      federationClient: {
        get: async (): Promise<FederationResponse> => ({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(members.map((m) => memberToFullContext(m))),
        }),
      },
      verifyMemberBody: async (_a: string, _b: string, _c: string, body: Record<string, unknown>): Promise<LineageMemberVerdict> => {
        const m = members.find((x) => x.label === body['ctx_id']);
        return {
          status: 'verified',
          revocation: revocation({ compromisedSince: m?.compromised_since ?? '9999-01-01T00:00:00.000Z' }),
        };
      },
      logger: { warn: jest.fn() },
    };
    return walkRevocationLineage(d, {
      lineageId: LINEAGE,
      registryAuthority: AUTHORITY,
      baseUrl: BASE_URL,
      tenantId: TENANT,
      expectCtxId,
    });
  }

  function foldMin(result: Awaited<ReturnType<typeof walkRevocationLineage>>): string {
    if (!result.ok) throw new Error(`walk failed unexpectedly: ${result.kind}: ${result.reason}`);
    return result.members.reduce((m, x) => (x.revocation.compromisedSince < m ? x.revocation.compromisedSince : m), '9999');
  }

  it('scenario E: lineage L1 folds to T1 (the earliest, not the superseding head T2)', async () => {
    const fixture = load('rev-002-before-after-boundary.json');
    const members: FixtureMember[] = fixture.input.revocation_lineage.L1.members;
    const result = await walkFixtureLineage(members, members[0].label);
    expect(foldMin(result)).toBe('2026-05-01T00:00:00.000Z');
  });

  it('scenario F: a retracted member still counts in the fold (L1, R1 retracted)', async () => {
    const fixture = load('rev-002-before-after-boundary.json');
    const members: FixtureMember[] = fixture.input.revocation_lineage.L1.members;
    // The fixture models retraction as a lifecycle event layered on R1, not a
    // different member set — the walk never filters by registry_state at
    // all, so exercising the SAME member set proves retraction genuinely
    // changes nothing about the fold, which is scenario F's exact point.
    const result = await walkFixtureLineage(members, members[0].label);
    expect(foldMin(result)).toBe('2026-05-01T00:00:00.000Z');
  });

  it('scenario G: a non-revocation supersession (L2, X = analysis) does not disarm the revocation', async () => {
    const fixture = load('rev-002-before-after-boundary.json');
    const members: FixtureMember[] = fixture.input.revocation_lineage.L2.members;
    const result = await walkFixtureLineage(members, members[0].label);
    expect(foldMin(result)).toBe('2026-05-01T00:00:00.000Z');
  });

  it('scenario H: an interim-typed (acdp:key-revocation) widening successor (L3, Y) IS counted', async () => {
    const fixture = load('rev-002-before-after-boundary.json');
    const members: FixtureMember[] = fixture.input.revocation_lineage.L3.members;
    expect(members.some((m) => m.type === 'acdp:key-revocation')).toBe(true);
    const result = await walkFixtureLineage(members, members[0].label);
    expect(foldMin(result)).toBe('2026-04-01T00:00:00.000Z');
  });
});
