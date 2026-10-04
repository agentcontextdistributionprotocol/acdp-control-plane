import * as client from 'prom-client';
import { InstrumentationService } from './instrumentation.service';

describe('InstrumentationService', () => {
  beforeEach(() => client.register.clear());
  afterAll(() => client.register.clear());

  it('registers the #192 shutdown-drain metrics', async () => {
    const svc = new InstrumentationService();
    svc.shutdownDrainRejectionsTotal.inc();
    svc.shutdownForcedConnectionsTotal.inc(3);

    const text = await svc.getMetrics();

    expect(text).toContain('# TYPE acdp_shutdown_drain_rejections_total counter');
    expect(text).toMatch(/^acdp_shutdown_drain_rejections_total 1$/m);
    expect(text).toContain('# TYPE acdp_shutdown_forced_connections_total counter');
    expect(text).toMatch(/^acdp_shutdown_forced_connections_total 3$/m);
    // Phase 1's SSE metrics stay registered alongside them.
    expect(text).toContain('# TYPE active_sse_connections gauge');
    expect(text).toContain('# TYPE acdp_sse_streams_terminated_total counter');
  });
  it('#210: pool diagnostics — no source registered reports no pool series (not zeros); a source is read at scrape time', async () => {
    const svc = new InstrumentationService();
    let text = await svc.getMetrics();
    expect(text).toContain('# TYPE acdp_db_pool_errors_total counter');
    expect(text).toMatch(/^acdp_db_pool_errors_total 0$/m);
    expect(text).toContain('# TYPE acdp_db_pool_connections gauge');
    expect(text).not.toMatch(/^acdp_db_pool_connections\{/m);

    const pool = { totalCount: 4, idleCount: 1, waitingCount: 0 };
    svc.registerDbPoolSource(() => pool);
    pool.waitingCount = 7; // read at scrape time, not at registration
    text = await svc.getMetrics();
    expect(text).toMatch(/^acdp_db_pool_connections\{state="total"\} 4$/m);
    expect(text).toMatch(/^acdp_db_pool_connections\{state="idle"\} 1$/m);
    expect(text).toMatch(/^acdp_db_pool_connections\{state="waiting"\} 7$/m);
  });

  it('#210: a report-only dependency source sets acdp_dependency_up at scrape time; n/a removes the series', async () => {
    const svc = new InstrumentationService();
    let status: 'up' | 'down' | 'n/a' = 'down';
    svc.registerDependencySource('redis_stream_hub', () => status);
    expect(await svc.getMetrics()).toMatch(/^acdp_dependency_up\{dependency="redis_stream_hub"\} 0$/m);
    status = 'up';
    expect(await svc.getMetrics()).toMatch(/^acdp_dependency_up\{dependency="redis_stream_hub"\} 1$/m);
    status = 'n/a';
    expect(await svc.getMetrics()).not.toMatch(/^acdp_dependency_up\{dependency="redis_stream_hub"\}/m);
  });
});
