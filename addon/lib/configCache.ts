import { LRUCache } from 'lru-cache';
const consola: any = require('consola');
const redis: any = require('./redisClient');
const { encodeCachePayload, decodeCachePayload }: any = require('./cacheCodec');

const logger: any = consola.withTag('ConfigCache');

function parsePositiveIntEnv(envValue: string | undefined, defaultValue: number, minValue: number = 1): number {
  const parsed = Number.parseInt(String(envValue), 10);
  if (!Number.isFinite(parsed) || parsed < minValue) return defaultValue;
  return parsed;
}

function CONFIG_CACHE_TTL_SEC() { return parsePositiveIntEnv(process.env.CONFIG_CACHE_TTL_SEC, 300, 10); }
function isConfigCacheCompressionEnabled(): boolean {
  return process.env.CONFIG_CACHE_COMPRESSION_ENABLED !== 'false';
}
const KEY_PREFIX = 'user-config:';

function redisKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

const pendingLoads = new Map<string, Promise<any>>();
// Decoded once per short window; every request otherwise reads and parses it from Redis.
const decoded = new LRUCache<string, any>({ max: 2000, ttl: parsePositiveIntEnv(process.env.CONFIG_MEMORY_TTL_SEC, 30, 1) * 1000 });
const missing = new LRUCache<string, true>({ max: 5000, ttl: parsePositiveIntEnv(process.env.CONFIG_MISSING_TTL_SEC, 60, 1) * 1000 });

class ConfigCache {
  async get(key: string): Promise<any> {
    const held = decoded.get(key);
    if (held !== undefined) return held;
    if (!redis || redis.status !== 'ready') return null;
    try {
      const raw = await redis.getBuffer(redisKey(key));
      const value = raw ? await decodeCachePayload(raw) : null;
      if (value !== null) decoded.set(key, value);
      return value;
    } catch (err: any) {
      logger.warn(`get failed for ${String(key).substring(0, 8)}...: ${err.message}`);
      return null;
    }
  }

  /** A key the loader found nothing for; asked again only after the window, without a load. */
  rememberMissing(key: string): void {
    missing.set(key, true);
  }

  isMissing(key: string): boolean {
    return missing.has(key);
  }

  async set(key: string, value: any): Promise<void> {
    missing.delete(key);
    if (value === undefined || value === null) decoded.delete(key);
    else decoded.set(key, value);
    if (!redis || redis.status !== 'ready' || value === undefined) return;
    try {
      const payload = await encodeCachePayload(value, {
        compressionEnabled: isConfigCacheCompressionEnabled(),
      });
      await redis.set(redisKey(key), payload, 'EX', CONFIG_CACHE_TTL_SEC());
    } catch (err: any) {
      logger.warn(`set failed for ${String(key).substring(0, 8)}...: ${err.message}`);
    }
  }

  async del(key: string): Promise<void> {
    missing.delete(key);
    decoded.delete(key);
    pendingLoads.delete(redisKey(key));
    if (!redis || redis.status !== 'ready') return;
    try {
      await redis.del(redisKey(key));
    } catch (err: any) {
      logger.warn(`del failed for ${String(key).substring(0, 8)}...: ${err.message}`);
    }
  }

  async clear(): Promise<void> {
    decoded.clear();
    pendingLoads.clear();
    if (!redis || redis.status !== 'ready') return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) await redis.unlink(...keys);
      } while (cursor !== '0');
    } catch (err: any) {
      logger.warn(`clear failed: ${err.message}`);
    }
  }

  async getOrLoad(key: string, loader: () => Promise<any>): Promise<any> {
    if (!redis || redis.status !== 'ready') return loader();

    const cached = await this.get(key);
    if (cached !== null) return cached;

    const mapKey = redisKey(key);
    const existing = pendingLoads.get(mapKey);
    if (existing) {
      logger.debug(`Config load already in progress for ${String(key).substring(0, 8)}..., waiting`);
      return existing;
    }

    const loadPromise = (async () => {
      try {
        const value = await loader();
        if (value !== undefined && value !== null) {
          this.set(key, value).catch((err: any) => logger.warn(`Background set failed: ${err.message}`));
        }
        return value;
      } finally {
        pendingLoads.delete(mapKey);
      }
    })();

    pendingLoads.set(mapKey, loadPromise);
    return loadPromise;
  }

  isLoadPending(key: string): boolean {
    return pendingLoads.has(redisKey(key));
  }

  async stats({ countRedisEntries = false } = {}): Promise<{ pendingLoads: number; entries: number | null }> {
    const out: { pendingLoads: number; entries: number | null } = { pendingLoads: pendingLoads.size, entries: null };
    if (!countRedisEntries || !redis || redis.status !== 'ready') return out;
    try {
      let cursor = '0';
      let total = 0;
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500);
        cursor = next;
        total += keys.length;
      } while (cursor !== '0');
      out.entries = total;
    } catch (err: any) {
      logger.warn(`stats SCAN failed: ${err.message}`);
    }
    return out;
  }
}

const configCache = new ConfigCache();

if (redis) {
  logger.debug(`ConfigCache backed by Redis, TTL=${CONFIG_CACHE_TTL_SEC()}s`);
} else {
  logger.warn('ConfigCache: Redis unavailable, falling through to loader on every call');
}

export { configCache as default };
module.exports = configCache;
