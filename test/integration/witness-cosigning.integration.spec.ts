/**
 * ACDP 0.4.0 — transparency-log witness COSIGNING (RFC-ACDP-0015) integration
 * coverage against a real Postgres + the real app graph:
 *
 *   1. Migration 0017 + LogCosignatureRepository round-trips: idempotent
 *      per-(witness,log,size,root) persist, list filters, covered_logs.
 *   2. GET /log/witness serves this witness's cosignatures (most-recent first),
 *      filtered by ?log_id / ?tree_size; malformed params → schema_violation.
 *   3. GET /.well-known/acdp-witness.json — witness capabilities (§9), with
 *      covered_logs reflecting what the witness has actually cosigned.
 *   4. GET /.well-known/did.json — the witness DID document, whose
 *      assertionMethod key RESOLVES through the SDK (the §8 step-2 path a
 *      consumer uses to verify a cosignature).
 */
import { AcdpDidDocument } from '@agentcontextdistributionprotocol/acdp';
import { mintCosignature } from '../../src/audit/cosign';
import { generateEd25519Pem } from '../../src/auth/jwt-signing';
import { LogCosignatureRepository } from '../../src/storage/log-cosignature.repository';
import { WitnessSigningService } from '../../src/witness/witness-signing.service';
import { createTestApp, TestAppContext } from '../helpers/test-app';

const WITNESS_ID = 'did:web:witness.example.org';
const KEY_ID = `${WITNESS_ID}#witness-key-1`;
const LOG_ID = 'did:web:registry.example.com/log/1';
const OTHER_LOG = 'did:web:registry-b.example/log/1';
const ROOT_5 = 'sha256:0b5978172c671ca050b44790a749b18fc29d58a7a17495fbb4e0f86eb885f731';
const ROOT_3 = 'sha256:' + '3'.repeat(64);
const WITNESS_PEM = generateEd25519Pem().privatePem;

function makeCosignRow(
  signing: WitnessSigningService,
  logId: string,
  treeSize: number,
  root: string,
  witnessedAt: string = new Date().toISOString(),
) {
  const minted = mintCosignature(
    { log_id: logId, tree_size: treeSize, root_hash: root, timestamp: '2026-07-04T12:00:00.000Z' },
    witnessedAt,
    signing.signer!,
  );
  if (!minted.ok) throw new Error(minted.reason);
  const c = minted.cosignature;
  return {
    tenantId: 'default',
    witnessId: c.witness_id,
    registryAuthority: 'registry.example.com',
    logId: c.witnessed_checkpoint.log_id,
    treeSize: c.witnessed_checkpoint.tree_size,
    rootHash: c.witnessed_checkpoint.root_hash,
    timestamp: c.witnessed_checkpoint.timestamp,
    witnessedAt: c.witnessed_at,
    keyId: c.signature.key_id,
    cosignatureHash: minted.cosignatureHash,
    signatureValue: c.signature.value,
    cosignature: c as unknown as Record<string, unknown>,
  };
}

describe('transparency-log witness cosigning (integration)', () => {
  let ctx: TestAppContext;
  let repo: LogCosignatureRepository;
  let signing: WitnessSigningService;

  beforeAll(async () => {
    process.env.WITNESS_COSIGNING_ENABLED = 'true';
    process.env.WITNESS_ID = WITNESS_ID;
    process.env.WITNESS_SIGNING_PRIVATE_KEY_PEM = WITNESS_PEM;
    ctx = await createTestApp();
    repo = ctx.module.get(LogCosignatureRepository);
    signing = ctx.module.get(WitnessSigningService);
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  afterAll(async () => {
    await ctx.app.close();
    delete process.env.WITNESS_COSIGNING_ENABLED;
    delete process.env.WITNESS_ID;
    delete process.env.WITNESS_SIGNING_PRIVATE_KEY_PEM;
  });

  it('persists cosignatures (fresh re-mint on re-observation, B1) and lists them (repo round-trip)', async () => {
    const first = await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5, '2026-07-04T12:00:00.000Z'));
    expect(first).not.toBeNull();
    // B1: re-observing the same head with a FRESH witnessed_at mints a new
    // row — migration 0020 widened the unique key to include witnessed_at
    // precisely so this is no longer a dedup no-op.
    const remint = await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5, '2026-07-04T12:05:00.000Z'));
    expect(remint).not.toBeNull();
    // An EXACT witnessed_at collision is still the genuine duplicate case
    // the unique key guards against.
    const dup = await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5, '2026-07-04T12:05:00.000Z'));
    expect(dup).toBeNull();

    await repo.record(makeCosignRow(signing, LOG_ID, 3, ROOT_3));
    await repo.record(makeCosignRow(signing, OTHER_LOG, 5, ROOT_5));

    // list() defaults to the collapsed "latest per distinct head" view — the
    // two log/5/ROOT_5 observations above collapse to one.
    const all = await repo.list({ witnessId: WITNESS_ID });
    expect(all).toHaveLength(3);

    const forLog = await repo.list({ witnessId: WITNESS_ID, logId: LOG_ID });
    expect(forLog.map((c) => c.treeSize).sort()).toEqual([3, 5]);

    const atSize = await repo.list({ witnessId: WITNESS_ID, logId: LOG_ID, treeSize: 5 });
    expect(atSize).toHaveLength(1);
    expect(atSize[0]!.rootHash).toBe(ROOT_5);

    expect(await repo.coveredLogs(WITNESS_ID)).toEqual([LOG_ID, OTHER_LOG].sort());
    // Raw row count, NOT the collapsed-per-head view: 2 observations of
    // (LOG_ID, 5, ROOT_5) + 1 of (LOG_ID, 3, ROOT_3) + 1 of (OTHER_LOG, 5, ROOT_5).
    expect(await repo.countForTenant('default')).toBe(4);
  });

  it('GET /log/witness serves the cosignatures, filtered by log_id/tree_size', async () => {
    await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5));
    await repo.record(makeCosignRow(signing, LOG_ID, 3, ROOT_3));
    await repo.record(makeCosignRow(signing, OTHER_LOG, 5, ROOT_5));

    const all = (await ctx.client.requestJson('GET', '/log/witness')) as {
      witness_id: string;
      witness_signatures: Array<Record<string, any>>;
    };
    expect(all.witness_id).toBe(WITNESS_ID);
    expect(all.witness_signatures).toHaveLength(3);
    // Verbatim signed objects.
    expect(all.witness_signatures[0]).toMatchObject({
      cosignature_version: 'acdp-cosig/1',
      witness_id: WITNESS_ID,
      signature: { algorithm: 'ed25519', key_id: KEY_ID },
    });

    const filtered = (await ctx.client.requestJson('GET', '/log/witness', {
      query: { log_id: LOG_ID, tree_size: 5 },
    })) as { witness_signatures: Array<Record<string, any>> };
    expect(filtered.witness_signatures).toHaveLength(1);
    expect(filtered.witness_signatures[0]!.witnessed_checkpoint).toMatchObject({
      log_id: LOG_ID,
      tree_size: 5,
      root_hash: ROOT_5,
    });
  });

  it('GET /log/witness rejects a malformed log_id / tree_size (schema_violation)', async () => {
    const badLog = await ctx.client.requestRaw('GET', '/log/witness', {
      query: { log_id: 'not-a-log-id' },
    });
    expect(badLog.status).toBe(400);
    const badSize = await ctx.client.requestRaw('GET', '/log/witness', {
      query: { tree_size: 'abc' },
    });
    expect(badSize.status).toBe(400);
  });

  it('GET /.well-known/acdp-witness.json advertises the witness capabilities', async () => {
    await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5));
    const res = await ctx.client.requestRaw('GET', '/.well-known/acdp-witness.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toEqual({
      witness_id: WITNESS_ID,
      profiles: ['acdp-log-witness'],
      covered_logs: [LOG_ID],
      cosignature_endpoint: '/log/witness',
    });
  });

  it('GET /.well-known/did.json serves a resolvable assertionMethod key', async () => {
    const res = await ctx.client.requestRaw('GET', '/.well-known/did.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/did+json');
    const doc = res.body as Record<string, unknown>;
    expect(doc.id).toBe(WITNESS_ID);
    expect(doc.assertionMethod).toEqual([KEY_ID]);

    // The assertionMethod key resolves exactly as a consumer resolves
    // signature.key_id when verifying a cosignature (RFC-ACDP-0015 §8 step 2).
    const parsed = AcdpDidDocument.parse(JSON.stringify(doc), WITNESS_ID);
    const key = parsed.keyForAlgorithm(KEY_ID, 'ed25519');
    expect(key.publicKeyB64).toBe(signing.publicKeyB64);
  });

  it('B1: re-observing an unchanged head mints distinct rows (migration 0020 widened key)', async () => {
    const t1 = '2026-07-04T12:00:00.000Z';
    const t2 = '2026-07-04T12:05:00.000Z';
    const first = await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5, t1));
    const second = await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5, t2));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.witnessedAt).not.toBe(second!.witnessedAt);

    // The exact-millisecond collision is still guarded (defense in depth):
    // re-observing at the SAME witnessed_at is a true no-op.
    const dup = await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5, t2));
    expect(dup).toBeNull();
  });

  it('B11: list() default view collapses to the latest cosignature per distinct head; all=true serves the full series', async () => {
    const t1 = '2026-07-04T12:00:00.000Z';
    const t2 = '2026-07-04T12:05:00.000Z';
    const t3 = '2026-07-04T12:10:00.000Z';
    await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5, t1));
    await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5, t2));
    await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5, t3));
    await repo.record(makeCosignRow(signing, LOG_ID, 3, ROOT_3, t1));

    const collapsed = await repo.list({ witnessId: WITNESS_ID });
    // One row per distinct (log_id, tree_size, root_hash) — the newest.
    expect(collapsed).toHaveLength(2);
    const head5 = collapsed.find((c) => c.treeSize === 5);
    expect(Date.parse(head5!.witnessedAt)).toBe(Date.parse(t3));

    const full = await repo.list({ witnessId: WITNESS_ID, all: true });
    expect(full).toHaveLength(4);

    const filtered = await repo.list({ witnessId: WITNESS_ID, logId: LOG_ID, treeSize: 5, all: true });
    expect(filtered.map((c) => Date.parse(c.witnessedAt)).sort()).toEqual(
      [t1, t2, t3].map((t) => Date.parse(t)).sort(),
    );
  });

  it('GET /log/witness?all=true serves the full per-observation series', async () => {
    const t1 = '2026-07-04T12:00:00.000Z';
    const t2 = '2026-07-04T12:05:00.000Z';
    await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5, t1));
    await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5, t2));

    const collapsed = (await ctx.client.requestJson('GET', '/log/witness')) as {
      witness_signatures: Array<Record<string, any>>;
    };
    expect(collapsed.witness_signatures).toHaveLength(1);

    const full = (await ctx.client.requestJson('GET', '/log/witness', {
      query: { all: 'true' },
    })) as { witness_signatures: Array<Record<string, any>> };
    expect(full.witness_signatures).toHaveLength(2);
  });

  it('purgeOldPerTuple keeps the newest N-1 plus the oldest row unconditionally, purging only aged middle rows', async () => {
    const times = [
      '2020-01-01T00:00:00.000Z', // oldest — kept unconditionally (anti-backdating)
      '2020-01-02T00:00:00.000Z', // aged middle — purged
      '2020-01-03T00:00:00.000Z', // aged middle — purged
      '2026-07-04T11:58:00.000Z', // recent — kept (newest N-1)
      '2026-07-04T12:00:00.000Z', // newest — kept
    ];
    for (const t of times) {
      const row = await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5, t));
      expect(row).not.toBeNull();
    }
    const cutoff = '2026-01-01T00:00:00.000Z';
    const purged = await repo.purgeOldPerTuple(cutoff, 3); // keep newest 2 + oldest 1
    expect(purged).toBe(2);

    const remaining = (await repo.list({ witnessId: WITNESS_ID, all: true })).map((c) =>
      Date.parse(c.witnessedAt),
    );
    expect(remaining.sort()).toEqual(
      ['2020-01-01T00:00:00.000Z', '2026-07-04T11:58:00.000Z', '2026-07-04T12:00:00.000Z']
        .map((t) => Date.parse(t))
        .sort(),
    );
  });
});
