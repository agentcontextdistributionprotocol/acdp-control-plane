import * as http from 'node:http';
import * as https from 'node:https';
import { createHmac } from 'node:crypto';

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** When provided as a string, sent verbatim. */
  rawBody?: string | Buffer;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Lightweight typed HTTP client for integration tests. Wraps Node's http
 * module directly — no external deps.
 */
export class TestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  // ── Ingest ────────────────────────────────────────────────────

  /**
   * Send an ACDP webhook event. If `secret` is provided, signs the body with
   * HMAC-SHA256 and attaches the `x-acdp-signature` header.
   */
  async ingest(
    payload: Record<string, unknown>,
    opts: { runId?: string; secret?: string; signatureOverride?: string } = {},
  ): Promise<RawResponse> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (opts.runId) headers['x-run-id'] = opts.runId;
    if (opts.signatureOverride !== undefined) {
      headers['x-acdp-signature'] = opts.signatureOverride;
    } else if (opts.secret) {
      const sig = createHmac('sha256', opts.secret).update(body).digest('hex');
      headers['x-acdp-signature'] = `sha256=${sig}`;
    }
    return this.requestRaw('POST', '/ingest/acdp', { rawBody: body, headers });
  }

  // ── Runs ──────────────────────────────────────────────────────

  async listRuns(query?: Record<string, string | number | boolean | undefined>) {
    return this.requestJson('GET', '/runs', { query });
  }

  async getRun(runId: string) {
    return this.requestJson('GET', `/runs/${encodeURIComponent(runId)}`);
  }

  async getLineage(runId: string) {
    return this.requestJson('GET', `/runs/${encodeURIComponent(runId)}/lineage`);
  }

  async getRunEvents(runId: string, query?: Record<string, string | number | boolean | undefined>) {
    return this.requestJson('GET', `/runs/${encodeURIComponent(runId)}/events`, { query });
  }

  /**
   * Notify a run start. HMAC-authenticated like {@link ingest}: signs the body
   * with `secret` and attaches `x-acdp-signature`.
   */
  async markRunStarted(
    payload: { run_id: string; scenario_id: string; started_at?: string; inputs?: Record<string, unknown> },
    opts: { secret?: string; signatureOverride?: string; tenantId?: string } = {},
  ) {
    return this.signedRunPost('/runs/started', payload, opts);
  }

  async markRunComplete(
    runId: string,
    body: { status: 'completed' | 'failed' | 'cancelled'; result?: Record<string, unknown> },
    opts: { secret?: string; signatureOverride?: string; tenantId?: string } = {},
  ) {
    return this.signedRunPost(`/runs/${encodeURIComponent(runId)}/complete`, body, opts);
  }

  /**
   * Shared helper for the HMAC-authenticated run-notify routes (mirrors how
   * the playground signs the calls it makes to the control plane).
   */
  private async signedRunPost(
    path: string,
    payload: Record<string, unknown>,
    opts: { secret?: string; signatureOverride?: string; tenantId?: string },
  ) {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.tenantId) headers['x-tenant-id'] = opts.tenantId;
    if (opts.signatureOverride !== undefined) {
      headers['x-acdp-signature'] = opts.signatureOverride;
    } else if (opts.secret) {
      const sig = createHmac('sha256', opts.secret).update(body).digest('hex');
      headers['x-acdp-signature'] = `sha256=${sig}`;
    }
    return this.requestRaw('POST', path, { rawBody: body, headers });
  }

  // ── Events ────────────────────────────────────────────────────

  async listEvents(query?: Record<string, string | number | boolean | undefined>) {
    return this.requestJson('GET', '/events', { query });
  }

  // ── Registries / Agents ──────────────────────────────────────

  async listRegistries() {
    return this.requestJson('GET', '/registries');
  }

  async listAgents() {
    return this.requestJson('GET', '/agents');
  }

  async getAgent(did: string) {
    return this.requestJson('GET', `/agents/${encodeURIComponent(did)}`);
  }

  // ── Webhooks ─────────────────────────────────────────────────

  async createWebhook(body: { url: string; events?: string[]; secret: string }) {
    return this.requestJson('POST', '/webhooks', { body });
  }

  async listWebhooks() {
    return this.requestJson('GET', '/webhooks');
  }

  async deleteWebhook(id: string) {
    return this.requestRaw('DELETE', `/webhooks/${id}`);
  }

  // ── Dashboard / Health / Metrics ─────────────────────────────

  async getDashboardOverview(query?: Record<string, string | number | boolean | undefined>) {
    return this.requestJson('GET', '/dashboard/overview', { query });
  }

  async healthz() {
    return this.requestJson('GET', '/healthz');
  }

  async readyz() {
    return this.requestJson('GET', '/readyz');
  }

  async metrics(): Promise<string> {
    const res = await this.requestRaw('GET', '/metrics');
    return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  }

  // ── Low-level ────────────────────────────────────────────────

  async requestJson<T = unknown>(
    method: string,
    path: string,
    opts?: RequestOptions,
  ): Promise<T> {
    const res = await this.requestRaw(method, path, opts);
    return res.body as T;
  }

  async requestRaw(method: string, path: string, opts: RequestOptions = {}): Promise<RawResponse> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...(opts.headers ?? {}),
    };
    let rawBody: string | Buffer | undefined = opts.rawBody;
    if (rawBody === undefined && opts.body !== undefined) {
      rawBody = JSON.stringify(opts.body);
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    }

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.request(url, { method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = raw;
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
          }
          const flatHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') flatHeaders[k] = v;
            else if (Array.isArray(v)) flatHeaders[k] = v.join(',');
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: flatHeaders,
            body: parsed,
          });
        });
      });
      req.on('error', reject);
      if (rawBody !== undefined) req.write(rawBody);
      req.end();
    });
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}
