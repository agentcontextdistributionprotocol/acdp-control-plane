import * as net from 'node:net';
import { TEST_DB_URL } from './test-db';

interface Pair {
  client: net.Socket;
  upstream: net.Socket | null;
  /** Bytes are dropped in both directions (a partition, not a reset). */
  dead: boolean;
}

/**
 * An in-process TCP proxy in front of the test Postgres that can simulate the
 * database failure modes a readiness probe must survive (issue #210), without
 * ever stopping the shared test Postgres (other specs, and other lanes, use it).
 *
 *   - `refuse()`    close the listener and destroy every socket → ECONNREFUSED.
 *   - `blackhole()` keep every socket open but drop all bytes, on existing AND
 *                   new sockets → a network partition / dead NAT: queries and
 *                   connects hang instead of failing.
 *   - `restore()`   destroy the dead sockets (so anything pending on them fails
 *                   at once) and forward again — re-listening on the SAME port
 *                   after a `refuse()`.
 *   - `restore({ keepPending: true })` forward again for NEW sockets, but leave
 *                   the black-holed ones open and dead — production, where a
 *                   healed network does not reset a handshake that was already
 *                   lost; a connect stuck on one only ends at the pool's
 *                   `connectionTimeoutMillis`.
 *
 * Ported from the scratch proxy measured in `plans/archive/readyz-db-down-fix.md`.
 */
export class PgFaultProxy {
  private server: net.Server | null = null;
  private port = 0;
  private mode: 'up' | 'blackhole' | 'refused' = 'up';
  private readonly pairs = new Set<Pair>();
  private readonly targetHost: string;
  private readonly targetPort: number;
  private readonly baseUrl: URL;
  /** Sockets accepted while black-holed (each one a connect that cannot finish). */
  blackholedAccepts = 0;

  constructor(targetUrl: string = TEST_DB_URL) {
    this.baseUrl = new URL(targetUrl);
    // `localhost` may resolve to ::1 first; the test Postgres is reachable on
    // IPv4 loopback in every setup this suite runs in (compose and native).
    this.targetHost =
      this.baseUrl.hostname === 'localhost' ? '127.0.0.1' : this.baseUrl.hostname;
    this.targetPort = Number(this.baseUrl.port || 5432);
  }

  /** Listen on an ephemeral loopback port; returns the proxied DATABASE_URL. */
  async start(): Promise<{ url: string }> {
    await this.listen(0);
    const url = new URL(this.baseUrl.toString());
    url.hostname = '127.0.0.1';
    url.port = String(this.port);
    return { url: url.toString() };
  }

  /** The proxy's listening port (stable across refuse/restore). */
  get listenPort(): number {
    return this.port;
  }

  /** Open client-side sockets (pooled connections through the proxy). */
  get openSockets(): number {
    return this.pairs.size;
  }

  async refuse(): Promise<void> {
    this.mode = 'refused';
    const server = this.server;
    this.server = null;
    for (const p of this.pairs) this.destroy(p);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  blackhole(): void {
    this.mode = 'blackhole';
    for (const p of this.pairs) p.dead = true;
  }

  async restore(opts: { keepPending?: boolean } = {}): Promise<void> {
    if (!opts.keepPending) {
      for (const p of this.pairs) if (p.dead) this.destroy(p);
    }
    this.mode = 'up';
    if (!this.server) await this.listen(this.port);
  }

  async close(): Promise<void> {
    await this.refuse();
  }

  private listen(port: number): Promise<void> {
    const server = net.createServer((client) => this.accept(client));
    this.server = server;
    return new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        this.port = (server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  private accept(client: net.Socket): void {
    const pair: Pair = { client, upstream: null, dead: this.mode === 'blackhole' };
    this.pairs.add(pair);
    client.on('error', () => undefined);
    client.on('close', () => {
      this.pairs.delete(pair);
      pair.upstream?.destroy();
    });
    if (pair.dead) {
      this.blackholedAccepts++;
      client.on('data', () => undefined); // swallow: the handshake never completes
      return;
    }
    const upstream = net.connect(this.targetPort, this.targetHost);
    pair.upstream = upstream;
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => client.destroy());
    client.on('data', (d) => {
      if (!pair.dead) upstream.write(d);
    });
    upstream.on('data', (d) => {
      if (!pair.dead) client.write(d);
    });
  }

  private destroy(p: Pair): void {
    p.client.destroy();
    p.upstream?.destroy();
    this.pairs.delete(p);
  }
}
