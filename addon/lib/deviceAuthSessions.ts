import crypto from 'crypto';
const consola = require('consola');
const redis = require('./redisClient');

const logger = consola.withTag('DeviceAuth');

const REDIS_KEY_PREFIX = 'device-auth:session:';

export type DeviceAuthProvider = 'simkl';

export interface DeviceAuthSession {
  provider: DeviceAuthProvider;
  userCode: string;
  deviceCode?: string;
  expiresAt: number;
  /** Shortest gap we let the browser poll the provider at. */
  pollIntervalMs: number;
  lastPolledAt: number;
}

// Written to both stores: Redis so other replicas can see the session, memory so
// things still work when Redis is down, which is the common self-hosted case. A
// session written while Redis is down is only visible to the process that made
// it, so on a multi-replica instance the browser has to reach that same process.
// Sessions are write-once apart from the poll bookkeeping, so the two stores
// can't disagree, they can only be missing.
//
// Redis writes are not awaited. With no server listening, ioredis sits on a
// command for the better part of a minute before giving up, which would stall
// every poll. Memory is updated first, so the request never waits on Redis.
const memorySessions = new Map<string, DeviceAuthSession>();

function pruneMemorySessions(now: number): void {
  for (const [id, session] of memorySessions) {
    if (session.expiresAt <= now) memorySessions.delete(id);
  }
}

/** Caps how long a lookup waits on Redis before treating it as a miss. */
const REDIS_READ_TIMEOUT_MS = 1000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>(resolve => setTimeout(() => resolve(null), ms).unref?.()),
  ]);
}

export function createSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function saveDeviceAuthSession(
  sessionId: string,
  session: DeviceAuthSession,
  now: number = Date.now()
): Promise<void> {
  const ttlSeconds = Math.max(1, Math.ceil((session.expiresAt - now) / 1000));

  pruneMemorySessions(now);
  memorySessions.set(sessionId, session);

  if (!redis) return;
  Promise.resolve(redis.setex(`${REDIS_KEY_PREFIX}${sessionId}`, ttlSeconds, JSON.stringify(session)))
    .catch((error: any) => {
      logger.debug(`Session not mirrored to Redis, memory only: ${error?.message}`);
    });
}

export async function getDeviceAuthSession(
  sessionId: string,
  provider: DeviceAuthProvider,
  now: number = Date.now()
): Promise<DeviceAuthSession | null> {
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{64}$/.test(sessionId)) {
    return null;
  }

  let session = memorySessions.get(sessionId) || null;

  if (!session && redis) {
    try {
      // Bounded, otherwise a lookup that misses memory while Redis is down
      // would hold the request open for as long as ioredis keeps retrying.
      const raw = await withTimeout<string | null>(
        redis.get(`${REDIS_KEY_PREFIX}${sessionId}`),
        REDIS_READ_TIMEOUT_MS
      );
      if (raw) session = JSON.parse(raw) as DeviceAuthSession;
    } catch (error: any) {
      logger.debug(`Could not read session from Redis: ${error?.message}`);
    }
  }

  pruneMemorySessions(now);

  if (!session || session.provider !== provider) return null;
  if (session.expiresAt <= now) {
    await deleteDeviceAuthSession(sessionId);
    return null;
  }

  return session;
}

/**
 * Records a poll and reports whether it came too soon. Callers that get `false`
 * should answer "pending" without touching the provider.
 */
export async function registerPoll(
  sessionId: string,
  session: DeviceAuthSession,
  now: number = Date.now()
): Promise<boolean> {
  if (now - session.lastPolledAt < session.pollIntervalMs) {
    return false;
  }

  session.lastPolledAt = now;
  await saveDeviceAuthSession(sessionId, session, now);
  return true;
}

/** Longest gap we back off to, so a repeated slow down cannot stall the flow. */
const MAX_POLL_INTERVAL_MS = 30000;

/** Backs off after a provider tells us we're polling too fast. */
export async function widenPollInterval(
  sessionId: string,
  session: DeviceAuthSession,
  now: number = Date.now()
): Promise<void> {
  session.pollIntervalMs = Math.min(session.pollIntervalMs + 2000, MAX_POLL_INTERVAL_MS);
  await saveDeviceAuthSession(sessionId, session, now);
}

export async function deleteDeviceAuthSession(sessionId: string): Promise<void> {
  memorySessions.delete(sessionId);
  if (!redis) return;
  Promise.resolve(redis.del(`${REDIS_KEY_PREFIX}${sessionId}`))
    .catch((error: any) => {
      logger.debug(`Could not delete session from Redis: ${error?.message}`);
    });
}
