/**
 * Canonical `authority ⇄ did:web` conversion.
 *
 * The round-trip table below is transcribed from the SDK's own
 * `acdp-did/src/web.rs` (`authority_to_did_web` / `did_web_to_authority`) and
 * from the reference registry, which builds the `capabilities.registry_did` it
 * advertises with that exact function. If these two disagree with the SDK, this
 * control plane accuses conformant registries of dishonesty.
 */
import {
  authorityToDidWeb,
  didWebToAuthority,
  nonCanonicalAuthorityReason,
} from './did-authority';

describe('authorityToDidWeb', () => {
  it('leaves a bare DNS hostname alone', () => {
    expect(authorityToDidWeb('registry.example.com')).toBe('did:web:registry.example.com');
  });

  // THE regression: a port's `:` is a structural delimiter in did:web, so it
  // MUST be percent-encoded — otherwise `8443` becomes a path segment and the
  // DID names something else entirely.
  it('percent-encodes a port as %3A', () => {
    expect(authorityToDidWeb('localhost:8443')).toBe('did:web:localhost%3A8443');
    expect(authorityToDidWeb('registry.internal:8443')).toBe(
      'did:web:registry.internal%3A8443',
    );
  });

  it('does NOT lowercase — did:web DIDs are case-sensitive on the wire', () => {
    expect(authorityToDidWeb('Registry.Example.COM')).toBe('did:web:Registry.Example.COM');
  });

  it('rejects an already-encoded authority instead of double-encoding it', () => {
    expect(authorityToDidWeb('localhost%3A8443')).toBeNull();
    expect(nonCanonicalAuthorityReason('localhost%3A8443')).toContain('percent-encoded already');
  });

  it('rejects a blank authority', () => {
    expect(authorityToDidWeb('')).toBeNull();
    expect(authorityToDidWeb('   ')).toBeNull();
    expect(nonCanonicalAuthorityReason('')).toContain('blank');
  });
});

describe('didWebToAuthority', () => {
  it('decodes %3A back to the port delimiter', () => {
    expect(didWebToAuthority('did:web:localhost%3A8443')).toBe('localhost:8443');
  });

  it('returns a bare hostname unchanged', () => {
    expect(didWebToAuthority('did:web:registry.example.com')).toBe('registry.example.com');
  });

  // web.rs:433-440 — only the FIRST colon-separated segment carries the
  // authority; everything after it is a path component.
  it('takes only the first segment of a path-bearing did:web', () => {
    expect(didWebToAuthority('did:web:example.com:users:alice')).toBe('example.com');
    expect(didWebToAuthority('did:web:localhost%3A8443:users:alice')).toBe('localhost:8443');
  });

  it('returns null for a DID that is not did:web', () => {
    expect(didWebToAuthority('did:key:z6Mk')).toBeNull();
    expect(didWebToAuthority('https://registry.example.com')).toBeNull();
  });
});

describe('authorityToDidWeb ⇄ didWebToAuthority round-trip', () => {
  it.each(['registry.example.com', 'localhost:8443', 'registry.internal:8443', 'a.b.c.d:1'])(
    'round-trips %s',
    (authority) => {
      const did = authorityToDidWeb(authority);
      expect(did).not.toBeNull();
      expect(didWebToAuthority(did!)).toBe(authority);
    },
  );
});
