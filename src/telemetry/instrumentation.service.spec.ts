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
});
