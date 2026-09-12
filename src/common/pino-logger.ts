import { LoggerService } from '@nestjs/common';
import pino from 'pino';
import { getCorrelationId } from './correlation';

/** pino level methods this adapter forwards to, one per `LoggerService` level. */
type PinoLevel = 'info' | 'error' | 'warn' | 'debug' | 'trace';

/**
 * Fields merged into a pino line alongside the message. Anything a caller
 * passes as an object message lands here as TOP-LEVEL fields, so a log
 * aggregator can index and filter on them.
 */
type Bindings = Record<string, unknown>;

/**
 * Only a bare object literal is treated as structured bindings. An `Error`,
 * a `Date`, an array or a class instance stays in the message slot, where
 * pino's own serializers handle it — spreading those would silently drop
 * their prototype behaviour (an Error's `stack`, most importantly).
 */
function isPlainObject(value: unknown): value is Bindings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

export class PinoLogger implements LoggerService {
  private readonly logger: pino.Logger;

  constructor(level = 'info', isDevelopment = false, destination?: pino.DestinationStream) {
    // An explicit destination and a transport are mutually exclusive in pino
    // (a transport IS the destination). A caller passing one wants raw JSON
    // it can read back, so it wins.
    let transport: pino.TransportSingleOptions | undefined;
    if (isDevelopment && !destination) {
      try {
        require.resolve('pino-pretty');
        transport = { target: 'pino-pretty', options: { colorize: true } };
      } catch {
        // pino-pretty not installed — fall back to plain JSON
      }
    }
    const options: pino.LoggerOptions = { level, ...(transport ? { transport } : {}) };
    this.logger = destination ? pino(options, destination) : pino(options);
  }

  log(message: unknown, context?: string): void {
    this.emit('info', message, { context });
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.emit('error', message, { context, trace });
  }

  warn(message: unknown, context?: string): void {
    this.emit('warn', message, { context });
  }

  debug(message: unknown, context?: string): void {
    this.emit('debug', message, { context });
  }

  verbose(message: unknown, context?: string): void {
    this.emit('trace', message, { context });
  }

  /**
   * The single place message/bindings/correlation are assembled.
   *
   * Precedence, lowest to highest: the ambient correlation id, then the
   * caller's own structured fields, then the framework-supplied
   * `context`/`trace`. So an explicit `requestId` beats the ambient one
   * (they agree in practice), and nothing a caller passes can shadow the
   * `context` that identifies which class emitted the line.
   */
  private emit(level: PinoLevel, message: unknown, framework: Bindings): void {
    const bindings: Bindings = {};

    const requestId = getCorrelationId();
    // Omitted entirely outside a request (background sweeps) rather than
    // logged as null — an absent field is queryable, a null one is noise.
    if (requestId !== undefined) bindings.requestId = requestId;

    let msg: unknown = message;
    if (isPlainObject(message)) {
      const { msg: embedded, ...fields } = message;
      Object.assign(bindings, fields);
      msg = embedded;
    }

    // Assign only defined values: pino drops undefined on serialize anyway,
    // but an explicit `context: undefined` here would otherwise clobber a
    // caller-supplied `context` field with nothing.
    for (const [key, value] of Object.entries(framework)) {
      if (value !== undefined) bindings[key] = value;
    }

    if (msg === undefined) {
      this.logger[level](bindings);
    } else {
      this.logger[level](bindings, msg as string);
    }
  }
}
