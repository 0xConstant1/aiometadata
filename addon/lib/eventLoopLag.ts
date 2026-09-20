import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

export interface EventLoopLag {
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Stalls long enough for the container health check to miss a beat. */
  stallsOverSecond: number;
  sinceMs: number;
}

let histogram: IntervalHistogram | null = null;
let startedAt = 0;
let stalls = 0;
let lastMax = 0;
let timer: NodeJS.Timeout | null = null;

export function startEventLoopMonitor(): void {
  if (histogram) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  startedAt = Date.now();
  // The histogram keeps no history, so a stall is counted as it happens.
  timer = setInterval(() => {
    if (!histogram) return;
    const max = histogram.max / 1e6;
    if (max > lastMax && max >= 1000) stalls += 1;
    lastMax = max;
  }, 1000);
  timer.unref?.();
}

export function eventLoopLag(): EventLoopLag | null {
  if (!histogram) return null;
  const ms = (value: number) => Math.round((value / 1e6) * 10) / 10;
  return {
    meanMs: ms(histogram.mean),
    p50Ms: ms(histogram.percentile(50)),
    p99Ms: ms(histogram.percentile(99)),
    maxMs: ms(histogram.max),
    stallsOverSecond: stalls,
    sinceMs: Date.now() - startedAt,
  };
}

export function stopEventLoopMonitor(): void {
  if (timer) clearInterval(timer);
  histogram?.disable();
  histogram = null;
  timer = null;
}

module.exports = { startEventLoopMonitor, eventLoopLag, stopEventLoopMonitor };
