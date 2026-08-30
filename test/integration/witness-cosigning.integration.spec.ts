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

function makeCosignRow(signing: WitnessSigningService, logId: string, treeSize: number, root: string) {
  const minted = mintCosignature(
    { log_id: logId, tree_size: treeSize, root_hash: root, timestamp: '2026-07-04T12:00:00.000Z' },
    new Date().toISOString(),
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

  it('persists cosignatures idempotently and lists them (repo round-trip)', async () => {
    const first = await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5));
    expect(first).not.toBeNull();
    // Re-observing the same (witness, log, size, root) is a no-op.
    const dup = await repo.record(makeCosignRow(signing, LOG_ID, 5, ROOT_5));
    expect(dup).toBeNull();

    await repo.record(makeCosignRow(signing, LOG_ID, 3, ROOT_3));
    await repo.record(makeCosignRow(signing, OTHER_LOG, 5, ROOT_5));

    const all = await repo.list({ witnessId: WITNESS_ID });
    expect(all).toHaveLength(3);

    const forLog = await repo.list({ witnessId: WITNESS_ID, logId: LOG_ID });
    expect(forLog.map((c) => c.treeSize).sort()).toEqual([3, 5]);

    const atSize = await repo.list({ witnessId: WITNESS_ID, logId: LOG_ID, treeSize: 5 });
    expect(atSize).toHaveLength(1);
    expect(atSize[0]!.rootHash).toBe(ROOT_5);

    expect(await repo.coveredLogs(WITNESS_ID)).toEqual([LOG_ID, OTHER_LOG].sort());
    expect(await repo.countForTenant('default')).toBe(3);
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
});
