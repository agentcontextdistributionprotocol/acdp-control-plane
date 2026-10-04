import type { NextFunction, Request, Response } from 'express';
import { arrivedDuringDrain, createDrainArrivalMarker, DRAIN_ARRIVAL, DrainState } from './shutdown-drain';

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

  it('stamps the drain state AT CALL TIME and calls next(), never touching res', () => {
    const drain = new DrainState();
    const mark = createDrainArrivalMarker(drain);
    const before = {} as Request;
    const after = {} as Request;
    const next = jest.fn() as NextFunction;

    mark(before, untouchable, next);
    drain.begin();
    mark(after, untouchable, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenNthCalledWith(1);
    // The earlier stamp is NOT rewritten by the later drain: that is the point.
    expect(arrivedDuringDrain(before)).toBe(false);
    expect(arrivedDuringDrain(after)).toBe(true);
  });

  it('stamps under a symbol, so no request field can spoof it', () => {
    const drain = new DrainState();
    drain.begin();
    const req = { drainArrival: true, headers: { 'x-drain-arrival': 'false' } } as unknown as Request;

    createDrainArrivalMarker(drain)(req, untouchable, jest.fn());

    expect((req as unknown as Record<symbol, unknown>)[DRAIN_ARRIVAL]).toBe(true);
    expect(arrivedDuringDrain({ drainArrival: true })).toBe(false);
  });

  it('an unmarked request reads as not-during-drain', () => {
    expect(arrivedDuringDrain({})).toBe(false);
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
