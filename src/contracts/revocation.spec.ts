import {
  isRevocationContextType,
  REVOCATION_CONTEXT_TYPE,
  REVOCATION_CONTEXT_TYPE_INTERIM,
  REVOCATION_CONTEXT_TYPES,
} from './revocation';

describe('isRevocationContextType (RFC-ACDP-0014 §4, §10)', () => {
  it('is true for the standard spelling', () => {
    expect(isRevocationContextType('key-revocation')).toBe(true);
    expect(isRevocationContextType(REVOCATION_CONTEXT_TYPE)).toBe(true);
  });

  it('is true for the interim spelling', () => {
    expect(isRevocationContextType('acdp:key-revocation')).toBe(true);
    expect(isRevocationContextType(REVOCATION_CONTEXT_TYPE_INTERIM)).toBe(true);
  });

  it('is false for every base ACDP type', () => {
    for (const t of ['data_snapshot', 'analysis', 'prediction', 'alert']) {
      expect(isRevocationContextType(t)).toBe(false);
    }
  });

  it('is false for a case-folded variant — context types are never case-folded', () => {
    expect(isRevocationContextType('Key-Revocation')).toBe(false);
    expect(isRevocationContextType('KEY-REVOCATION')).toBe(false);
  });

  it('is false for a near-miss spelling', () => {
    expect(isRevocationContextType('acdp:key_revocation')).toBe(false);
    expect(isRevocationContextType('key_revocation')).toBe(false);
    expect(isRevocationContextType('key-revocations')).toBe(false);
  });

  it('is false for an empty or unrelated string', () => {
    expect(isRevocationContextType('')).toBe(false);
    expect(isRevocationContextType('context_published')).toBe(false);
  });

  it('REVOCATION_CONTEXT_TYPES contains exactly the two spellings', () => {
    expect([...REVOCATION_CONTEXT_TYPES].sort()).toEqual(
      ['acdp:key-revocation', 'key-revocation'].sort(),
    );
  });
});
