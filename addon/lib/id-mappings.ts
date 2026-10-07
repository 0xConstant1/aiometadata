import consola from 'consola';
import { IdMap, IndexStats, MappingIndex, buildIndex, parseMappingCsv } from './id-mapping-index';
import { MappingSource, SOURCES, downloadCsv, readCachedCsv } from './mapping-sources';
const redis = require('./redisClient');
const logger = consola.withTag('ID Mappings');

const UPDATE_INTERVAL_HOURS = parseInt(process.env.WIKI_MAPPER_UPDATE_INTERVAL_HOURS || '24');
const MAINTENANCE_KEY = 'maintenance:last_wiki_mapper_update';

type MediaType = 'series' | 'movie';

const MEDIA: Record<MediaType, { primary: MappingSource; backfill: MappingSource; withTvmaze: boolean }> = {
  series: { primary: SOURCES.dinsSeries, backfill: SOURCES.wikiSeries, withTvmaze: true },
  movie: { primary: SOURCES.dinsMovies, backfill: SOURCES.wikiMovies, withTvmaze: false },
};

let indexes: Record<MediaType, MappingIndex> | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;

function parseSource(csv: string, source: MappingSource): IdMap[] {
  const { rows, invalid } = parseMappingCsv(csv);
  if (rows.length === 0) throw new Error(`${source.name} has no valid rows`);
  logger.info(`Parsed ${source.name}: ${rows.length} valid rows, ${invalid} invalid skipped`);
  return rows;
}

function build(type: MediaType, primaryCsv: string, backfillCsv: string): MappingIndex {
  const { primary, backfill, withTvmaze } = MEDIA[type];
  const index = buildIndex(parseSource(primaryCsv, primary), parseSource(backfillCsv, backfill), withTvmaze);
  const { primaryRows, backfilledRows, filled, conflicts } = index.stats;
  logger.info(`Built ${type} index: ${primaryRows} dins rows, ${backfilledRows} backfilled from Wikidata, filled ${JSON.stringify(filled)}, ${conflicts} conflicting Wikidata rows skipped`);
  return index;
}

async function loadAll(): Promise<Record<MediaType, MappingIndex>> {
  const [dinsSeries, wikiSeries, dinsMovies, wikiMovies] = await Promise.all(
    [SOURCES.dinsSeries, SOURCES.wikiSeries, SOURCES.dinsMovies, SOURCES.wikiMovies].map((source) => downloadCsv(source)),
  );
  return { series: build('series', dinsSeries, wikiSeries), movie: build('movie', dinsMovies, wikiMovies) };
}

async function markUpdated(): Promise<void> {
  if (redis && redis.status === 'ready') await redis.set(MAINTENANCE_KEY, Date.now().toString());
}

export async function refreshChangedMappings(): Promise<void> {
  ensureInitialized();
  const next = { ...indexes };
  let rebuilt = false;
  for (const type of ['series', 'movie'] as MediaType[]) {
    const { primary, backfill } = MEDIA[type];
    const [primaryCsv, backfillCsv] = await Promise.all([downloadCsv(primary, true), downloadCsv(backfill, true)]);
    if (primaryCsv === null && backfillCsv === null) continue;
    next[type] = build(type, primaryCsv ?? readCachedCsv(primary), backfillCsv ?? readCachedCsv(backfill));
    rebuilt = true;
  }
  if (rebuilt) indexes = next;
  else logger.info('Scheduled refresh found no changes. Keeping existing mappings.');
  await markUpdated();
}

function scheduleRefresh(): void {
  if (updateInterval) return;
  updateInterval = setInterval(async () => {
    logger.info(`Running scheduled update (every ${UPDATE_INTERVAL_HOURS} hours)...`);
    try {
      await refreshChangedMappings();
      logger.info('Scheduled update completed successfully.');
    } catch (error: any) {
      logger.error(`Scheduled update failed: ${error.message}`);
    }
  }, UPDATE_INTERVAL_HOURS * 60 * 60 * 1000);
  updateInterval.unref();
  logger.info(`Scheduled periodic updates every ${UPDATE_INTERVAL_HOURS} hours.`);
}

export async function initializeMappings(): Promise<void> {
  if (indexes) return;
  try {
    indexes = await loadAll();
    await markUpdated();
  } catch (error: any) {
    const message = error?.message || String(error);
    logger.error(`Initialization failed: ${message}`);
    throw new Error(`ID mappings failed to initialize: ${message}`);
  }
  scheduleRefresh();
  logger.info('Initialization complete');
}

function ensureInitialized(): void {
  if (!indexes) throw new Error('ID mappings not initialized. Ensure initializeMappings() is called at server startup.');
}

function indexFor(type: string): MappingIndex {
  ensureInitialized();
  return type === 'series' ? indexes.series : indexes.movie;
}

function byNumericId(map: Map<number, IdMap> | null, id: string): IdMap | undefined {
  const num = parseInt(id);
  return isNaN(num) || !map ? undefined : map.get(num);
}

export function getByImdbId(imdbId: string, type: 'series' | 'movie' = 'series'): IdMap | undefined {
  return indexFor(type).imdb.get(imdbId);
}

export function getByTmdbId(tmdbId: string, type: 'series' | 'movie' = 'series'): IdMap | undefined {
  return byNumericId(indexFor(type).tmdb, tmdbId);
}

export function getByTvdbId(tvdbId: string, type: 'series' | 'movie' = 'series'): IdMap | undefined {
  return byNumericId(indexFor(type).tvdb, tvdbId);
}

export const getSeriesByImdb = (imdbId: string) => getByImdbId(imdbId, 'series');
export const getSeriesByTmdb = (tmdbId: string) => getByTmdbId(tmdbId, 'series');
export const getSeriesByTvdb = (tvdbId: string) => getByTvdbId(tvdbId, 'series');
export const getMovieByImdb = (imdbId: string) => getByImdbId(imdbId, 'movie');
export const getMovieByTmdb = (tmdbId: string) => getByTmdbId(tmdbId, 'movie');
export const getMovieByTvdb = (tvdbId: string) => getByTvdbId(tvdbId, 'movie');

export function getSeriesByTvmaze(tvmazeId: string): IdMap | undefined {
  return byNumericId(indexFor('series').tvmaze, tvmazeId);
}

export function getMappingStats() {
  ensureInitialized();
  const { series, movie } = indexes;
  return {
    series: { imdb: series.imdb.size, tvdb: series.tvdb.size, tmdb: series.tmdb.size, tvmaze: series.tvmaze.size },
    movies: { imdb: movie.imdb.size, tvdb: movie.tvdb.size, tmdb: movie.tmdb.size },
  };
}

export function getIdMappingsStats() {
  const all: IndexStats[] = indexes ? [indexes.series.stats, indexes.movie.stats] : [];
  const sum = (pick: (stats: IndexStats) => number) => all.reduce((total, stats) => total + pick(stats), 0);
  const seriesCount = indexes ? indexes.series.stats.totalRows : 0;
  const moviesCount = indexes ? indexes.movie.stats.totalRows : 0;
  return {
    seriesCount,
    moviesCount,
    totalCount: seriesCount + moviesCount,
    dinsCount: sum((stats) => stats.primaryRows),
    backfilledCount: sum((stats) => stats.backfilledRows),
    filledFields: sum(({ filled }) => filled.imdbId + filled.tmdbId + filled.tvdbId + filled.tvmazeId),
    conflictsSkipped: sum((stats) => stats.conflicts),
    initialized: indexes !== null,
    updateIntervalHours: UPDATE_INTERVAL_HOURS,
  };
}

export async function forceUpdateIdMappings(): Promise<{ success: boolean; message: string; seriesCount: number; moviesCount: number }> {
  logger.info('Force update requested...');
  if (redis && redis.status === 'ready') {
    try {
      await redis.del(...Object.values(SOURCES).map((source) => source.etagKey));
    } catch (error: any) {
      logger.warn(`Failed to clear ETags: ${error.message}`);
    }
  }

  try {
    indexes = await loadAll();
    await markUpdated();
    scheduleRefresh();
    const { seriesCount, moviesCount } = getIdMappingsStats();
    logger.info(`Force update completed: ${seriesCount} series, ${moviesCount} movies`);
    return {
      success: true,
      message: `Updated successfully (${seriesCount.toLocaleString()} series, ${moviesCount.toLocaleString()} movies)`,
      seriesCount,
      moviesCount,
    };
  } catch (error: any) {
    logger.error(`Force update failed: ${error.message}`);
    const { seriesCount, moviesCount } = getIdMappingsStats();
    return { success: false, message: `Force update failed: ${error.message}`, seriesCount, moviesCount };
  }
}

export const mappings = {
  getByTvdbId,
  getByTmdbId,
  getByImdbId,
  getSeriesByImdb,
  getMovieByImdb,
  getSeriesByTmdb,
  getMovieByTmdb,
  getSeriesByTvdb,
  getMovieByTvdb,
  getSeriesByTvmaze,
  getStats: getMappingStats,
};

module.exports = {
  mappings,
  initializeMappings,
  refreshChangedMappings,
  getSeriesByImdb,
  getMovieByImdb,
  getSeriesByTmdb,
  getMovieByTmdb,
  getSeriesByTvdb,
  getMovieByTvdb,
  getSeriesByTvmaze,
  getByTvdbId,
  getByTmdbId,
  getByImdbId,
  getMappingStats,
  forceUpdateIdMappings,
  getIdMappingsStats,
};
