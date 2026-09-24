import { crossCheckRegistryBinding } from './revocation-binding';

describe('crossCheckRegistryBinding (RFC-ACDP-0014 §6)', () => {
  it('returns ok when publisher matches both the serving authority DID and the advertised registry_did', () => {
    const result = crossCheckRegistryBinding(
      'did:web:localhost%3A8443',
      'localhost:8443',
      'did:web:localhost%3A8443',
    );
    expect(result).toEqual({ ok: true });
  });

  it('encodes a port-bearing serving authority the same way the SDK does (%3A), not a naive template', () => {
    // A naive `did:web:${authority}` template would produce
    // 'did:web:localhost:8443' here, which would never match a publisher
    // spelled the canonical way — proving the function goes through
    // authorityToDidWeb rather than string-concatenating.
    const result = crossCheckRegistryBinding(
      'did:web:localhost:8443',
      'localhost:8443',
      'did:web:localhost:8443',
    );
    expect(result.ok).toBe(false);
  });

  it('fails naming the serving-authority comparison when publisher disagrees with authorityToDidWeb(servingAuthority)', () => {
    const result = crossCheckRegistryBinding(
      'did:web:attacker.example',
      'registry.example.com',
      'did:web:registry.example.com',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/serving authority/);
      expect(result.reason).toContain('did:web:attacker.example');
      expect(result.reason).toContain('did:web:registry.example.com');
    }
  });

  it('fails naming the capabilities comparison when publisher matches the authority but not the advertised registry_did', () => {
    // Proves the second comparison is load-bearing on its own: the first
    // check alone would pass here.
    const result = crossCheckRegistryBinding(
      'did:web:registry.example.com',
      'registry.example.com',
      'did:web:some-other-registry.example.com',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/capabilities\.registry_did/);
      expect(result.reason).toContain('did:web:registry.example.com');
      expect(result.reason).toContain('did:web:some-other-registry.example.com');
    }
  });

  it('fails closed with a non-canonical-authority reason when the serving authority is already percent-encoded', () => {
    const result = crossCheckRegistryBinding(
      'did:web:localhost%3A8443',
      'localhost%3A8443',
      'did:web:localhost%3A8443',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not a canonical did:web authority/);
    }
  });

  it('fails closed with a blank-authority reason when the serving authority is empty', () => {
    const result = crossCheckRegistryBinding('did:web:registry.example.com', '', 'did:web:registry.example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/blank/);
    }
  });
});
