/**
 * Boot must refuse a non-strict Ed25519 verifier (RFC-ACDP-0001 §5.10) before
 * touching config, the database or the network.
 */
import { bootstrap } from './bootstrap';

// A binding that accepts everything (non-strict). The native class's statics are
// read-only, so the module is replaced wholesale rather than spied on.
jest.mock('@agentcontextdistributionprotocol/acdp', () => {
  const actual = jest.requireActual('@agentcontextdistributionprotocol/acdp');
  return {
    ...actual,
    AcdpVerifier: new Proxy({}, {
      get: (_target, prop) =>
        prop === 'verifySignature' ? () => true : actual.AcdpVerifier[prop],
    }),
  };
});

describe('bootstrap strict-Ed25519 gate', () => {
  it('rejects with the §5.10 / sig-004 message when the binding is non-strict', async () => {
    await expect(bootstrap()).rejects.toThrow(/sig-004/);
  });
});
