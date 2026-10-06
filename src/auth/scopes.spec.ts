import { parseScopeString, readScopes } from './scopes';

describe('readScopes', () => {
  it('reads each of scope / scopes / scp', () => {
    expect(readScopes({ scope: 'a b' })).toEqual(['a', 'b']);
    expect(readScopes({ scopes: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(readScopes({ scp: 'a b' })).toEqual(['a', 'b']);
    expect(readScopes({ scp: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(readScopes({ scope: ['a'] })).toEqual(['a']);
  });

  it('returns the order-preserving, de-duplicated union', () => {
    expect(readScopes({ scp: 'a b', scope: 'b c' })).toEqual(['b', 'c', 'a']);
    expect(readScopes({ scope: 'a', scopes: ['a', 'd'], scp: 'd e' })).toEqual(['a', 'd', 'e']);
  });

  it('ignores non-string and empty members, and tolerates odd whitespace', () => {
    expect(readScopes({ scopes: ['a', 7, null, '', 'b'] })).toEqual(['a', 'b']);
    expect(readScopes({ scope: '  a \t b\n' })).toEqual(['a', 'b']);
    expect(readScopes({ scope: 5, scopes: 'x' as unknown })).toEqual(['x']);
  });

  it('returns [] when no scope claim (e.g. an ACDP registry token) or non-object claims', () => {
    expect(readScopes({ sub: 'did:web:x' })).toEqual([]);
    expect(readScopes(undefined)).toEqual([]);
    expect(readScopes(null)).toEqual([]);
    expect(readScopes('scope')).toEqual([]);
  });
});

describe('parseScopeString', () => {
  it('splits a configured required-scope string', () => {
    expect(parseScopeString('publish read')).toEqual(['publish', 'read']);
    expect(parseScopeString(undefined)).toEqual([]);
    expect(parseScopeString('')).toEqual([]);
  });
});
