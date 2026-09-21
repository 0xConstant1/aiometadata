import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { type Capable, credentialFor, resumeSourcesFor } from './trackerSource';

const logger = consola.withTag('Jellyfin');

const idMapper: any = require('../id-mapper');
const animeListMapper: any = require('../anime-list-mapper');

export interface ResumeRow {
  /** Stremio id the meta is fetched with. */
  metaId: string;
  /** Exact video that was played, in the space the meta publishes. */
  videoId: string;
  /** `anime` where the anime mapping answered, so ids encode as the library does. */
  mediaType: 'anime' | 'series' | 'movie';
  kind: 'episode' | 'movie';
  progress: number;
  runtimeMinutes: number | null;
  updatedAt: number;
  /** Table rows only: when the row itself was last written. */
  writtenAt?: number;
}

const snapshots = new LRUCache<string, ResumeRow[]>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_RESUME_TTL', 60, 1) * 1000,
});

const inFlight = new Map<string, Promise<ResumeRow[]>>();

const generations = new Map<string, number>();
export const generationOf = (userUUID: string): number => generations.get(userUUID) ?? 0;

/**
 * A tracker names an episode in its own space, which for anime is rarely the
 * one the meta publishes: a row stored as TVDB S3E11 is `kitsu:49002:11` here.
 * The anidb pivot is what the meta path itself uses, so ids come back matching
 * the items already in the library rather than a second, parallel identity.
 */
export async function videoIdFor(
  ids: Record<string, any>,
  season: number,
  episode: number,
  config: any = {}
): Promise<{ metaId: string; videoId: string; mediaType: 'anime' | 'series' } | null> {
  // MDBList and PublicMetaDB number episodes the way TMDB does.
  if (ids.tmdb) {
    const viaTmdb = await fromTmdbNumbering(ids, season, episode, config);
    if (viaTmdb) return viaTmdb;
  }

  let tvdb = ids.tvdb;
  let imdb = ids.imdb;
  if (!tvdb && ids.tmdb) {
    tvdb = idMapper.getMappingByTmdbId(String(ids.tmdb), 'series')?.tvdb_id;
  }
  if (!tvdb && ids.imdb) {
    const found = idMapper.getMappingByImdbId(String(ids.imdb));
    if (idMapper.mappingIsType(found, 'series')) tvdb = found?.tvdb_id;
  }
  if ((!tvdb || !imdb) && ids.tmdb) {
    try {
      const wiki: any = require('../wiki-mapper');
      const mapped = wiki.getByTmdbId?.(String(ids.tmdb), 'series');
      if (!imdb && mapped?.imdbId) imdb = mapped.imdbId;
      if (!tvdb && mapped?.tvdbId) tvdb = mapped.tvdbId;
    } catch {
      // optional
    }
  }

  if (tvdb) {
    try {
      const anidb = await animeListMapper.resolveAnidbEpisodeFromTvdbEpisode(
        String(tvdb),
        season,
        episode
      );
      const mapping = anidb ? idMapper.getMappingByAnidbId(anidb.anidbId) : null;
      if (mapping?.kitsu_id) {
        return {
          metaId: `kitsu:${mapping.kitsu_id}`,
          videoId: `kitsu:${mapping.kitsu_id}:${anidb.anidbEpisode}`,
          mediaType: 'anime',
        };
      }
    } catch (error: any) {
      logger.debug(`Anime resolution failed for tvdb ${tvdb} S${season}E${episode}: ${error?.message}`);
    }
  }

  const base = imdb || (tvdb ? `tvdb:${tvdb}` : ids.tmdb ? `tmdb:${ids.tmdb}` : null);
  if (!base) return null;

  return { metaId: base, videoId: `${base}:${season}:${episode}`, mediaType: 'series' };
}

async function mdblistRows(apiKey: string, config: any): Promise<ResumeRow[]> {
  const { makeRateLimitedMDBListRequest } = require('../../utils/mdbList');
  const response = await makeRateLimitedMDBListRequest(`https://api.mdblist.com/sync/playback?apikey=${apiKey}`, apiKey, 'MDBList resume');

  const rows: ResumeRow[] = [];
  for (const entry of Array.isArray(response?.data) ? response.data : []) {
    const progress = Number(entry?.progress);
    if (!Number.isFinite(progress) || progress <= 0) continue;

    const updatedAt = Date.parse(entry?.updated_at ?? entry?.paused_at ?? '') || 0;
    const runtimeMinutes = Number.isFinite(Number(entry?.runtime)) ? Number(entry.runtime) : null;

    if (entry?.movie) {
      const ids = entry.movie.ids ?? {};
      const base = ids.imdb || (ids.tmdb ? `tmdb:${ids.tmdb}` : null);
      if (!base) continue;
      rows.push({ metaId: base, videoId: base, mediaType: 'movie', kind: 'movie', progress, runtimeMinutes, updatedAt });
      continue;
    }

    const show = entry?.show;
    const season = Number(entry?.episode?.season);
    const episode = Number(entry?.episode?.number);
    if (!show || !Number.isFinite(season) || !Number.isFinite(episode)) continue;

    const resolved = await videoIdFor(show.ids ?? {}, season, episode, config);
    if (!resolved) {
      logger.debug(`No id for a resume row: ${show.title} S${season}E${episode}`);
      continue;
    }

    rows.push({ ...resolved, kind: 'episode', progress, runtimeMinutes, updatedAt });
  }

  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Simkl answers with every id it knows and, for anime, the entry's own episode
// numbering beside the TVDB one, so a row names itself the way the meta does
// without going through the anidb pivot MDBList needs.
async function simklRows(tokenId: string): Promise<ResumeRow[]> {
  const { getSimklToken, fetchPlaybackSessions } = require('../../utils/simklUtils');

  const token = await getSimklToken(tokenId);
  if (!token?.access_token) return [];

  const rows: ResumeRow[] = [];
  for (const entry of await fetchPlaybackSessions(token.access_token)) {
    const progress = Number(entry?.progress);
    if (!Number.isFinite(progress) || progress <= 0) continue;

    const updatedAt = Date.parse(entry?.paused_at ?? '') || 0;
    const container = entry?.anime ?? entry?.show ?? entry?.movie;
    const ids = container?.ids ?? {};

    if (entry?.type === 'movie' || (!entry?.episode && entry?.movie)) {
      const base = ids.imdb || (ids.tmdb ? `tmdb:${ids.tmdb}` : null);
      if (!base) continue;
      rows.push({ metaId: base, videoId: base, mediaType: 'movie', kind: 'movie', progress, runtimeMinutes: null, updatedAt });
      continue;
    }

    if (!entry?.episode) continue;

    if (entry.anime && ids.kitsu) {
      const number = Number(entry.episode.number);
      if (!Number.isFinite(number)) continue;
      rows.push({
        metaId: `kitsu:${ids.kitsu}`,
        videoId: `kitsu:${ids.kitsu}:${number}`,
        mediaType: 'anime',
        kind: 'episode',
        progress,
        runtimeMinutes: null,
        updatedAt,
      });
      continue;
    }

    const base = ids.imdb || (ids.tvdb ? `tvdb:${ids.tvdb}` : null);
    const season = Number(entry.episode.tvdb_season ?? entry.episode.season);
    const number = Number(entry.episode.tvdb_number ?? entry.episode.number);
    if (!base || !Number.isFinite(season) || !Number.isFinite(number)) continue;

    rows.push({
      metaId: base,
      videoId: `${base}:${season}:${number}`,
      mediaType: 'series',
      kind: 'episode',
      progress,
      runtimeMinutes: null,
      updatedAt,
    });
  }

  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function fromTmdbNumbering(
  ids: Record<string, any>,
  season: number,
  episode: number,
  config: any = {}
): Promise<{ metaId: string; videoId: string; mediaType: 'anime' | 'series' } | null> {
  const tmdb = String(ids.tmdb);
  try {
    if (idMapper.getMappingByTmdbId(tmdb, 'series')) {
      const kitsu = await idMapper.resolveKitsuEpisodeFromTmdb(Number(tmdb), season, episode, config);
      if (kitsu?.kitsuId) {
        return { metaId: `kitsu:${kitsu.kitsuId}`, videoId: `kitsu:${kitsu.kitsuId}:${kitsu.episodeNumber}`, mediaType: 'anime' };
      }
    }
    const position = await idMapper.tmdbEpisodePosition(Number(tmdb), season, episode, config);
    if (position === episode) return null;
    const base = ids.imdb || (ids.tvdb ? `tvdb:${ids.tvdb}` : `tmdb:${tmdb}`);
    return { metaId: base, videoId: `${base}:${season}:${position}`, mediaType: 'series' };
  } catch (error: any) {
    logger.debug(`TMDB numbering for ${tmdb} S${season}E${episode} failed: ${error?.message}`);
    return null;
  }
}

async function pmdbRows(apiKey: string, config: any): Promise<ResumeRow[]> {
  const { fetchResume } = require('../../utils/publicmetadbUtils');
  const rows: ResumeRow[] = [];
  for (const entry of await fetchResume(apiKey)) {
    const progress = Number(entry?.progress);
    if (!Number.isFinite(progress) || progress <= 0 || !entry?.tmdb_id) continue;
    const updatedAt = Date.parse(entry?.updated ?? entry?.created ?? '') || 0;
    const runtimeMinutes = Number(entry?.runtime_ms) > 0 ? Math.round(Number(entry.runtime_ms) / 60000) : null;

    if (entry.media_type === 'movie') {
      const base = await movieBase(entry.tmdb_id, config);
      rows.push({ metaId: base, videoId: base, mediaType: 'movie', kind: 'movie', progress, runtimeMinutes, updatedAt });
      continue;
    }
    const season = Number(entry?.season);
    const episode = Number(entry?.episode);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
    const resolved = await videoIdFor({ tmdb: entry.tmdb_id }, season, episode, config);
    if (resolved) rows.push({ ...resolved, kind: 'episode', progress, runtimeMinutes, updatedAt });
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A film's IMDb id for its TMDB id; the TMDB spelling when none is known. */
export async function movieBase(tmdbId: string | number, config: any = {}): Promise<string> {
  try {
    const { resolveAllIds } = require('../id-resolver');
    const ids = await resolveAllIds(`tmdb:${tmdbId}`, 'movie', config, {}, ['imdb']);
    if (ids?.imdbId) return String(ids.imdbId);
  } catch {}
  return `tmdb:${tmdbId}`;
}

async function rowsFrom(service: Capable, credential: string, config: any): Promise<ResumeRow[]> {
  if (service === 'mdblist') return mdblistRows(credential, config);
  if (service === 'simkl') return simklRows(credential);
  if (service === 'publicmetadb') return pmdbRows(credential, config);

  logger.debug(`Resume source ${service} has no reader yet`);
  return [];
}

// No id mapping: the video id was recorded in the space the client played it in.
async function ownRows(userUUID: string, profile: string): Promise<ResumeRow[]> {
  const database: any = require('../database');
  const { parseStremioId } = require('./ids');
  const limit = envInt('JELLYFIN_RESUME_OWN_LIMIT', 100, 1);

  let records: any[] = [];
  try {
    records = await database.listResume(userUUID, limit, profile);
  } catch (error: any) {
    logger.debug(`Own resume rows unavailable: ${error?.message || error}`);
    return [];
  }

  const rows: ResumeRow[] = [];
  for (const r of records) {
    const videoId = String(r.video_id);
    const runtimeMs = Number(r.runtime_ms) || 0;
    const positionMs = Number(r.position_ms) || 0;
    if (runtimeMs <= 0 || positionMs <= 0) continue;

    const parsed = parseStremioId(videoId);
    const isEpisode = Boolean(parsed && parsed.episode !== null && parsed.episode !== undefined);
    const mediaType: ResumeRow['mediaType'] = !isEpisode
      ? 'movie'
      : parsed.idType === 'kitsu' || parsed.idType === 'mal' || parsed.idType === 'anilist' ? 'anime' : 'series';

    rows.push({
      metaId: isEpisode ? parsed.base : videoId,
      videoId,
      mediaType,
      kind: isEpisode ? 'episode' : 'movie',
      progress: Math.min(100, (positionMs / runtimeMs) * 100),
      runtimeMinutes: Math.round(runtimeMs / 60000),
      updatedAt: Number(r.last_played_at) || Number(r.updated_at) || 0,
      writtenAt: Number(r.updated_at) || 0,
    });
  }

  // The earliest write of a batch is the spelling the client played under.
  const { dedupeByAlias } = require('./aliases');
  const deduped: ResumeRow[] = await dedupeByAlias([...rows].sort((a, b) => (a.writtenAt ?? 0) - (b.writtenAt ?? 0)));
  return deduped.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function resumeSnapshot(userUUID: string, config: any): Promise<ResumeRow[]> {
  const { profileKey, readsTrackers } = require('./profiles');
  const database: any = require('../database');
  const profile = profileKey(config);

  // A tracker only adds what this server never saw, such as another device. A
  // video the table knows at all is the table's call, finished or not.
  const own = await ownRows(userUUID, profile);
  const tracker = readsTrackers(config) ? await trackerSnapshot(userUUID, config) : [];
  let known = new Map<string, any>();
  try {
    const { getPlaystatesAcross } = require('./aliases');
    known = await getPlaystatesAcross(userUUID, tracker.map((r) => r.videoId), profile);
  } catch (error: any) {
    logger.debug(`Own playstate rows unavailable: ${error?.message || error}`);
  }
  return [...own, ...tracker.filter((r) => !known.has(r.videoId))].sort((a, b) => b.updatedAt - a.updatedAt);
}

// Each connected service is read: a title paused through one app is only on
// that app's tracker. The same video on two of them takes the newer position.
export async function trackerSnapshot(userUUID: string, config: any): Promise<ResumeRow[]> {
  const parts = await Promise.all(
    resumeSourcesFor(config).map((service) => serviceSnapshot(userUUID, config, service))
  );
  const merged = new Map<string, ResumeRow>();
  for (const row of parts.flat()) {
    const held = merged.get(row.videoId);
    if (!held || row.updatedAt > held.updatedAt) merged.set(row.videoId, row);
  }
  const { dedupeByAlias } = require('./aliases');
  return dedupeByAlias([...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt));
}

async function serviceSnapshot(userUUID: string, config: any, service: Capable): Promise<ResumeRow[]> {
  const credential = credentialFor(config, service);
  if (!credential) return [];

  const key = `${userUUID}:${service}`;
  const cached = snapshots.get(key);
  if (cached) return cached;

  const generation = generationOf(userUUID);
  const flightKey = `${generation}:${key}`;
  const running = inFlight.get(flightKey);
  if (running) return running;

  const started = (async () => {
    try {
      const rows = await rowsFrom(service, credential, config);
      if (generationOf(userUUID) === generation) snapshots.set(key, rows);
      logger.debug(`Resume snapshot for ${userUUID} from ${service}: ${rows.length} rows`);
      return rows;
    } catch (error: any) {
      if (generationOf(userUUID) === generation) snapshots.set(key, []);
      logger.warn(`Resume snapshot from ${service} failed: ${error?.message || error}; not read again for ${envInt('JELLYFIN_RESUME_TTL', 60, 1)}s`);
      return [];
    } finally {
      if (inFlight.get(flightKey) === started) inFlight.delete(flightKey);
    }
  })();

  inFlight.set(flightKey, started);
  return started;
}

// A finished title can hold a resume point at the same time, which is what a
// rewatch is, so Played comes from the watch history rather than being assumed
// false because the row is resumable.
/** Dropped when this server is itself the thing that changed the state. */
export function invalidateResume(userUUID: string): void {
  generations.set(userUUID, generationOf(userUUID) + 1);
  for (const key of [...snapshots.keys()]) {
    if (String(key).startsWith(`${userUUID}:`)) snapshots.delete(key);
  }
  for (const key of [...nextUpPages.keys()]) {
    if (String(key).startsWith(`${userUUID}:`)) nextUpPages.delete(key);
  }
}

const nextUpPages = new LRUCache<string, any[]>({
  max: envInt('JELLYFIN_NEXTUP_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_NEXTUP_TTL', 900, 1) * 1000,
});
const nextUpInFlight = new Map<string, Promise<any[]>>();

/** One Next Up list per shelf shape, shared by concurrent asks and kept briefly; a play drops it. */
export async function memoNextUp(
  userUUID: string,
  key: string,
  build: () => Promise<any[]>,
  validUntil?: (result: any[]) => number | null
): Promise<any[]> {
  const held = nextUpPages.get(key);
  if (held) return held;
  const generation = generationOf(userUUID);
  const flightKey = `${generation}:${key}`;
  const running = nextUpInFlight.get(flightKey);
  if (running) return running;
  const work = build()
    .then((result) => {
      if (generationOf(userUUID) === generation) {
        const until = validUntil?.(result);
        const left = until ? until - Date.now() : null;
        nextUpPages.set(key, result, left && left > 0 && left < nextUpPages.ttl! ? { ttl: left } : undefined);
      }
      return result;
    })
    .finally(() => {
      if (nextUpInFlight.get(flightKey) === work) nextUpInFlight.delete(flightKey);
    });
  nextUpInFlight.set(flightKey, work);
  return work;
}

export function resumeUserData(
  id: string,
  row: ResumeRow,
  runTimeTicks: number | null,
  played = false
): any {
  const fromItem = runTimeTicks && runTimeTicks > 0 ? runTimeTicks : null;
  const fromRow = row.runtimeMinutes ? row.runtimeMinutes * 60 * 1000 * 10000 : null;
  const total = fromItem ?? fromRow ?? 0;

  return {
    PlaybackPositionTicks: Math.round((total * row.progress) / 100),
    PlayedPercentage: row.progress,
    PlayCount: played ? 1 : 0,
    IsFavorite: false,
    Played: played,
    ...(row.updatedAt > 0 ? { LastPlayedDate: new Date(row.updatedAt).toISOString() } : {}),
    Key: id,
    ItemId: id,
  };
}
