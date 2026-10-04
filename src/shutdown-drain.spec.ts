import type { NextFunction, Request, Response } from 'express';
import {
  arrivalPhase,
  arrivedWhileClosing,
  createDrainArrivalMarker,
  DRAIN_ARRIVAL,
  DrainState,
} from './shutdown-drain';

describe('drain arrival marker (issue #192, Phase 2)', () => {
  /** A response whose every member throws, so ANY touch of `res` fails the test. */
  const untouchable = new Proxy(
    {},
    {
      get: (_t, prop) => {
        throw new Error(`arrival marker touched res.${String(prop)}`);
      },
      set: (_t, prop) => {
        throw new Error(`arrival marker wrote res.${String(prop)}`);
      },
    },
  ) as Response;

  it('stamps the drain PHASE at call time and calls next(), never touching res', () => {
    const drain = new DrainState();
    const mark = createDrainArrivalMarker(drain);
    const serving = {} as Request;
    const draining = {} as Request;
    const closing = {} as Request;
    const next = jest.fn() as NextFunction;

    mark(serving, untouchable, next);
    drain.begin();
    mark(draining, untouchable, next);
    drain.beginClosing();
    mark(closing, untouchable, next);

    expect(next).toHaveBeenCalledTimes(3);
    expect(next).toHaveBeenNthCalledWith(1);
    // An earlier stamp is NOT rewritten by a later phase: that is the point.
    expect([serving, draining, closing].map((r) => arrivalPhase(r))).toEqual([
      'serving',
      'draining',
      'closing',
    ]);
    // Only a request that arrived once the close began is gated (#192 Phase 3).
    expect([serving, draining, closing].map((r) => arrivedWhileClosing(r))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('stamps under a symbol, so no request field can spoof it', () => {
    const drain = new DrainState();
    drain.beginClosing();
    const req = { drainArrival: 'serving', headers: { 'x-drain-arrival': 'serving' } } as unknown as Request;

    createDrainArrivalMarker(drain)(req, untouchable, jest.fn());

    expect((req as unknown as Record<symbol, unknown>)[DRAIN_ARRIVAL]).toBe('closing');
    expect(arrivedWhileClosing({ drainArrival: 'closing' })).toBe(false);
  });

  it('an unmarked request has no phase and reads as not-while-closing', () => {
    expect(arrivalPhase({})).toBeUndefined();
    expect(arrivedWhileClosing({})).toBe(false);
  });
});

describe('DrainState tallies (issue #192, Phase 2)', () => {
  it('counts rejections and SSE terminations synchronously', () => {
    const drain = new DrainState();
    expect(drain.stats()).toEqual({ sseStreamsTerminated: 0, drainRejections: 0 });

    drain.noteRejection();
    drain.noteRejection();
    drain.noteSseTermination();

    expect(drain.stats()).toEqual({ sseStreamsTerminated: 1, drainRejections: 2 });
  });
});

describe('DrainState phases (issue #192, Phase 3)', () => {
  it('starts serving, and is monotone: serving → draining → closing', () => {
    const drain = new DrainState();
    expect(drain.phase()).toBe('serving');
    expect(drain.isDraining()).toBe(false);

    drain.begin();
    expect(drain.phase()).toBe('draining');
    expect(drain.isDraining()).toBe(true);

    drain.beginClosing();
    expect(drain.phase()).toBe('closing');
    expect(drain.isDraining()).toBe(true);

    // No way back: begin() after closing is a no-op, as is a repeat.
    drain.begin();
    drain.beginClosing();
    expect(drain.phase()).toBe('closing');
  });

  it('drained$ fires at the START of draining (SSE ends then), exactly once', () => {
    const drain = new DrainState();
    const seen = jest.fn();
    drain.drained$.subscribe(seen);

    drain.begin();
    expect(seen).toHaveBeenCalledTimes(1);
    drain.beginClosing();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('beginClosing() straight from serving still fires drained$ (delay 0 path)', () => {
    const drain = new DrainState();
    const seen = jest.fn();
    drain.drained$.subscribe(seen);

    drain.beginClosing();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(drain.phase()).toBe('closing');
  });
});
