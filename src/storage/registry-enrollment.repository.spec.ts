import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  buildEnrollmentUpdateSet,
  EnrollRegistryInput,
  RegistryEnrollmentRepository,
} from './registry-enrollment.repository';

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

/**
 * PATCH-like re-enroll (tenant-enroll-quota-fix P2): the conflict-branch SET
 * omits a key for an `undefined` input, writes NULL for an explicit `null`,
 * and the value otherwise. `enabled` (NOT NULL) is only ever written as a
 * boolean. `updatedAt` always; `tenantId`/`createdAt` never.
 */
describe('buildEnrollmentUpdateSet', () => {
  const NOW = '2026-10-09T00:00:00.000Z';
  const base: EnrollRegistryInput = { authority: 'reg.example', tenantId: 'tenant-x' };
  const VALUES = {
    baseUrl: 'https://reg.example',
    registryDid: 'did:web:reg.example',
    webhookSecret: 'a-sixteen-char-secret',
  } as const;

  describe.each(Object.keys(VALUES) as Array<keyof typeof VALUES>)('%s', (field) => {
    it('undefined → key absent (stored value kept)', () => {
      const set = buildEnrollmentUpdateSet({ ...base, [field]: undefined }, NOW);
      expect(Object.prototype.hasOwnProperty.call(set, field)).toBe(false);
    });

    it('null → NULL written (cleared)', () => {
      const set = buildEnrollmentUpdateSet({ ...base, [field]: null }, NOW);
      expect(Object.prototype.hasOwnProperty.call(set, field)).toBe(true);
      expect(set[field]).toBeNull();
    });

    it('value → value written', () => {
      const set = buildEnrollmentUpdateSet({ ...base, [field]: VALUES[field] }, NOW);
      expect(set[field]).toBe(VALUES[field]);
    });
  });

  it.each([
    [undefined, false, undefined],
    [null, false, undefined],
    [true, true, true],
    [false, true, false],
  ])('enabled %p → present=%p value=%p (never NULL)', (enabled, present, value) => {
    const set = buildEnrollmentUpdateSet({ ...base, enabled }, NOW);
    expect(Object.prototype.hasOwnProperty.call(set, 'enabled')).toBe(present);
    expect(set.enabled).toBe(value);
  });

  it('a bare re-enroll writes only updatedAt; never tenantId or createdAt', () => {
    const set = buildEnrollmentUpdateSet(base, NOW);
    expect(set).toEqual({ updatedAt: NOW });
    const full = buildEnrollmentUpdateSet({ ...base, ...VALUES, enabled: false }, NOW);
    expect(full).toEqual({ ...VALUES, enabled: false, updatedAt: NOW });
    expect(full).not.toHaveProperty('tenantId');
    expect(full).not.toHaveProperty('createdAt');
  });
});

describe('RegistryEnrollmentRepository.upsert — insert defaults vs PATCH-like update', () => {
  function capture() {
    const chain = {
      values: jest.fn(),
      onConflictDoUpdate: jest.fn(),
      returning: jest.fn().mockResolvedValue([{}]),
    };
    chain.values.mockReturnValue(chain);
    chain.onConflictDoUpdate.mockReturnValue(chain);
    const repo = new RegistryEnrollmentRepository({
      db: { insert: jest.fn().mockReturnValue(chain) },
    } as never);
    return { repo, chain };
  }

  it('insert keeps its defaults (NULLs, enabled=true) while the update set omits the fields', async () => {
    const { repo, chain } = capture();
    await repo.upsert({ authority: 'reg.example', tenantId: 'tenant-x', enabled: null });
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: null,
        registryDid: null,
        webhookSecret: null,
        enabled: true,
      }),
    );
    const { set } = chain.onConflictDoUpdate.mock.calls[0][0] as { set: Record<string, unknown> };
    expect(Object.keys(set)).toEqual(['updatedAt']);
  });

  it('passes an explicit null through to the update set', async () => {
    const { repo, chain } = capture();
    await repo.upsert({ authority: 'reg.example', tenantId: 'tenant-x', webhookSecret: null });
    const { set } = chain.onConflictDoUpdate.mock.calls[0][0] as { set: Record<string, unknown> };
    expect(set).toEqual({ webhookSecret: null, updatedAt: expect.any(String) });
  });
});
