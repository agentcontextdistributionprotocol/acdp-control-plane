import { ExecutionContext } from '@nestjs/common';
import { ThrottleByUserGuard } from './throttle-by-user.guard';

/**
 * The guard's contract is its tracker resolution: rate limits key on the
 * authenticated principal (req.actorId pinned by AuthGuard), falling back
 * to the normalized client IP for @Public() routes (IPv6 collapsed to its
 * /ipv6SubnetPrefix network — issue #187), and never returning an unkeyed
 * tracker. Exercised via a test subclass — the methods are protected.
 */
class TestableGuard extends ThrottleByUserGuard {
  trackerOf(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
  requestResponseOf(context: ExecutionContext) {
    return this.getRequestResponse(context);
  }
}

function makeGuard(): TestableGuard {
  // ThrottlerGuard's own dependencies are unused by the overridden methods.
  return new TestableGuard({} as any, {} as any, {} as any);
}

/**
 * A guard whose prefix arrives the way production's does: through the
 * object-form module options, copied onto the guard by
 * ThrottlerGuard.onModuleInit (the array form cannot carry it).
 */
async function makeGuardWithPrefix(ipv6SubnetPrefix: number): Promise<TestableGuard> {
  const guard = new TestableGuard(
    { throttlers: [{ ttl: 60_000, limit: 10 }], ipv6SubnetPrefix } as any,
    {} as any,
    {} as any,
  );
  await guard.onModuleInit();
  return guard;
}

describe('ThrottleByUserGuard', () => {
  describe('authenticated callers (per-principal key, unchanged by #187)', () => {
    it('keys the rate limit on actorId when the request is authenticated', async () => {
      const guard = makeGuard();
      await expect(
        guard.trackerOf({ actorId: 'did:web:cp.test:agents:alice', ip: '10.0.0.9' }),
      ).resolves.toBe('did:web:cp.test:agents:alice');
    });

    it('keys on actorId — never the /64 — for an authenticated IPv6 caller', async () => {
      const guard = makeGuard();
      const actorId = 'did:web:cp.test:agents:alice';
      const a = await guard.trackerOf({ actorId, ip: '2001:db8:1:2::1' });
      const b = await guard.trackerOf({ actorId, ip: '2001:db8:9:9::9' });
      expect(a).toBe(actorId);
      expect(b).toBe(actorId);
    });

    it('two principals behind one /64 keep separate buckets', async () => {
      const guard = makeGuard();
      const ip = '2001:db8:1:2::1';
      await expect(guard.trackerOf({ actorId: 'abcdefgh...', ip })).resolves.toBe('abcdefgh...');
      await expect(guard.trackerOf({ actorId: 'did:key:z6Mk', ip })).resolves.toBe('did:key:z6Mk');
    });

    it('stringifies a non-string actorId rather than leaking an object tracker', async () => {
      const guard = makeGuard();
      await expect(guard.trackerOf({ actorId: 42 })).resolves.toBe('42');
    });

    it('a null actorId falls through to the IP, as `??` did before', async () => {
      const guard = makeGuard();
      await expect(guard.trackerOf({ actorId: null, ip: '10.0.0.9' })).resolves.toBe('10.0.0.9');
    });
  });

  describe('unauthenticated callers (@Public): normalized IP', () => {
    it('IPv4 keys on the address itself', async () => {
      const guard = makeGuard();
      await expect(guard.trackerOf({ ip: '10.0.0.9' })).resolves.toBe('10.0.0.9');
    });

    it('IPv4-mapped IPv6 (dotted form) collapses onto the IPv4 bucket', async () => {
      const guard = makeGuard();
      await expect(guard.trackerOf({ ip: '::ffff:10.0.0.9' })).resolves.toBe('10.0.0.9');
    });

    it('IPv4-mapped IPv6 (hex form) collapses onto the same IPv4 bucket', async () => {
      const guard = makeGuard();
      await expect(guard.trackerOf({ ip: '::ffff:a00:9' })).resolves.toBe('10.0.0.9');
    });

    it('every address inside one /64 shares one tracker (the #187 rotation)', async () => {
      const guard = makeGuard();
      const rotated = [
        '2001:db8:abcd:12::1',
        '2001:db8:abcd:12::2',
        '2001:db8:abcd:12:ffff:ffff:ffff:ffff',
        '2001:db8:abcd:12:1234:5678:9abc:def0',
        '2001:0db8:abcd:0012:0000:0000:0000:0042',
        '2001:DB8:ABCD:12::BEEF',
      ];
      const trackers = await Promise.all(rotated.map((ip) => guard.trackerOf({ ip })));
      expect(new Set(trackers)).toEqual(new Set(['2001:db8:abcd:12::/64']));
    });

    it('distinct /64s stay distinct', async () => {
      const guard = makeGuard();
      const a = await guard.trackerOf({ ip: '2001:db8:abcd:12::1' });
      const b = await guard.trackerOf({ ip: '2001:db8:abcd:13::1' });
      expect(a).toBe('2001:db8:abcd:12::/64');
      expect(b).toBe('2001:db8:abcd:13::/64');
      expect(a).not.toBe(b);
    });

    it('strips an IPv6 zone id before masking', async () => {
      const guard = makeGuard();
      await expect(guard.trackerOf({ ip: 'fe80::1%eth0' })).resolves.toBe('fe80::/64');
    });

    it('IPv6 loopback keys on ::1 (not ::/64)', async () => {
      const guard = makeGuard();
      await expect(guard.trackerOf({ ip: '::1' })).resolves.toBe('::1');
    });

    it('a malformed IP string keys on itself (its own bucket, as before)', async () => {
      const guard = makeGuard();
      await expect(guard.trackerOf({ ip: 'not-an-ip' })).resolves.toBe('not-an-ip');
    });

    it('never returns an empty tracker — anonymous bucket when actorId and ip are absent', async () => {
      const guard = makeGuard();
      await expect(guard.trackerOf({})).resolves.toBe('anonymous');
    });

    it('an empty or non-string ip also lands in the anonymous bucket', async () => {
      const guard = makeGuard();
      await expect(guard.trackerOf({ ip: '' })).resolves.toBe('anonymous');
      await expect(guard.trackerOf({ ip: 12345 })).resolves.toBe('anonymous');
      await expect(guard.trackerOf({ ip: null })).resolves.toBe('anonymous');
    });
  });

  describe('ipv6SubnetPrefix flows from the object-form module options', () => {
    it('defaults to /64 when the options do not set it', async () => {
      const guard = new TestableGuard(
        { throttlers: [{ ttl: 60_000, limit: 10 }] } as any,
        {} as any,
        {} as any,
      );
      await guard.onModuleInit();
      await expect(guard.trackerOf({ ip: '2001:db8:1:2:aaaa::1' })).resolves.toBe(
        '2001:db8:1:2::/64',
      );
    });

    it('a /48 prefix merges neighbouring /64s', async () => {
      const guard = await makeGuardWithPrefix(48);
      const a = await guard.trackerOf({ ip: '2001:db8:1:2::1' });
      const b = await guard.trackerOf({ ip: '2001:db8:1:3::1' });
      expect(a).toBe('2001:db8:1::/48');
      expect(b).toBe(a);
    });

    it('a /128 prefix restores per-address buckets', async () => {
      const guard = await makeGuardWithPrefix(128);
      const a = await guard.trackerOf({ ip: '2001:db8:1:2::1' });
      const b = await guard.trackerOf({ ip: '2001:db8:1:2::2' });
      expect(a).toBe('2001:db8:1:2::1/128');
      expect(b).toBe('2001:db8:1:2::2/128');
    });

    it('the prefix never touches IPv4 or authenticated trackers', async () => {
      const guard = await makeGuardWithPrefix(48);
      await expect(guard.trackerOf({ ip: '10.0.0.9' })).resolves.toBe('10.0.0.9');
      await expect(
        guard.trackerOf({ actorId: 'did:web:cp.test:agents:alice', ip: '2001:db8:1:2::1' }),
      ).resolves.toBe('did:web:cp.test:agents:alice');
    });
  });

  it('resolves req/res from the HTTP execution context', () => {
    const guard = makeGuard();
    const req = { id: 'req' };
    const res = { id: 'res' };
    const context = {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;

    expect(guard.requestResponseOf(context)).toEqual({ req, res });
  });
});
