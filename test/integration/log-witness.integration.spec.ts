/**
 * ACDP 0.3.0 Tier 3 — transparency-log checkpoint witness (RFC-ACDP-0012)
 * integration coverage:
 *
 *   1. Migration 0016 + repository round-trips against a real Postgres:
 *      witnessed-checkpoint evidence rows (unique-head dedup), cursor
 *      advance / alert / failure transitions — and the invariant that an
 *      alert NEVER clobbers the retained head.
 *   2. GET /registries/:authority/log-witness surfaces the witnessed
 *      checkpoints + alert state (404 for a never-witnessed authority).
 *   3. GET /dashboard/overview carries the logWitness tile.
 *   4. The sweeps run inside the real app graph: the witness pass skips an
 *      unreachable registry (capabilities unreadable — no alert, no crash),
 *      and the inclusion cross-check seals an `error` verdict for a
 *      receipt-bearing publish from an unreachable registry (the harness
 *      registry is not a real host — real cryptographic proof verification
 *      is covered in src/audit/*.spec.ts with generated trees).
 */
import { CheckpointWitnessPollerService } from '../../src/audit/checkpoint-witness.service';
import { LogInclusionAuditService } from '../../src/audit/log-inclusion-audit.service';
import { DatabaseService } from '../../src/db/database.service';
import { logInclusionAudits } from '../../src/db/schema';
import { LogWitnessRepository } from '../../src/storage/log-witness.repository';
import { RegistryEnrollmentRepository } from '../../src/storage/registry-enrollment.repository';
import { createTestApp, TestAppContext } from '../helpers/test-app';

const SECRET = 'integration-test-secret';
const AUTHORITY = 'registry-a.example';
const LOG_ID = `did:web:${AUTHORITY}/log/1`;
const ROOT_3 = 'sha256:' + '1'.repeat(64);
const ROOT_5 = 'sha256:' + '2'.repeat(64);

function checkpointRow(treeSize: number, rootHash: string) {
  return {
    tenantId: 'default',
    registryAuthority: AUTHORITY,
    logId: LOG_ID,
    treeSize,
    rootHash,
    timestamp: '2026-07-05T00:00:00.000Z',
    rawCheckpoint: {
      checkpoint_version: 'acdp-log/1',
      log_id: LOG_ID,
      tree_size: treeSize,
      root_hash: rootHash,
      timestamp: '2026-07-05T00:00:00.000Z',
      signature: { algorithm: 'ed25519', key_id: `did:web:${AUTHORITY}#receipt-key-1`, value: 'c2ln' },
    },
    signatureValid: true,
    consistencyOk: treeSize === 3 ? null : true,
  };
}

describe('transparency-log checkpoint witness (integration)', () => {
  let ctx: TestAppContext;
  let witnessRepo: LogWitnessRepository;

  beforeAll(async () => {
    ctx = await createTestApp({ webhookSecret: SECRET });
    witnessRepo = ctx.module.get(LogWitnessRepository);
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('persists witnessed checkpoints (unique-head dedup) and cursor transitions', async () => {
    const first = await witnessRepo.recordCheckpoint(checkpointRow(3, ROOT_3));
    expect(first).not.toBeNull();
    // Re-witnessing the same head is a no-op (evidence row is append-once).
    const dup = await witnessRepo.recordCheckpoint(checkpointRow(3, ROOT_3));
    expect(dup).toBeNull();
    // A DIFFERENT root at the same size persists — that pair IS the evidence.
    const splitView = await witnessRepo.recordCheckpoint(checkpointRow(3, ROOT_5));
    expect(splitView).not.toBeNull();

    await witnessRepo.advanceCursor({
      tenantId: 'default',
      authority: AUTHORITY,
      logId: LOG_ID,
      treeSize: 3,
      rootHash: ROOT_3,
    });
    let cursor = await witnessRepo.getCursor('default', AUTHORITY);
    expect(cursor).toMatchObject({
      logId: LOG_ID,
      lastWitnessedSize: 3,
      lastRootHash: ROOT_3,
      alerted: false,
      consecutiveFailures: 0,
    });

    // An alert marks state but NEVER clobbers the retained head (the §9.2
    // first_root / forensic anchor).
    const transition = await witnessRepo.markAlert({
      tenantId: 'default',
      authority: AUTHORITY,
      reason: 'consistency_failed',
      detail: { error: 'fold failed' },
    });
    expect(transition).toEqual({ wasAlerted: false, previousReason: null });
    cursor = await witnessRepo.getCursor('default', AUTHORITY);
    expect(cursor).toMatchObject({
      alerted: true,
      lastAlertReason: 'consistency_failed',
      lastWitnessedSize: 3,
      lastRootHash: ROOT_3,
    });

    // Environmental failures count separately and also keep the head.
    await witnessRepo.markFailure('default', AUTHORITY);
    await witnessRepo.markFailure('default', AUTHORITY);
    cursor = await witnessRepo.getCursor('default', AUTHORITY);
    expect(cursor).toMatchObject({ consecutiveFailures: 2, lastRootHash: ROOT_3 });

    // A later full success clears alert + failure state.
    await witnessRepo.advanceCursor({
      tenantId: 'default',
      authority: AUTHORITY,
      logId: LOG_ID,
      treeSize: 5,
      rootHash: ROOT_5,
    });
    cursor = await witnessRepo.getCursor('default', AUTHORITY);
    expect(cursor).toMatchObject({
      alerted: false,
      lastAlertReason: null,
      consecutiveFailures: 0,
      lastWitnessedSize: 5,
    });
  });

  it('GET /registries/:authority/log-witness returns checkpoints + alert state', async () => {
    await witnessRepo.recordCheckpoint(checkpointRow(3, ROOT_3));
    await witnessRepo.recordCheckpoint({ ...checkpointRow(5, ROOT_5), consistencyOk: false });
    await witnessRepo.advanceCursor({
      tenantId: 'default',
      authority: AUTHORITY,
      logId: LOG_ID,
      treeSize: 3,
      rootHash: ROOT_3,
    });
    await witnessRepo.markAlert({
      tenantId: 'default',
      authority: AUTHORITY,
      reason: 'consistency_failed',
      detail: { error: 'fold failed', previous: { tree_size: 3, root_hash: ROOT_3 } },
    });

    const res = (await ctx.client.requestJson(
      'GET',
      `/registries/${encodeURIComponent(AUTHORITY)}/log-witness`,
    )) as Record<string, any>;
    expect(res.authority).toBe(AUTHORITY);
    expect(res.logId).toBe(LOG_ID);
    expect(res.lastWitnessedSize).toBe(3);
    expect(res.lastRootHash).toBe(ROOT_3);
    expect(res.alert).toMatchObject({ alerted: true, reason: 'consistency_failed' });
    expect(res.alert.detail).toMatchObject({ error: 'fold failed' });
    expect(res.total).toBe(2);
    const sizes = (res.checkpoints as Array<{ treeSize: number }>).map((c) => c.treeSize).sort();
    expect(sizes).toEqual([3, 5]);
  });

  it('GET /registries/:authority/log-witness is 404 for a never-witnessed authority', async () => {
    const res = await ctx.client.requestRaw('GET', '/registries/ghost.example/log-witness');
    expect(res.status).toBe(404);
    expect((res.body as { errorCode?: string }).errorCode).toBe('REGISTRY_NOT_FOUND');
  });

  it('dashboard overview carries the logWitness tile (witnessed logs + active alerts)', async () => {
    await witnessRepo.recordCheckpoint(checkpointRow(3, ROOT_3));
    await witnessRepo.markAlert({
      tenantId: 'default',
      authority: AUTHORITY,
      reason: 'root_mismatch',
      detail: { error: 'split view' },
    });

    const overview = (await ctx.client.requestJson('GET', '/dashboard/overview')) as {
      logWitness: { witnessedLogs: number; activeAlerts: number };
    };
    expect(overview.logWitness).toEqual({ witnessedLogs: 1, activeAlerts: 1 });
  });

  it('the witness sweep runs in the real app graph and skips an unreachable registry', async () => {
    const enrollments = ctx.module.get(RegistryEnrollmentRepository);
    await enrollments.upsert({
      authority: AUTHORITY,
      baseUrl: `https://${AUTHORITY}`,
      enabled: true,
    });

    const witness = ctx.module.get(CheckpointWitnessPollerService);
    const outcomes = await witness.sweep();
    // registry-a.example is not a real host: capabilities are unreadable, so
    // the pass SKIPS (tri-state null — never an alert on a guess) and the
    // loop completes without crashing.
    expect(outcomes).toEqual([
      expect.objectContaining({ authority: AUTHORITY, status: 'skipped' }),
    ]);
    expect(await witnessRepo.getCursor('default', AUTHORITY)).toBeNull();
  });

  it('the inclusion cross-check seals an error verdict for a receipt-bearing publish from an unreachable registry', async () => {
    const ctxId = `acdp://${AUTHORITY}/ctx-log-1`;
    const receipt = {
      registry_did: `did:web:${AUTHORITY}`,
      ctx_id: ctxId,
      lineage_id: 'lineage-001',
      origin_registry: AUTHORITY,
      created_at: '2026-07-05T00:00:00.000Z',
      content_hash: 'sha256:' + 'a'.repeat(64),
      key_fingerprint: 'sha256:' + 'b'.repeat(64),
      signature: {
        algorithm: 'ed25519',
        key_id: `did:web:${AUTHORITY}#receipt-key-1`,
        value: 'c2ln',
      },
    };
    const res = await ctx.client.ingest(
      {
        type: 'context_published',
        event_id: 'evt-log-1',
        ctx_id: ctxId,
        lineage_id: 'lineage-001',
        agent_id: 'did:web:agent-1.example',
        context_type: 'analysis',
        visibility: 'public',
        version: 1,
        derived_from: [],
        registry_authority: AUTHORITY,
        registry_base_url: `https://${AUTHORITY}`,
        created_at: '2026-07-05T00:00:00.000Z',
        key_fingerprint: receipt.key_fingerprint,
        registry_receipt: receipt,
      },
      { runId: 'run-log-1', secret: SECRET },
    );
    expect(res.status).toBe(204);

    const sweeper = ctx.module.get(LogInclusionAuditService);
    const audited = await sweeper.sweep();
    expect(audited).toBe(1);

    const db = ctx.module.get(DatabaseService);
    const rows = await db.db.select().from(logInclusionAudits);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ctxId,
      registryAuthority: AUTHORITY,
      status: 'error', // capabilities probe unreachable — environmental, not a flag
      runId: 'run-log-1',
    });
    expect(rows[0]!.detail.join(' ')).toContain('unverified');

    // The verdict is sealed once: a second sweep audits nothing new.
    expect(await sweeper.sweep()).toBe(0);
  });
});
