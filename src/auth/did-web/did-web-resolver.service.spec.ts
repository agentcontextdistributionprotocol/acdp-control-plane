 
import {
  DefaultDidFetcher,
  DidFetcher,
  DidFetchResponse,
  DidWebResolverService,
} from './did-web-resolver.service';
import { SsrfPolicy } from './ssrf-guard';

const DID = 'did:web:registry.example.com:agents:alice';
const KEY_ID = `${DID}#key-1`;
const ED25519_MB = 'z6Mkv4ScDB4iH5VWidL51TwgQbtimYf73r1vGfeaQ3eSn6S7';

function goodDoc(): unknown {
  return {
    id: DID,
    verificationMethod: [
      {
        id: KEY_ID,
        controller: DID,
        type: 'Ed25519VerificationKey2020',
        publicKeyMultibase: ED25519_MB,
      },
    ],
    assertionMethod: [KEY_ID],
  };
}

class StubFetcher implements DidFetcher {
  calls: Array<{ url: string; accept: string }> = [];
  constructor(private readonly responder: (url: string) => DidFetchResponse | Promise<DidFetchResponse>) {}
  async fetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }) {
    this.calls.push({ url, accept: init.headers.Accept ?? '' });
    return this.responder(url);
  }
}

function jsonResp(body: unknown, contentType = 'application/did+json'): DidFetchResponse {
  return {
    status: 200,
    contentType,
    body: async () => new TextEncoder().encode(JSON.stringify(body)),
  };
}

/**
 * The default SsrfPolicy.checkResolvedHost() performs a real DNS lookup,
 * which we don't want in unit tests. Subclass with a no-op override.
 */
class TestSsrfPolicy extends SsrfPolicy {
  async checkResolvedHost(): Promise<string[]> {
    return ['203.0.113.1'];
  }
}

describe('DidWebResolverService', () => {
  it('resolves a valid did:web to a public key', async () => {
    const fetcher = new StubFetcher(() => jsonResp(goodDoc()));
    const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
    const key = await svc.resolveKey(KEY_ID, 'ed25519');
    expect(key.keyId).toBe(KEY_ID);
    expect(key.algorithm).toBe('ed25519');
    expect(Buffer.from(key.publicKeyB64, 'base64').length).toBe(32);
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]!.url).toBe(
      'https://registry.example.com/agents/alice/did.json',
    );
    expect(fetcher.calls[0]!.accept).toContain('application/did+json');
  });

  it('caches resolved documents (one fetch for two resolves)', async () => {
    const fetcher = new StubFetcher(() => jsonResp(goodDoc()));
    const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
    await svc.resolveKey(KEY_ID, 'ed25519');
    await svc.resolveKey(KEY_ID, 'ed25519');
    expect(fetcher.calls).toHaveLength(1);
  });

  it('invalidate() forces a fresh fetch', async () => {
    const fetcher = new StubFetcher(() => jsonResp(goodDoc()));
    const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
    await svc.resolveKey(KEY_ID, 'ed25519');
    svc.invalidate(DID);
    await svc.resolveKey(KEY_ID, 'ed25519');
    expect(fetcher.calls).toHaveLength(2);
  });

  it('rejects loopback DID synchronously (SSRF, no fetch)', async () => {
    const fetcher = new StubFetcher(() => {
      throw new Error('should not be called');
    });
    const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
    await expect(svc.resolveKey('did:web:127.0.0.1#key-1', 'ed25519')).rejects.toMatchObject({
      code: 'SSRF',
    });
    expect(fetcher.calls).toHaveLength(0);
  });

  it('rejects RFC 1918 IP literal DID', async () => {
    const fetcher = new StubFetcher(() => {
      throw new Error('should not be called');
    });
    const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
    await expect(svc.resolveKey('did:web:192.168.1.1#k', 'ed25519')).rejects.toMatchObject({
      code: 'SSRF',
    });
  });

  it('rejects an HTTP non-2xx response', async () => {
    const fetcher = new StubFetcher(() => ({
      status: 404,
      contentType: 'text/plain',
      body: async () => new Uint8Array(),
    }));
    const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
    await expect(svc.resolveKey(KEY_ID, 'ed25519')).rejects.toMatchObject({
      code: 'STATUS',
    });
  });

  it('rejects the wrong Content-Type', async () => {
    const fetcher = new StubFetcher(() => jsonResp(goodDoc(), 'text/html'));
    const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
    await expect(svc.resolveKey(KEY_ID, 'ed25519')).rejects.toMatchObject({
      code: 'CONTENT_TYPE',
    });
  });

  it('accepts both application/did+json and application/json', async () => {
    for (const ct of ['application/did+json', 'application/json', 'application/did+json; charset=utf-8']) {
      const fetcher = new StubFetcher(() => jsonResp(goodDoc(), ct));
      const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
      await expect(svc.resolveKey(KEY_ID, 'ed25519')).resolves.toBeDefined();
    }
  });

  it('rejects bodies over 64 KB', async () => {
    const fetcher = new StubFetcher(() => ({
      status: 200,
      contentType: 'application/did+json',
      body: async () => new Uint8Array(65 * 1024),
    }));
    const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
    await expect(svc.resolveKey(KEY_ID, 'ed25519')).rejects.toMatchObject({
      code: 'BODY_TOO_LARGE',
    });
  });

  it('surfaces parse errors when the body is not JSON', async () => {
    const fetcher = new StubFetcher(() => ({
      status: 200,
      contentType: 'application/did+json',
      body: async () => new TextEncoder().encode('not json'),
    }));
    const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
    await expect(svc.resolveKey(KEY_ID, 'ed25519')).rejects.toMatchObject({
      code: 'PARSE',
    });
  });

  it('surfaces id mismatch as PARSE (substitution attack defense)', async () => {
    const fetcher = new StubFetcher(() =>
      jsonResp({
        ...(goodDoc() as object),
        id: 'did:web:attacker.example',
      }),
    );
    const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
    await expect(svc.resolveKey(KEY_ID, 'ed25519')).rejects.toMatchObject({
      code: 'PARSE',
    });
  });

  it('surfaces unauthorized key as PICK (assertionMethod gate)', async () => {
    const fetcher = new StubFetcher(() =>
      jsonResp({
        ...(goodDoc() as object),
        assertionMethod: [], // key removed from authorization list
      }),
    );
    const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
    await expect(svc.resolveKey(KEY_ID, 'ed25519')).rejects.toMatchObject({
      code: 'PICK',
    });
  });

  it('surfaces algorithm mismatch as PICK (downgrade defense)', async () => {
    const fetcher = new StubFetcher(() => jsonResp(goodDoc()));
    const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
    await expect(svc.resolveKey(KEY_ID, 'ecdsa-p256')).rejects.toMatchObject({
      code: 'PICK',
    });
  });

  // ── resolveReceiptKey: RFC-ACDP-0010 §9 lifecycle ───────────────────────
  describe('resolveReceiptKey', () => {
    // A registry receipt key kept in verificationMethod but rotated out of
    // assertionMethod (the §9 retirement state).
    function retiredKeyDoc(): unknown {
      return {
        id: DID,
        verificationMethod: [
          {
            id: KEY_ID,
            controller: DID,
            type: 'Ed25519VerificationKey2020',
            publicKeyMultibase: ED25519_MB,
          },
        ],
        assertionMethod: [], // rotated out — no longer current
      };
    }

    it('resolves a current receipt key with historical=false', async () => {
      const fetcher = new StubFetcher(() => jsonResp(goodDoc()));
      const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
      const key = await svc.resolveReceiptKey(KEY_ID, 'ed25519');
      expect(key.keyId).toBe(KEY_ID);
      expect(key.historical).toBe(false);
      expect(Buffer.from(key.publicKeyB64, 'base64').length).toBe(32);
    });

    it('resolves a retired (verificationMethod-only) key with historical=true', async () => {
      const fetcher = new StubFetcher(() => jsonResp(retiredKeyDoc()));
      const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
      const key = await svc.resolveReceiptKey(KEY_ID, 'ed25519');
      expect(key.historical).toBe(true);
      // Still a usable key — the receipt verifies, just as historically authorized.
      expect(key.keyId).toBe(KEY_ID);
      expect(Buffer.from(key.publicKeyB64, 'base64').length).toBe(32);
    });

    it('fails closed (PICK) when the key is gone from verificationMethod entirely', async () => {
      const fetcher = new StubFetcher(() =>
        jsonResp({ id: DID, verificationMethod: [], assertionMethod: [] }),
      );
      const svc = new DidWebResolverService(new TestSsrfPolicy(), fetcher);
      await expect(svc.resolveReceiptKey(KEY_ID, 'ed25519')).rejects.toMatchObject({
        code: 'PICK',
      });
    });
  });
});

describe('DefaultDidFetcher', () => {
  it('exists and can be instantiated', () => {
    expect(new DefaultDidFetcher()).toBeInstanceOf(DefaultDidFetcher);
  });
});
