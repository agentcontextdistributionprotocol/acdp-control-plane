import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request correlation id, carried in `AsyncLocalStorage` so any code
 * running under a request can read it without threading it through call
 * signatures. `CorrelationIdMiddleware` is the only writer.
 *
 * This lives in `common/` rather than next to the middleware so that
 * `PinoLogger` can read it without `common/` depending on `middleware/`
 * (and on express + the Nest DI decorators that come with it). The
 * middleware re-exports both symbols, so it stays the discoverable entry
 * point.
 */
export const correlationStorage = new AsyncLocalStorage<string>();

/**
 * The current request's correlation id, or `undefined` outside a request —
 * background sweeps (retention, receipt audit, the witness pollers) run with
 * no store, and callers are expected to OMIT the field there rather than
 * log a placeholder.
 */
export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}
