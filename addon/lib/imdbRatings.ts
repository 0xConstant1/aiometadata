import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { Readable } from 'stream';
import { request } from 'undici';
import consola from 'consola';
import redis from './redisClient';
const buildInfo = require('./buildInfo');

const logger = consola.withTag('IMDB Ratings');

// Constants
const IMDB_RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const REDIS_RATINGS_ETAG_KEY = 'imdb-ratings-etag';
const REDIS_RATINGS_HASH = 'imdb:ratings';
const UPDATE_INTERVAL_HOURS = parseInt(process.env.IMDB_RATINGS_UPDATE_INTERVAL_HOURS || '24');
const UPDATE_INTERVAL_MS = UPDATE_INTERVAL_HOURS * 60 * 60 * 1000;
const RETRY_BASE_MS = 15 * 60 * 1000;
const NOT_READY_WARN_INTERVAL_MS = 60 * 1000;
const MIN_VOTES = 20;
const REDIS_BATCH_SIZE = 10000;

export interface ImdbRating {
  rating: number;
  votes: number;
}

// State tracking
let ratingsLoaded = false;
let ratingsUpdateInterval: ReturnType<typeof setInterval> | null = null;
let ratingsCount = 0;
let updateInFlight: Promise<boolean> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;
let skippedWhileNotReady = 0;
let lastNotReadyWarnAt = 0;

// Stats tracking
let totalRequests = 0;
let cacheHits = 0;
let cacheMisses = 0;

/**
 * Parse a Redis-stored rating string "rating|votes" into an ImdbRating object
 */
function parseRedisRating(value: string): ImdbRating | null {
  const [ratingStr, votesStr] = value.split('|');
  const rating = parseFloat(ratingStr);
  const votes = parseInt(votesStr, 10);
  if (isNaN(rating) || isNaN(votes)) return null;
  return { rating, votes };
}

/**
 * Downloads and caches IMDb ratings from the official IMDb dataset.
 * Uses streaming decompression to minimize peak memory usage.
 * Stores ratings in Redis hash for persistence.
 */
export async function downloadAndCacheIMDbRatings(): Promise<boolean> {
  const isRedisReady = redis?.status === 'ready';
  let tempRatingsHashKey: string | null = null;

  try {
    if (isRedisReady && redis) {
      const savedEtag = await redis.get(REDIS_RATINGS_ETAG_KEY);

      if (savedEtag) {
        const headResponse = await request(IMDB_RATINGS_URL, {
          method: 'HEAD',
          headers: { 'User-Agent': `AIOMetadata/${buildInfo.version}` }
        });
        const remoteEtag = headResponse.headers.etag;

        if (savedEtag === remoteEtag && redis) {
          const existingCount = await redis.hlen(REDIS_RATINGS_HASH);
          if (existingCount > 0) {
            logger.info('Remote file unchanged (ETag match). Using Redis cache.');
            ratingsLoaded = true;
            ratingsCount = existingCount;
            logger.success(`${existingCount.toLocaleString()} ratings available in Redis.`);
            return true;
          }
        }

        logger.info('Remote file changed or Redis empty. Downloading new ratings...');
      }
    } else {
      logger.warn('Redis not available. IMDb ratings will not be available.');
      return false;
    }

    logger.start('Downloading ratings dataset (streaming)...');
    const response = await request(IMDB_RATINGS_URL, {
      method: 'GET',
      headers: { 'User-Agent': 'AIOMetadata/1.0' },
      bodyTimeout: 120000,
      headersTimeout: 60000
    });

    if (!redis) return false;

    // Stage into a temporary hash and swap atomically at the end.
    tempRatingsHashKey = `${REDIS_RATINGS_HASH}:tmp:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await redis.del(tempRatingsHashKey);

    logger.info('Streaming and parsing ratings...');
    const gunzipStream = createGunzip();
    const bodyStream = Readable.from(response.body as AsyncIterable<Uint8Array>);
    const rl = createInterface({
      input: bodyStream.pipe(gunzipStream),
      crlfDelay: Infinity
    });

    let count = 0;
    let filtered = 0;
    let isFirstLine = true;
    let pipeline = redis!.pipeline();

    for await (const line of rl) {
      if (isFirstLine) {
        isFirstLine = false;
        continue;
      }
      if (!line.trim()) continue;

      const [id, ratingStr, votesStr] = line.split('\t');
      const rating = parseFloat(ratingStr);
      const votes = parseInt(votesStr, 10);

      if (!id || isNaN(rating) || isNaN(votes)) continue;

      if (votes < MIN_VOTES) {
        filtered++;
        continue;
      }

      pipeline.hset(tempRatingsHashKey, id, `${rating}|${votes}`);
      count++;

      if (count % REDIS_BATCH_SIZE === 0) {
        await pipeline.exec();
        pipeline = redis!.pipeline();
        if (count % 100000 === 0) {
          logger.debug(`Processed ${count.toLocaleString()} ratings...`);
        }
      }
    }

    if (count % REDIS_BATCH_SIZE !== 0) {
      await pipeline.exec();
    }

    logger.debug(`Filtered out ${filtered.toLocaleString()} ratings with < ${MIN_VOTES} votes.`);

    if (count === 0) {
      throw new Error('Parsed zero IMDb ratings; aborting atomic swap to preserve existing cache.');
    }

    await redis.rename(tempRatingsHashKey, REDIS_RATINGS_HASH);
    tempRatingsHashKey = null;

    if (response.headers.etag && redis) {
      await redis.set(REDIS_RATINGS_ETAG_KEY, response.headers.etag as string);
    }

    if (redis) {
      await redis.set('maintenance:last_imdb_ratings_update', Date.now().toString());
    }

    ratingsLoaded = true;
    ratingsCount = count;
    logger.success(`Successfully loaded ${count.toLocaleString()} ratings into Redis.`);
    return true;

  } catch (error) {
    if (redis && tempRatingsHashKey) {
      try {
        await redis.del(tempRatingsHashKey);
      } catch (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : 'Unknown cleanup error';
        logger.warn(`Failed to clean up temporary IMDb ratings hash (${tempRatingsHashKey}):`, cleanupMessage);
      }
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to download or process ratings:', errorMessage);
    return false;
  }
}

/** Throttled: a reconnect would otherwise log once per lookup. */
function noteSkippedWhileNotReady(): void {
  skippedWhileNotReady++;
  const now = Date.now();
  if (now - lastNotReadyWarnAt < NOT_READY_WARN_INTERVAL_MS) return;
  logger.warn(`Redis is ${redis?.status ?? 'unavailable'}; ${skippedWhileNotReady} rating lookup(s) returned no rating.`);
  lastNotReadyWarnAt = now;
  skippedWhileNotReady = 0;
}

function scheduleRetryIfFailed(success: boolean): boolean {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (success) {
    consecutiveFailures = 0;
    return true;
  }

  const delay = Math.min(RETRY_BASE_MS * 2 ** consecutiveFailures, UPDATE_INTERVAL_MS);
  consecutiveFailures++;
  logger.warn(`IMDb ratings update failed; retrying in ${Math.round(delay / 60000)} minutes.`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void runRatingsUpdate();
  }, delay);
  retryTimer.unref?.();
  return false;
}

/** A failed load retries with backoff rather than waiting for the next daily run. */
function runRatingsUpdate(): Promise<boolean> {
  if (!updateInFlight) {
    updateInFlight = downloadAndCacheIMDbRatings()
      .then(scheduleRetryIfFailed)
      .finally(() => { updateInFlight = null; });
  }
  return updateInFlight;
}

/**
 * Gets the IMDb rating for a given IMDb ID.
 */
export async function getImdbRating(imdbId: string): Promise<ImdbRating | null> {
  if (!imdbId) return null;

  try {
    totalRequests++;
    
    const isRedisReady = redis?.status === 'ready';
    if (isRedisReady && redis) {
      const result = await redis.hget(REDIS_RATINGS_HASH, imdbId);
      if (result) {
        const rating = parseRedisRating(result);
        if (rating) {
          cacheHits++;
          return rating;
        }
      }
    } else {
      noteSkippedWhileNotReady();
    }

    cacheMisses++;
    return null;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`Error fetching rating for ${imdbId}:`, errorMessage);
    return null;
  }
}

/**
 * One HMGET for a whole page of ids. Returns only the ids that resolved.
 */
export async function getImdbRatingStrings(imdbIds: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const ids = [...new Set(imdbIds.filter(Boolean))];
  if (ids.length === 0) return found;

  try {
    if (!redis) return found;

    totalRequests += ids.length;
    const values: Array<string | null> = await redis.hmget(REDIS_RATINGS_HASH, ...ids);

    ids.forEach((id, index) => {
      const raw = values?.[index];
      if (!raw) {
        cacheMisses++;
        return;
      }
      const rating = parseRedisRating(raw);
      if (!rating) {
        cacheMisses++;
        return;
      }
      cacheHits++;
      found.set(id, String(rating.rating));
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.warn('Error fetching ratings batch:', errorMessage);
  }

  return found;
}

/**
 * Gets the IMDb rating as a formatted string
 */
export async function getImdbRatingString(imdbId: string): Promise<string | undefined> {
  const result = await getImdbRating(imdbId);
  return result ? String(result.rating) : undefined;
}

export async function ratingsAvailable(): Promise<boolean> {
  try {
    if (redis?.status !== 'ready') return false;
    return (await redis.hlen(REDIS_RATINGS_HASH)) > 0;
  } catch {
    return false;
  }
}

/**
 * Initialize ratings on startup
 */
export async function initializeRatings(): Promise<void> {
  if (!redis) {
    logger.warn('Redis is not available. IMDb ratings will not be available.');
    return;
  }

  logger.start('Initializing IMDb ratings...');
  await runRatingsUpdate();

  // Schedule periodic updates
  if (!ratingsUpdateInterval) {
    ratingsUpdateInterval = setInterval(async () => {
      logger.info(`Running scheduled IMDb ratings update (every ${UPDATE_INTERVAL_HOURS} hours)...`);
      if (await runRatingsUpdate()) {
        logger.success('Scheduled IMDb ratings update completed.');
      }
    }, UPDATE_INTERVAL_MS);
    logger.info(`Scheduled periodic IMDb ratings updates every ${UPDATE_INTERVAL_HOURS} hours.`);
  }
}

/**
 * Get IMDb ratings statistics
 */
export function getRatingsStats() {
  const hitPercentage = totalRequests > 0 ? parseFloat(((cacheHits / totalRequests) * 100).toFixed(1)) : 0;
  const missPercentage = totalRequests > 0 ? parseFloat(((cacheMisses / totalRequests) * 100).toFixed(1)) : 0;

  return {
    totalRequests,
    datasetHits: cacheHits,
    datasetPercentage: hitPercentage,
    datasetMisses: cacheMisses,
    missPercentage,
    ratingsLoaded: ratingsCount
  };
}

/**
 * Force update IMDb ratings
 */
export async function forceUpdateImdbRatings(): Promise<{ success: boolean; message: string; count: number }> {
  logger.info('Force update requested...');

  const isRedisReady = redis?.status === 'ready';

  if (!isRedisReady) {
    return {
      success: false,
      message: 'Redis not available',
      count: 0
    };
  }

  try {
    await redis!.del(REDIS_RATINGS_ETAG_KEY);

    const success = await runRatingsUpdate();
    const count = await redis!.hlen(REDIS_RATINGS_HASH);

    await redis!.set('maintenance:last_imdb_ratings_update', Date.now().toString());

    if (success) {
      logger.success(`Force update completed: ${count.toLocaleString()} ratings`);
      return {
        success: true,
        message: `Updated successfully (${count.toLocaleString()} ratings)`,
        count
      };
    } else {
      return {
        success: false,
        message: 'Force update failed',
        count
      };
    }
  } catch (error: any) {
    logger.error(`Force update failed: ${error.message}`);
    return {
      success: false,
      message: `Force update failed: ${error.message}`,
      count: 0
    };
  }
}

/**
 * Get stats for IMDb Ratings (dashboard)
 */
export function getImdbRatingsStatsForDashboard(): { count: number; initialized: boolean; updateIntervalHours: number } {
  return {
    count: ratingsCount,
    initialized: ratingsLoaded,
    updateIntervalHours: UPDATE_INTERVAL_HOURS
  };
}
