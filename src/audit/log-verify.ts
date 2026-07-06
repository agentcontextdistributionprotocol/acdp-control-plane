/**
 * Transparency-log verification (RFC-ACDP-0012 §5/§6/§9) for the checkpoint
 * witness and the receipt↔log inclusion cross-check.
 *
 * ## Implementation choice (native binding, TS fallback) — per the SDK rule
 *
 * The pinned `acdp` binding (`npm:@agentcontextdistributionprotocol/acdp@^0.6.0`)
 * carries the RFC-ACDP-0012 log surface natively:
 * `AcdpVerifier.verifyLogInclusion` / `verifyLogConsistency` /
 * `verifyLogCheckpoint` / `buildLogLeaf` and `AcdpMerkle.{leafHash,nodeHash,
 * rootHash}`. `verifyInclusion()` / `verifyConsistency()` DELEGATE the §9.1
 * audit-path and §9.2 consistency folds to that binding — the same Rust
 * arithmetic the reference consumer runs — whenever `sdkHasLogSurface()` is
 * true (0.6.0+). The verdicts are byte-identical to the host TS fold; a
 * conformance cross-check (`log-verify.parity.spec.ts`) runs the log-001 /
 * log-003 golden vectors through BOTH paths and asserts the same roots and
 * verdicts.
 *
 * The host-side §5/§9 SHA-256 arithmetic (`verifyInclusionPath`,
 * `verifyConsistencyPath`, `leafHash`, `nodeHash`) is RETAINED as the
 * fallback for a binding that predates the log surface (≤ 0.5.0) — a
 * checkpoint witness that cannot verify proofs is useless, so it degrades to
 * the pure, fully pinned RFC 6962/9162 folds (§5.1 0x00/0x01
 * domain-separation prefixes included) rather than crashing. Both branches
 * still take everything that IS protocol wire format from the SDK: JCS
 * canonicalization (`AcdpCanonicalizer.canonicalize`, RFC 8785), Ed25519
 * signature verification (`AcdpVerifier` via `verifySignatureB64`), and
 * receipt-key resolution + the RFC-ACDP-0010 §9 lifecycle
 * (`DidWebResolverService.resolveReceiptKey`).
 *
 * All functions return outcome objects — they never throw on untrusted input.
 */
import { createHash } from 'node:crypto';
import { AcdpCanonicalizer, AcdpVerifier } from 'acdp';
import { verifySignatureB64 } from '../auth/acdp-verify';

/** RFC-ACDP-0011 §7 step 6 / RFC-ACDP-0012 §9.3 step 4 skew allowance. */
export const CHECKPOINT_MAX_FUTURE_SKEW_MS = 120_000;

export type VerifyOutcome = { ok: true } | { ok: false; reason: string };

/**
 * True when the installed `acdp` binding carries the RFC-ACDP-0012 log API
 * (0.6.0+). The probed names are the binding's public static methods — the
 * NAPI surface is camelCase (`verifyLogCheckpoint`, not `verify_log_...`), so
 * these match the published `AcdpVerifier` methods exactly. When true,
 * `verifyInclusion()` / `verifyConsistency()` delegate the §9.1/§9.2 folds to
 * the binding; when false they fall back to the host TS arithmetic below.
 */
export function sdkHasLogSurface(): boolean {
  const v = AcdpVerifier as unknown as Record<string, unknown>;
  return (
    typeof v.verifyLogCheckpoint === 'function' &&
    typeof v.verifyLogInclusion === 'function' &&
    typeof v.verifyLogConsistency === 'function' &&
    typeof v.buildLogLeaf === 'function'
  );
}

/** The RFC-ACDP-0012 §9.1/§9.2 fold surface on the 0.6.0+ binding. */
interface LogCapableVerifier {
  verifyLogInclusion(inclusionJson: string, checkpointJson: string, reconstructedLeafJson: string): string;
  verifyLogConsistency(consistencyJson: string, checkpointJson: string, firstRootHash: string): string;
}

/**
 * Map a native fold verdict to a {@link VerifyOutcome}. The binding returns a
 * JSON string `{"valid":true}` / `{"valid":false,"code","error"}` for a
 * shape-valid proof that simply fails to fold, and THROWS (with a `.code`)
 * on structurally malformed input — both collapse to `{ ok:false, reason }`.
 */
function nativeVerdict(run: () => string): VerifyOutcome {
  let json: string;
  try {
    json = run();
  } catch (err) {
    return { ok: false, reason: nativeErr(err) };
  }
  let parsed: { valid?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(json) as { valid?: unknown; error?: unknown };
  } catch {
    return { ok: false, reason: 'native log verification returned non-JSON' };
  }
  if (parsed.valid === true) return { ok: true };
  return {
    ok: false,
    reason: typeof parsed.error === 'string' ? parsed.error : 'native log verification failed',
  };
}

function nativeErr(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return `${String((err as { code: unknown }).code)}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Strip an embedded `log_checkpoint` from a proof before a native fold call.
 * The binding requires any embedded checkpoint to be byte-equal to the
 * separately-supplied (signature-verified) one and rejects the proof
 * otherwise (§9.1 step 3). The host TS path only ever consumes the trusted
 * checkpoint's `root_hash`, so we drop the embedded copy and let the binding
 * insert our verified checkpoint — keeping the two paths byte-identical.
 */
function stripEmbeddedCheckpoint<T extends { log_checkpoint?: unknown }>(
  proof: T,
): Omit<T, 'log_checkpoint'> {
  const { log_checkpoint: _omit, ...rest } = proof;
  return rest;
}

// ── Checkpoint (signed tree head), §6 / §9.3 ─────────────────────────────

export interface LogCheckpoint {
  checkpoint_version: string;
  log_id: string;
  tree_size: number;
  root_hash: string;
  timestamp: string;
  signature: { algorithm: string; key_id: string; value: string };
}

const WIRE_HASH_RE = /^sha256:[0-9a-f]{64}$/;
/** Canonical millisecond-precision RFC 3339 UTC (RFC-ACDP-0001 §5.3). */
const CANONICAL_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** §6: `<did:web DID>/log/<instance>` with instance `[a-z0-9-]{1,32}`. */
const LOG_ID_RE = /^(did:web:[A-Za-z0-9._%:-]+)\/log\/[a-z0-9-]{1,32}$/;

/** The `did:web:...` registry DID embedded in a `log_id`, or null. */
export function logIdRegistryDid(logId: string): string | null {
  const m = LOG_ID_RE.exec(logId);
  return m ? m[1]! : null;
}

/**
 * Closed-schema parse of a §6 checkpoint (§9.3 step 1). Exactly the six
 * members, `checkpoint_version` exactly `"acdp-log/1"`, well-formed
 * `log_id` / `root_hash` / canonical-ms `timestamp`, closed signature.
 */
export function parseCheckpoint(
  raw: unknown,
): { ok: true; checkpoint: LogCheckpoint } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'checkpoint is not a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const expected = [
    'checkpoint_version',
    'log_id',
    'tree_size',
    'root_hash',
    'timestamp',
    'signature',
  ];
  const keys = Object.keys(obj);
  const extra = keys.filter((k) => !expected.includes(k));
  const missing = expected.filter((k) => !keys.includes(k));
  if (extra.length > 0 || missing.length > 0) {
    return {
      ok: false,
      reason:
        `checkpoint schema violation (closed §6 object): ` +
        `missing=[${missing.join(',')}] unknown=[${extra.join(',')}]`,
    };
  }
  if (obj.checkpoint_version !== 'acdp-log/1') {
    return {
      ok: false,
      reason: `checkpoint_version must be 'acdp-log/1', got '${String(obj.checkpoint_version)}'`,
    };
  }
  if (typeof obj.log_id !== 'string' || !LOG_ID_RE.test(obj.log_id)) {
    return { ok: false, reason: `malformed log_id '${String(obj.log_id)}'` };
  }
  if (
    typeof obj.tree_size !== 'number' ||
    !Number.isInteger(obj.tree_size) ||
    obj.tree_size < 0
  ) {
    return { ok: false, reason: `tree_size must be an integer >= 0` };
  }
  if (typeof obj.root_hash !== 'string' || !WIRE_HASH_RE.test(obj.root_hash)) {
    return { ok: false, reason: `malformed root_hash` };
  }
  if (
    typeof obj.timestamp !== 'string' ||
    !CANONICAL_TS_RE.test(obj.timestamp) ||
    !Number.isFinite(Date.parse(obj.timestamp))
  ) {
    return { ok: false, reason: `timestamp is not canonical ms-precision RFC 3339 UTC` };
  }
  const sig = obj.signature;
  if (sig === null || typeof sig !== 'object' || Array.isArray(sig)) {
    return { ok: false, reason: 'signature is not an object' };
  }
  const s = sig as Record<string, unknown>;
  const sigKeys = Object.keys(s).sort();
  if (
    sigKeys.join(',') !== 'algorithm,key_id,value' ||
    typeof s.algorithm !== 'string' ||
    typeof s.key_id !== 'string' ||
    typeof s.value !== 'string'
  ) {
    return { ok: false, reason: 'signature must be the closed {algorithm,key_id,value} object' };
  }
  return { ok: true, checkpoint: obj as unknown as LogCheckpoint };
}

/**
 * The §6 signing input: `"sha256:" + hex(SHA-256(JCS(checkpoint − signature)))`
 * — RFC-ACDP-0010 §5 verbatim. JCS comes from the SDK; only the SHA-256 is
 * node:crypto. Returns null if the object cannot be canonicalized.
 */
export function checkpointHash(checkpoint: LogCheckpoint): string | null {
  const { signature: _omit, ...preimageObj } = checkpoint;
  let canonical: string;
  try {
    canonical = AcdpCanonicalizer.canonicalize(JSON.stringify(preimageObj));
  } catch {
    return null;
  }
  const digest = createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
  return `sha256:${digest}`;
}

/**
 * §9.3 step 2 signature half: recompute the preimage hash and verify the
 * Ed25519 signature over its ASCII bytes. Key resolution (and its lifecycle
 * / SSRF rules) stays with the caller — DidWebResolverService.
 * Checkpoints sign with the registry receipt signing key, which the registry
 * stack mints as Ed25519 only (same posture as receipt-audit).
 */
export function verifyCheckpointSignature(
  checkpoint: LogCheckpoint,
  registryPublicKeyB64: string,
): VerifyOutcome {
  if (checkpoint.signature.algorithm !== 'ed25519') {
    return {
      ok: false,
      reason:
        `unsupported checkpoint signature algorithm '${checkpoint.signature.algorithm}' — ` +
        `registries sign checkpoints with the ed25519 receipt key (RFC-ACDP-0012 §6)`,
    };
  }
  const hash = checkpointHash(checkpoint);
  if (hash === null) {
    return { ok: false, reason: 'checkpoint could not be canonicalized (JCS)' };
  }
  const valid = verifySignatureB64(
    'ed25519',
    registryPublicKeyB64,
    hash,
    checkpoint.signature.value,
  );
  return valid ? { ok: true } : { ok: false, reason: 'checkpoint signature invalid' };
}

/** §9.3 step 4: `timestamp` must not be in the future beyond the skew allowance. */
export function checkpointTimestampOk(
  checkpoint: LogCheckpoint,
  nowMs: number = Date.now(),
): VerifyOutcome {
  const ts = Date.parse(checkpoint.timestamp);
  if (ts - nowMs > CHECKPOINT_MAX_FUTURE_SKEW_MS) {
    return {
      ok: false,
      reason: `checkpoint timestamp '${checkpoint.timestamp}' is in the future beyond the 120s skew allowance`,
    };
  }
  return { ok: true };
}

// ── Merkle arithmetic, §5 ────────────────────────────────────────────────

/** Decode a wire-form `"sha256:<64-hex>"` string to its raw 32 bytes. */
export function wireHashToBuf(wire: unknown): Buffer | null {
  if (typeof wire !== 'string' || !WIRE_HASH_RE.test(wire)) return null;
  return Buffer.from(wire.slice('sha256:'.length), 'hex');
}

/** §5.1 leaf hash: `SHA-256(0x00 ‖ JCS(leaf))`. Null if not canonicalizable. */
export function leafHash(leaf: Record<string, unknown>): Buffer | null {
  let canonical: string;
  try {
    canonical = AcdpCanonicalizer.canonicalize(JSON.stringify(leaf));
  } catch {
    return null;
  }
  return createHash('sha256')
    .update(Buffer.from([0x00]))
    .update(Buffer.from(canonical, 'utf8'))
    .digest();
}

/** §5.1 interior-node hash: `SHA-256(0x01 ‖ left ‖ right)`. */
export function nodeHash(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(Buffer.from([0x01])).update(left).update(right).digest();
}

/**
 * §9.1 steps 5–6: fold the RFC 6962 audit path (RFC 9162 §2.1.3.2) from a
 * leaf hash up to a root and compare against the checkpoint root.
 */
export function verifyInclusionPath(
  leafIndex: number,
  treeSize: number,
  leaf: Buffer,
  inclusionPath: readonly string[],
  expectedRootHash: string,
): VerifyOutcome {
  const expectedRoot = wireHashToBuf(expectedRootHash);
  if (expectedRoot === null) return { ok: false, reason: 'malformed expected root hash' };
  if (!Number.isInteger(leafIndex) || !Number.isInteger(treeSize) || leafIndex < 0) {
    return { ok: false, reason: 'leaf_index/tree_size must be non-negative integers' };
  }
  if (leafIndex >= treeSize) {
    return { ok: false, reason: `leaf_index ${leafIndex} >= tree_size ${treeSize}` };
  }

  let fn = BigInt(leafIndex);
  let sn = BigInt(treeSize) - 1n;
  let r = leaf;
  for (const element of inclusionPath) {
    const p = wireHashToBuf(element);
    if (p === null) return { ok: false, reason: 'malformed inclusion_path element' };
    if (sn === 0n) return { ok: false, reason: 'inclusion_path longer than the tree height' };
    if (fn % 2n === 1n || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2n === 0n) {
        while (fn % 2n === 0n && fn !== 0n) {
          fn >>= 1n;
          sn >>= 1n;
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  if (sn !== 0n) return { ok: false, reason: 'inclusion_path exhausted before the root' };
  if (!r.equals(expectedRoot)) {
    return { ok: false, reason: 'computed root does not match the checkpoint root_hash' };
  }
  return { ok: true };
}

/**
 * §9.2: verify an RFC 6962 consistency proof (RFC 9162 §2.1.4.2) between the
 * verifier's RETAINED root at `first` and the checkpointed root at `second`.
 * A failure between two signature-valid checkpoints of one log_id is
 * cryptographic evidence that the registry rewrote logged history.
 */
export function verifyConsistencyPath(
  first: number,
  second: number,
  consistencyPath: readonly string[],
  firstRootHash: string,
  secondRootHash: string,
): VerifyOutcome {
  const firstRoot = wireHashToBuf(firstRootHash);
  const secondRoot = wireHashToBuf(secondRootHash);
  if (firstRoot === null || secondRoot === null) {
    return { ok: false, reason: 'malformed retained/checkpoint root hash' };
  }
  if (!Number.isInteger(first) || !Number.isInteger(second) || first < 0 || second < 0) {
    return { ok: false, reason: 'tree sizes must be non-negative integers' };
  }
  // Step 1: identical sizes — the path must be empty and the roots equal.
  if (first === second) {
    if (consistencyPath.length !== 0) {
      return { ok: false, reason: 'consistency_path must be empty when first == second' };
    }
    return firstRoot.equals(secondRoot)
      ? { ok: true }
      : { ok: false, reason: 'same tree_size but different root_hash (split view)' };
  }
  // Step 2.
  if (first === 0 || first > second || consistencyPath.length === 0) {
    return { ok: false, reason: 'invalid consistency proof shape (first==0, first>second, or empty path)' };
  }

  const rawPath: Buffer[] = [];
  for (const element of consistencyPath) {
    const p = wireHashToBuf(element);
    if (p === null) return { ok: false, reason: 'malformed consistency_path element' };
    rawPath.push(p);
  }
  // Step 3: when `first` is an exact power of two, prepend the retained root.
  const path = isPowerOfTwo(first) ? [firstRoot, ...rawPath] : rawPath;

  // Step 4.
  let fn = BigInt(first) - 1n;
  let sn = BigInt(second) - 1n;
  while (fn % 2n === 1n) {
    fn >>= 1n;
    sn >>= 1n;
  }
  // Step 5.
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0n) return { ok: false, reason: 'consistency_path longer than the tree height' };
    if (fn % 2n === 1n || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (fn % 2n === 0n) {
        while (fn % 2n === 0n && fn !== 0n) {
          fn >>= 1n;
          sn >>= 1n;
        }
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  // Step 6.
  if (!fr.equals(firstRoot)) {
    return { ok: false, reason: 'folded first root does not match the retained root (history rewrite)' };
  }
  if (!sr.equals(secondRoot)) {
    return { ok: false, reason: 'folded second root does not match the checkpoint root (history rewrite)' };
  }
  if (sn !== 0n) return { ok: false, reason: 'consistency_path exhausted before the root' };
  return { ok: true };
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

// ── Leaf reconstruction, §4 / §9.1 step 1 ────────────────────────────────

/**
 * Build the §4 leaf object from a stored RFC-ACDP-0010 receipt: every leaf
 * field other than `receipt_hash` duplicates a receipt field, and
 * `receipt_hash` is the receipt's §2 preimage hash (JCS(receipt − signature)
 * — signature excluded, so the one sanctioned §9 re-mint never changes it).
 *
 * The receipt here is the control plane's OWN stored copy from the ingested
 * publish event (never a registry echo), and its signature is verified
 * independently by the receipt-audit sweep — the two verdicts stay
 * independent per §9.3.
 */
export function buildLogLeaf(
  receipt: Record<string, unknown>,
): { ok: true; leaf: Record<string, unknown> } | { ok: false; reason: string } {
  const fields = [
    'ctx_id',
    'lineage_id',
    'origin_registry',
    'created_at',
    'content_hash',
    'key_fingerprint',
  ] as const;
  for (const f of fields) {
    if (typeof receipt[f] !== 'string' || (receipt[f] as string).length === 0) {
      return { ok: false, reason: `receipt has no usable '${f}' to build the log leaf` };
    }
  }
  const { signature: _omit, ...preimageObj } = receipt;
  let canonical: string;
  try {
    canonical = AcdpCanonicalizer.canonicalize(JSON.stringify(preimageObj));
  } catch {
    return { ok: false, reason: 'receipt could not be canonicalized (JCS)' };
  }
  const receiptHash =
    'sha256:' + createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');
  return {
    ok: true,
    leaf: {
      leaf_version: 'acdp-log-leaf/1',
      ctx_id: receipt.ctx_id,
      lineage_id: receipt.lineage_id,
      origin_registry: receipt.origin_registry,
      created_at: receipt.created_at,
      content_hash: receipt.content_hash,
      key_fingerprint: receipt.key_fingerprint,
      receipt_hash: receiptHash,
    },
  };
}

// ── Proof-response parsing, §8.2 ─────────────────────────────────────────

export interface InclusionProof {
  log_id: string;
  leaf_index: number;
  tree_size: number;
  inclusion_path: string[];
  log_checkpoint: unknown;
}

export interface ConsistencyProof {
  log_id: string;
  first_tree_size: number;
  second_tree_size: number;
  consistency_path: string[];
  log_checkpoint: unknown;
}

export function parseInclusionProof(
  raw: unknown,
): { ok: true; proof: InclusionProof } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'inclusion proof is not a JSON object' };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.log_id !== 'string') return { ok: false, reason: 'proof has no log_id' };
  if (!Number.isInteger(o.leaf_index) || (o.leaf_index as number) < 0) {
    return { ok: false, reason: 'proof leaf_index must be an integer >= 0' };
  }
  if (!Number.isInteger(o.tree_size) || (o.tree_size as number) < 0) {
    return { ok: false, reason: 'proof tree_size must be an integer >= 0' };
  }
  if (!isWireHashArray(o.inclusion_path)) {
    return { ok: false, reason: 'proof inclusion_path must be an array of sha256 wire hashes' };
  }
  if (o.log_checkpoint === null || typeof o.log_checkpoint !== 'object') {
    return { ok: false, reason: 'proof carries no log_checkpoint' };
  }
  return { ok: true, proof: o as unknown as InclusionProof };
}

export function parseConsistencyProof(
  raw: unknown,
): { ok: true; proof: ConsistencyProof } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'consistency proof is not a JSON object' };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.log_id !== 'string') return { ok: false, reason: 'proof has no log_id' };
  if (!Number.isInteger(o.first_tree_size) || (o.first_tree_size as number) < 0) {
    return { ok: false, reason: 'proof first_tree_size must be an integer >= 0' };
  }
  if (!Number.isInteger(o.second_tree_size) || (o.second_tree_size as number) < 0) {
    return { ok: false, reason: 'proof second_tree_size must be an integer >= 0' };
  }
  if (!isWireHashArray(o.consistency_path)) {
    return { ok: false, reason: 'proof consistency_path must be an array of sha256 wire hashes' };
  }
  if (o.log_checkpoint === null || typeof o.log_checkpoint !== 'object') {
    return { ok: false, reason: 'proof carries no log_checkpoint' };
  }
  return { ok: true, proof: o as unknown as ConsistencyProof };
}

function isWireHashArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string' && WIRE_HASH_RE.test(e));
}

// ── §9.1 / §9.2 fold: native binding (0.6.0+) with a host TS fallback ─────
//
// The wrappers below are what the checkpoint witness and the inclusion-audit
// sweep call. Callers supply the parsed proof, the already signature-verified
// checkpoint, and (for inclusion) the leaf reconstructed from OUR stored
// receipt — the JSON surface the binding speaks — so `sdkHasLogSurface()`
// picks the Rust fold vs the host arithmetic transparently.

/**
 * §9.1 steps 2, 5, 6 — hash the reconstructed leaf, bind the proof to the
 * checkpoint, fold the audit path, compare against the checkpoint root.
 *
 * Native (0.6.0+): `AcdpVerifier.verifyLogInclusion`. Fallback: the host
 * §5.1 leaf hash + the RFC 6962 fold in {@link verifyInclusionPath}. Both
 * consume the SAME checkpoint `root_hash`, so the verdict is identical.
 */
export function verifyInclusion(
  proof: InclusionProof,
  checkpoint: LogCheckpoint,
  leaf: Record<string, unknown>,
): VerifyOutcome {
  if (sdkHasLogSurface()) return nativeVerifyInclusion(proof, checkpoint, leaf);
  return tsVerifyInclusion(proof, checkpoint, leaf);
}

/** The native-binding branch of {@link verifyInclusion} (exported for the parity cross-check). */
export function nativeVerifyInclusion(
  proof: InclusionProof,
  checkpoint: LogCheckpoint,
  leaf: Record<string, unknown>,
): VerifyOutcome {
  const surface = AcdpVerifier as unknown as LogCapableVerifier;
  return nativeVerdict(() =>
    surface.verifyLogInclusion(
      JSON.stringify(stripEmbeddedCheckpoint(proof)),
      JSON.stringify(checkpoint),
      JSON.stringify(leaf),
    ),
  );
}

/** The host-arithmetic branch of {@link verifyInclusion} (exported for the parity cross-check). */
export function tsVerifyInclusion(
  proof: InclusionProof,
  checkpoint: LogCheckpoint,
  leaf: Record<string, unknown>,
): VerifyOutcome {
  const leafH = leafHash(leaf);
  if (leafH === null) {
    return { ok: false, reason: 'reconstructed leaf could not be canonicalized (JCS)' };
  }
  return verifyInclusionPath(
    proof.leaf_index,
    proof.tree_size,
    leafH,
    proof.inclusion_path,
    checkpoint.root_hash,
  );
}

/**
 * §9.2 — prove the retained tree at `firstRootHash` (size
 * `proof.first_tree_size`) is a prefix of the checkpointed later tree.
 *
 * Native (0.6.0+): `AcdpVerifier.verifyLogConsistency`. Fallback: the RFC
 * 6962 consistency fold in {@link verifyConsistencyPath}. Both take the
 * retained root and the checkpoint's `root_hash` as the two anchors.
 */
export function verifyConsistency(
  proof: ConsistencyProof,
  checkpoint: LogCheckpoint,
  firstRootHash: string,
): VerifyOutcome {
  if (sdkHasLogSurface()) return nativeVerifyConsistency(proof, checkpoint, firstRootHash);
  return tsVerifyConsistency(proof, checkpoint, firstRootHash);
}

/** The native-binding branch of {@link verifyConsistency} (exported for the parity cross-check). */
export function nativeVerifyConsistency(
  proof: ConsistencyProof,
  checkpoint: LogCheckpoint,
  firstRootHash: string,
): VerifyOutcome {
  const surface = AcdpVerifier as unknown as LogCapableVerifier;
  return nativeVerdict(() =>
    surface.verifyLogConsistency(
      JSON.stringify(stripEmbeddedCheckpoint(proof)),
      JSON.stringify(checkpoint),
      firstRootHash,
    ),
  );
}

/** The host-arithmetic branch of {@link verifyConsistency} (exported for the parity cross-check). */
export function tsVerifyConsistency(
  proof: ConsistencyProof,
  checkpoint: LogCheckpoint,
  firstRootHash: string,
): VerifyOutcome {
  return verifyConsistencyPath(
    proof.first_tree_size,
    proof.second_tree_size,
    proof.consistency_path,
    firstRootHash,
    checkpoint.root_hash,
  );
}
