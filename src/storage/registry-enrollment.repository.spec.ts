import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { RegistryEnrollmentRepository } from './registry-enrollment.repository';

/**
 * Unit coverage of the enrollment upsert's tenant-immutability contract
 * (tenant-enroll-quota-fix P1). The real-Postgres behaviour (atomic reject,
 * concurrent first-enrolls) is pinned by the ingest-trust integration spec;
 * this spec pins the SHAPE of the statement handed to drizzle.
 */
describe('RegistryEnrollmentRepository.upsert', () => {
  function setup(returned: unknown[]) {
    const chain = {
      values: jest.fn(),
      onConflictDoUpdate: jest.fn(),
      returning: jest.fn().mockResolvedValue(returned),
    };
    chain.values.mockReturnValue(chain);
    chain.onConflictDoUpdate.mockReturnValue(chain);
    const db = { insert: jest.fn().mockReturnValue(chain) };
    const repo = new RegistryEnrollmentRepository({ db } as never);
    return { repo, chain };
  }

  it('never writes tenantId on the conflict branch and guards it with setWhere', async () => {
    const { repo, chain } = setup([{ authority: 'reg.example', tenantId: 'tenant-x' }]);
    await repo.upsert({ authority: 'reg.example', tenantId: 'tenant-x' });

    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ authority: 'reg.example', tenantId: 'tenant-x' }),
    );
    const cfg = chain.onConflictDoUpdate.mock.calls[0][0] as {
      set: Record<string, unknown>;
      setWhere: SQL;
    };
    expect(cfg.set).not.toHaveProperty('tenantId');
    const rendered = new PgDialect().sqlToQuery(cfg.setWhere).sql;
    expect(rendered).toBe('"registry_enrollments"."tenant_id" = excluded.tenant_id');
  });

  it('returns the row on insert / same-tenant update', async () => {
    const row = { authority: 'reg.example', tenantId: 'tenant-x' };
    const { repo } = setup([row]);
    await expect(repo.upsert({ authority: 'reg.example', tenantId: 'tenant-x' })).resolves.toBe(
      row,
    );
  });

  it('returns null when RETURNING is empty (authority bound to another tenant)', async () => {
    const { repo } = setup([]);
    await expect(
      repo.upsert({ authority: 'reg.example', tenantId: 'tenant-y' }),
    ).resolves.toBeNull();
  });
});
