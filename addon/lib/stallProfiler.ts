import inspector from 'node:inspector';
import path from 'node:path';
import consola from 'consola';
import { envInt } from '../utils/envNumber';

const logger = consola.withTag('EventLoop');

const SAMPLE_INTERVAL_US = 10000;
const TOP_ENTRIES = 6;
const OWN_FRAMES = 3;

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}

interface Profile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

let session: inspector.Session | null = null;
let running = false;
let busy = false;
let disabled = false;
let windowEndsAt = 0;
let quietUntil = 0;
let windowTimer: NodeJS.Timeout | null = null;

function windowSeconds(): number {
  return envInt('EVENT_LOOP_STALL_PROFILE_SECONDS', 120, 0);
}

function cooldownSeconds(): number {
  return envInt('EVENT_LOOP_STALL_PROFILE_COOLDOWN', 600, 0);
}

function post<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    session!.post(method, params, (error: Error | null, result: any) => (error ? reject(error) : resolve(result)));
  });
}

async function start(): Promise<void> {
  if (!session) {
    session = new inspector.Session();
    session.connect();
  }
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: SAMPLE_INTERVAL_US });
  await post('Profiler.start');
  running = true;
}

async function stop(): Promise<Profile | null> {
  if (!running) return null;
  running = false;
  const { profile } = await post<{ profile: Profile }>('Profiler.stop');
  return profile;
}

function isOwn(frame: CallFrame): boolean {
  return !!frame.url && !frame.url.startsWith('node:') && !frame.url.includes('node_modules');
}

function frameLabel(frame: CallFrame): string {
  const where = frame.url ? ` (${path.basename(frame.url)}:${frame.lineNumber + 1})` : '';
  return `${frame.functionName || '(anonymous)'}${where}`;
}

function sampleLabel(leaf: number, nodes: Map<number, ProfileNode>, parents: Map<number, number>): string {
  const frame = nodes.get(leaf)!.callFrame;
  if (frame.functionName === '(garbage collector)') return 'garbage collection';
  if (frame.functionName === '(program)') return 'native work outside JavaScript';

  const own: string[] = [];
  for (let id: number | undefined = leaf; id !== undefined && own.length < OWN_FRAMES; id = parents.get(id)) {
    const current = nodes.get(id)!.callFrame;
    if (isOwn(current)) own.push(frameLabel(current));
  }
  if (!own.length) return frameLabel(frame);
  return isOwn(frame) ? own.join(' < ') : `${own.join(' < ')} [in ${frameLabel(frame)}]`;
}

function describeStall(profile: Profile, lateMs: number): string | null {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);

  const times: number[] = [];
  let at = profile.startTime;
  for (const delta of profile.timeDeltas) times.push((at += delta));
  const from = profile.endTime - (lateMs + 1500) * 1000;

  let best: [number, number] | null = null;
  let runStart = -1;
  for (let i = 0; i <= profile.samples.length; i++) {
    const idle = i === profile.samples.length || times[i] < from || nodes.get(profile.samples[i])!.callFrame.functionName === '(idle)';
    if (!idle && runStart < 0) runStart = i;
    if (idle && runStart >= 0) {
      if (!best || times[i - 1] - times[runStart] > times[best[1]] - times[best[0]]) best = [runStart, i - 1];
      runStart = -1;
    }
  }
  if (!best) return null;

  const spent = new Map<string, number>();
  for (let i = best[0]; i <= best[1]; i++) {
    const label = sampleLabel(profile.samples[i], nodes, parents);
    spent.set(label, (spent.get(label) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  const busyMs = Math.round((times[best[1]] - times[best[0]]) / 1000 + SAMPLE_INTERVAL_US / 1000);
  const began = new Date(Date.now() - (profile.endTime - times[best[0]]) / 1000).toISOString();
  const top = [...spent.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ENTRIES)
    .map(([label, ms]) => `${Math.round(ms)}ms ${label}`);
  return `Stall of ${lateMs}ms profiled: busiest stretch ${busyMs}ms from ${began}; ${top.join('; ')}`;
}

function endWindow(): void {
  if (windowTimer) clearTimeout(windowTimer);
  windowTimer = null;
  windowEndsAt = 0;
  quietUntil = Date.now() + cooldownSeconds() * 1000;
  stop().catch(() => undefined);
}

function giveUp(error: any): void {
  disabled = true;
  running = false;
  logger.warn(`Stall profiling unavailable: ${error?.message || error}`);
}

export function onStall(lateMs: number): void {
  if (disabled || busy || windowSeconds() <= 0) return;
  const now = Date.now();

  if (!running) {
    if (now < quietUntil) return;
    busy = true;
    start()
      .then(() => {
        windowEndsAt = now + windowSeconds() * 1000;
        windowTimer = setTimeout(endWindow, windowSeconds() * 1000);
        windowTimer.unref?.();
      })
      .catch(giveUp)
      .finally(() => { busy = false; });
    return;
  }

  busy = true;
  stop()
    .then((profile) => {
      const line = profile ? describeStall(profile, lateMs) : null;
      if (line) logger.warn(line);
      return Date.now() < windowEndsAt ? start() : endWindow();
    })
    .catch(giveUp)
    .finally(() => { busy = false; });
}
