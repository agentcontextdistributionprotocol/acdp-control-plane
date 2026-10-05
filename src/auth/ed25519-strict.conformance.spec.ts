/**
 * RFC-ACDP-0001 §5.10 strict Ed25519 — the `sig-004` negative vector driven
 * through EVERY Ed25519 entry point the control plane routes to the `acdp`
 * SDK (issue #221, Phase 2; inventory paths 1-8 in
 * `plans/strict-ed25519-bearer-jwt-221.md`).
 *
 * The forgery: public key A = identity point, signature = (R = identity,
 * s = 0). The cofactorless equation [s]B = R + [k]A then reads
 * identity = identity + identity for EVERY k — i.e. for every message — so a
 * non-strict verifier (ed25519-dalek `verify`, as in acdp 0.14.3) accepts it
 * over whatever signing input an entry point computes. No private key is
 * needed, which is what lets one vector exercise every surface below. A
 * conformant (`verify_strict`, acdp 0.14.4+) verifier MUST reject it.
 *
 * Each rejection is paired, where the surface has non-signature checks that
 * could also fail, with a POSITIVE control over the same inputs and a genuine
 * golden signature — so a rejection is attributable to the signature, not to a
 * malformed fixture.
 *
 * Fixtures load from `$ACDP_SPEC_DIR/schemas/conformance` (falling back to the
 * sibling spec checkout), the same pattern as `src/audit/cosign.spec.ts`.
 * The suite SKIPS gracefully when neither is present, and HARD-FAILS when
 * `ACDP_REQUIRE_CONFORMANCE` is set (CI's `unit` job).
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HttpStatus } from '@nestjs/common';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { verifySignatureB64 } from './acdp-verify';
import { ChallengeStore } from './challenge-store.service';
import { InMemoryChallengeRepository } from './in-memory-challenge.repository';
import { buildSigningMaterial } from './jwt-signing';
import { PinnedKeysService } from './pinned-keys.service';
import { TokenIssuer } from './token-issuer.service';
import { CapabilityService } from '../agents/capability.service';
import { capabilityAssertion } from '../agents/capability-uri';
import { verifyCheckpointSignature, type LogCheckpoint } from '../audit/log-verify';
import {
  evaluateQuorum,
  nativeEvaluateQuorum,
  nativeVerifyCosignature,
  sdkHasCosignatureSurface,
  tsVerifyCosignature,
  verifyCosignature,
  type LogCosignature,
  type QuorumInputs,
} from '../audit/cosign';
import { sdkSupportsReceipts, verifyContentHash, verifyReceipt } from '../audit/receipt-verify';

// ── Fixture loading (ACDP_SPEC_DIR, graceful skip / hard fail) ───────────

const SIG_004 = 'sig-004-ed25519-strict-negative.json';

function conformanceDir(): string | null {
  const candidates = [
    process.env.ACDP_SPEC_DIR
      ? path.join(process.env.ACDP_SPEC_DIR, 'schemas', 'conformance')
      : null,
    path.resolve(__dirname, '../../../agentcontextdistributionprotocol/schemas/conformance'),
  ].filter((c): c is string => c !== null);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, SIG_004))) return dir;
  }
  return null;
}

const CONFORMANCE_DIR = conformanceDir();
const load = (name: string): any =>
  JSON.parse(fs.readFileSync(path.join(CONFORMANCE_DIR!, name), 'utf8'));

const REQUIRE_CONFORMANCE = typeof process.env.ACDP_REQUIRE_CONFORMANCE !== 'undefined';
const describeConformance = CONFORMANCE_DIR || REQUIRE_CONFORMANCE ? describe : describe.skip;
if (!CONFORMANCE_DIR && !REQUIRE_CONFORMANCE) {
  console.warn(
    '[ed25519-strict.conformance.spec] ACDP_SPEC_DIR / sibling spec not found — SKIPPING sig-004',
  );
}

function requireConformanceDir(): void {
  if (REQUIRE_CONFORMANCE && !CONFORMANCE_DIR) {
    throw new Error(
      'ACDP_REQUIRE_CONFORMANCE is set but no ACDP spec checkout carrying ' +
        `${SIG_004} was found at ACDP_SPEC_DIR or the sibling path — the sig-004 ` +
        'strict-Ed25519 fixtures are required in this mode.',
    );
  }
}

const b64FromHex = (hex: string): string => Buffer.from(hex, 'hex').toString('base64');

// ── Small-order forgery construction (for the 8-point loop) ──────────────
//
// For a small-order A other than the identity, (R = identity, s = 0) only
// satisfies the loose equation when [k]A = identity, i.e. when
// k = SHA-512(R || A || M) mod L is a multiple of ord(A). Pairing each A with
// the fixture signature over an ARBITRARY message would therefore prove
// nothing for orders 2/4/8 (a non-strict verifier would reject it too). So
// per point we SEARCH the message M until k ≡ 0 (mod ord(A)) — at most a
// handful of tries for ord ≤ 8 — which makes (A, M, R=identity, s=0) a
// genuine loose-equation forgery: [0]B = identity = identity + [k]A. Only
// then does a rejection prove strictness. (The mutation check against acdp
// 0.14.3 confirms each constructed pair is ACCEPTED by the non-strict
// verifier, i.e. that the construction is a real forgery.)

const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const IDENTITY_HEX = '01' + '00'.repeat(31);
const FORGED_SIG_HEX = IDENTITY_HEX + '00'.repeat(32); // R = identity, s = 0

function leToBigInt(buf: Buffer): bigint {
  let n = 0n;
  for (let i = buf.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(buf[i]!);
  return n;
}

/** k = SHA-512(R || A || M) mod L (RFC 8032 §5.1.7 step 2). */
function challengeScalar(rHex: string, aHex: string, message: string): bigint {
  const h = createHash('sha512')
    .update(Buffer.from(rHex, 'hex'))
    .update(Buffer.from(aHex, 'hex'))
    .update(Buffer.from(message, 'utf8'))
    .digest();
  return leToBigInt(h) % L;
}

/** A message M for which (A, R=identity, s=0) satisfies the loose equation. */
function forgeableMessage(aHex: string, order: number): string {
  for (let i = 0; i < 1024; i++) {
    const m = `acdp-sig-004-small-order-probe:${aHex}:${i}`;
    if (challengeScalar(IDENTITY_HEX, aHex, m) % BigInt(order) === 0n) return m;
  }
  throw new Error(`no forgeable message found for small-order point ${aHex}`);
}

// ── The suite ────────────────────────────────────────────────────────────

describeConformance('RFC-ACDP-0001 §5.10 strict Ed25519 (sig-004) across every SDK entry point', () => {
  let vector: any;
  let A: string; // identity public key, base64
  let FORGED: string; // R = identity, s = 0, base64

  beforeAll(() => {
    requireConformanceDir();
    const fixture = load(SIG_004);
    vector = fixture.vectors[0];
    A = b64FromHex(vector.public_key_hex);
    FORGED = b64FromHex(vector.signature_value_hex);
  });

  it('the fixture is the identity-A / identity-R / s=0 forgery this suite is built around', () => {
    expect(vector.negative).toBe(true);
    expect(vector.expected.loose_equation_holds).toBe(true);
    expect(vector.expected.strict_result).toBe('reject');
    expect(vector.public_key_hex).toBe(IDENTITY_HEX);
    expect(vector.signature_value_hex).toBe(FORGED_SIG_HEX);
  });

  // ── sig-001 positive control (no false rejection) ──────────────────────

  it('sig-001 positive control: the golden signature still verifies', () => {
    const golden = load('sig-001-ed25519-golden.json');
    const exp = golden.vectors[0].expected;
    expect(
      verifySignatureB64(
        'ed25519',
        golden.test_keypair.public_key_base64,
        exp.signature_input,
        exp.signature_value_base64,
      ),
    ).toBe(true);
  });

  // ── (1) verifySignatureB64 ─────────────────────────────────────────────

  it('(1) verifySignatureB64 rejects the sig-004 vector over its signature_input', () => {
    expect(verifySignatureB64('ed25519', A, vector.signature_input, FORGED)).toBe(false);
  });

  it('(1) verifySignatureB64 rejects the sig-004 vector over arbitrary messages', () => {
    for (const msg of ['', 'hello', 'sha256:' + '00'.repeat(32)]) {
      expect(verifySignatureB64('ed25519', A, msg, FORGED)).toBe(false);
    }
  });

  it('(1) verifySignatureB64 rejects a loose-equation forgery for each of the 8 small-order A', () => {
    const fixture = load(SIG_004);
    const points: Array<{ order: number; encoding_hex: string }> = fixture.small_order_points;
    expect(points).toHaveLength(8);
    for (const p of points) {
      const msg = forgeableMessage(p.encoding_hex, p.order);
      // Self-check: the loose equation genuinely holds for this pairing.
      expect(challengeScalar(IDENTITY_HEX, p.encoding_hex, msg) % BigInt(p.order)).toBe(0n);
      const accepted = verifySignatureB64('ed25519', b64FromHex(p.encoding_hex), msg, FORGED);
      expect({ point: p.encoding_hex, accepted }).toEqual({ point: p.encoding_hex, accepted: false });
    }
  });

  // ── (2) verifyCheckpointSignature ──────────────────────────────────────

  it('(2) verifyCheckpointSignature rejects a checkpoint signed by the forgery', () => {
    const checkpoint = load('log-001-leaf-and-root-golden.json').vectors[0].expected
      .log_checkpoint as LogCheckpoint;
    const registryKey = load('rcpt-001-receipt-golden.json').registry_test_keypair.public_key_base64;
    // Positive control: the genuine checkpoint verifies under the real key.
    expect(verifyCheckpointSignature(checkpoint, registryKey)).toEqual({ ok: true });

    const forged: LogCheckpoint = {
      ...checkpoint,
      signature: { ...checkpoint.signature, value: FORGED },
    };
    expect(verifyCheckpointSignature(forged, A).ok).toBe(false);
  });

  // ── (3) verifyCosignature (host + native) ──────────────────────────────

  describe('(3) verifyCosignature', () => {
    let golden: LogCosignature;
    let forged: LogCosignature;
    let witnessKey: string;
    let checkpoint: LogCheckpoint;

    beforeAll(() => {
      const wit = load('wit-001-cosignature-golden.json');
      golden = wit.vectors[0].expected.log_cosignature as LogCosignature;
      witnessKey = wit.witness_test_keypair.public_key_base64;
      checkpoint = load('log-001-leaf-and-root-golden.json').vectors[0].expected
        .log_checkpoint as LogCheckpoint;
      forged = { ...golden, signature: { ...golden.signature, value: FORGED } };
    });

    it('host branch (tsVerifyCosignature) rejects the forgery', () => {
      expect(tsVerifyCosignature(golden, witnessKey)).toEqual({ ok: true });
      expect(tsVerifyCosignature(forged, A).ok).toBe(false);
      // The public dispatcher routes host when no checkpoint is supplied.
      expect(verifyCosignature(forged, A).ok).toBe(false);
    });

    it('native branch (verifyWitnessCosignature) rejects the forgery', () => {
      expect(sdkHasCosignatureSurface()).toBe(true);
      expect(nativeVerifyCosignature(golden, witnessKey, checkpoint)).toEqual({ ok: true });
      expect(nativeVerifyCosignature(forged, A, checkpoint).ok).toBe(false);
      // The public dispatcher routes native when handed the checkpoint.
      expect(verifyCosignature(forged, A, checkpoint).ok).toBe(false);
    });
  });

  // ── (4) evaluateQuorum (native) ────────────────────────────────────────

  it('(4) evaluateQuorum native branch counts zero witnesses for a forged cosignature', () => {
    expect(sdkHasCosignatureSurface()).toBe(true);
    const wit = load('wit-001-cosignature-golden.json');
    const golden = wit.vectors[0].expected.log_cosignature as LogCosignature;
    const checkpoint = load('log-001-leaf-and-root-golden.json').vectors[0].expected
      .log_checkpoint as LogCheckpoint;
    const forged = { ...golden, signature: { ...golden.signature, value: FORGED } };
    const base: Omit<QuorumInputs, 'cosignatures' | 'witnessKeysB64'> = {
      checkpoint,
      trustedWitnessIds: [golden.witness_id],
      minWitnesses: 1,
      maxAgeSecs: null,
      nowMs: new Date('2026-07-04T12:05:00.000Z').getTime(),
    };

    // Positive control: the genuine cosignature counts under the real key.
    const control = nativeEvaluateQuorum({
      ...base,
      cosignatures: [golden],
      witnessKeysB64: { [golden.witness_id]: wit.witness_test_keypair.public_key_base64 },
    });
    expect(control).not.toBeNull();
    expect(control!.witnessedCount).toBe(1);

    const inputs: QuorumInputs = {
      ...base,
      cosignatures: [forged],
      witnessKeysB64: { [golden.witness_id]: A },
    };
    const native = nativeEvaluateQuorum(inputs);
    expect(native).not.toBeNull();
    expect(native!.witnessedCount).toBe(0);
    expect(native!.meetsQuorum).toBe(false);
    expect(evaluateQuorum(inputs).witnessedCount).toBe(0);
  });

  // ── (5) verifyReceipt ──────────────────────────────────────────────────

  it('(5) verifyReceipt rejects the rcpt-001 receipt re-signed by the forgery', () => {
    expect(sdkSupportsReceipts()).toBe(true);
    const rcpt = load('rcpt-001-receipt-golden.json');
    const sig1 = load('sig-001-ed25519-golden.json').vectors[0];
    const receipt = rcpt.vectors[0].expected.registry_receipt;
    // The served body: the sig-001 publish request plus its registry-assigned
    // fields — the context rcpt-001's receipt is over.
    const body = { ...sig1.expected.publish_request_body, ...sig1.registry_assigned };
    const bodyJson = JSON.stringify(body);
    const ctxId: string = receipt.ctx_id;
    const contentHash: string = receipt.content_hash;
    const producerFp: string = receipt.key_fingerprint;
    expect(verifyContentHash(bodyJson, contentHash)).toEqual({ ok: true });

    // Positive control: the golden receipt verifies under the real registry key.
    expect(
      verifyReceipt(
        JSON.stringify(receipt),
        bodyJson,
        rcpt.registry_test_keypair.public_key_base64,
        ctxId,
        contentHash,
        producerFp,
      ),
    ).toEqual({ ok: true });

    const forged = { ...receipt, signature: { ...receipt.signature, value: FORGED } };
    const out = verifyReceipt(JSON.stringify(forged), bodyJson, A, ctxId, contentHash, producerFp);
    expect(out.ok).toBe(false);
  });

  // ── (6) TokenIssuer.issueToken ─────────────────────────────────────────

  it('(6) TokenIssuer.issueToken refuses an agent pinned to the identity key → INVALID_SIGNATURE / 401', async () => {
    const did = 'did:web:agents.example.com:sig-004';
    const pinned = new PinnedKeysService();
    pinned.load(`${did}=${A}`);
    const cfg: any = {
      jwtSecret: 'a'.repeat(64),
      jwtAuthority: 'cp.test',
      jwtTtlSeconds: 3600,
      challengeTtlSeconds: 300,
      authPersistence: 'memory',
      tenantAgentsRaw: '',
    };
    const issuer = new TokenIssuer(
      cfg,
      new ChallengeStore(new InMemoryChallengeRepository()),
      pinned,
      { material: buildSigningMaterial({ algorithm: 'HS256', hsSecret: cfg.jwtSecret }) } as any,
      null, // revocations
      null, // ledger
      null, // did:web resolver — the pinned path is the one under test
    );
    const ch = await issuer.issueChallenge(did);
    const err = await issuer
      .issueToken({
        agentDid: did,
        keyId: `${did}#key-1`,
        nonce: ch.nonce,
        expiresAt: ch.expiresAt,
        algorithm: 'ed25519',
        signature: FORGED,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).errorCode).toBe(ErrorCode.INVALID_SIGNATURE);
    expect((err as AppException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });

  // ── (7) CapabilityService.declare ──────────────────────────────────────

  it('(7) CapabilityService.declare refuses an agent pinned to the identity key', async () => {
    const did = 'did:web:cp.test:agents:sig-004';
    const uri = 'urn:acdp:cap:publish:data_snapshot:finance';
    const repo = { declare: jest.fn() };
    const svc = new CapabilityService(repo as any, new PinnedKeysService());
    svc.setPinnedKeys(`${did}=${A}`);
    const declaredAt = new Date().toISOString();
    // Sanity: the input the forgery is "over" is the real assertion string.
    expect(capabilityAssertion(did, uri, declaredAt)).toContain(did);
    const err = await svc
      .declare({
        agentDid: did,
        capabilityUri: uri,
        declaredAtIso: declaredAt,
        keyId: `${did}#key-1`,
        algorithm: 'ed25519',
        signature: FORGED,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).errorCode).toBe(ErrorCode.INVALID_SIGNATURE);
    expect((err as AppException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect(repo.declare).not.toHaveBeenCalled();
  });
});
