import consola from 'consola';
import { createHash } from 'crypto';
import { envInt } from '../../utils/envNumber';
import { httpGet, httpPost } from '../../utils/httpClient';
import { credentialFor } from './trackerSource';

const logger = consola.withTag('Jellyfin');

export type WatchlistKind = 'movies' | 'series' | 'anime';

export interface WatchlistEntry {
  metaId: string;
  mediaType: 'movie' | 'series' | 'anime';
  /** The shelf the service files it under, which is what a pick names. */
  kind: WatchlistKind;
  addedAt: number;
}

export type WatchlistIds = { imdb?: string; tmdb?: number | string; tvdb?: number | string; kitsu?: number | string; mal?: number | string };

function metaIdFor(ids: Record<string, any>, kind: 'movie' | 'show', anime = false): WatchlistEntry | null {
  const shelf: WatchlistKind = anime ? 'anime' : kind === 'movie' ? 'movies' : 'series';
  if (kind === 'movie') {
    const base = ids.imdb || (ids.tmdb ? `tmdb:${ids.tmdb}` : null);
    return base ? { metaId: String(base), mediaType: 'movie', kind: shelf, addedAt: 0 } : null;
  }
  if (anime && !ids.imdb && ids.kitsu) return { metaId: `kitsu:${ids.kitsu}`, mediaType: 'anime', kind: shelf, addedAt: 0 };
  const base = ids.imdb || (ids.tvdb ? `tvdb:${ids.tvdb}` : ids.tmdb ? `tmdb:${ids.tmdb}` : null);
  return base ? { metaId: String(base), mediaType: anime ? 'anime' : 'series', kind: shelf, addedAt: 0 } : null;
}

async function mdblistEntries(apiKey: string): Promise<WatchlistEntry[]> {
  const out: WatchlistEntry[] = [];
  const pageSize = 500;
  for (let offset = 0; offset < envInt('JELLYFIN_WATCHLIST_MAX_ITEMS', 5000, 100); offset += pageSize) {
    const { makeRateLimitedMDBListRequest } = require('../../utils/mdbList');
    const response = await makeRateLimitedMDBListRequest(
      `https://api.mdblist.com/watchlist/items?limit=${pageSize}&offset=${offset}&unified=true&apikey=${apiKey}`,
      apiKey,
      `MDBList watchlist page ${offset / pageSize + 1}`
    );
    const items = Array.isArray(response?.data) ? response.data : [];
    for (const item of items) {
      const entry = metaIdFor(item?.ids ?? { imdb: item?.imdb_id, tmdb: item?.id, tvdb: item?.tvdb_id }, item?.mediatype === 'movie' ? 'movie' : 'show');
      if (entry) out.push({ ...entry, addedAt: Date.parse(item?.watchlist_at ?? '') || 0 });
    }
    if (items.length < pageSize || String(response?.headers?.['x-has-more'] ?? '').toLowerCase() === 'false') break;
  }
  return out;
}

async function simklEntries(tokenId: string): Promise<WatchlistEntry[]> {
  const { getSimklToken, fetchSimklAllItems } = require('../../utils/simklUtils');
  const token = await getSimklToken(tokenId);
  if (!token?.access_token) return [];
  const data = await fetchSimklAllItems(token.access_token);
  const out: WatchlistEntry[] = [];
  for (const entry of Array.isArray(data?.movies) ? data.movies : []) {
    if (entry?.status !== 'plantowatch') continue;
    const mapped = metaIdFor(entry?.movie?.ids ?? {}, 'movie');
    if (mapped) out.push({ ...mapped, addedAt: Date.parse(entry?.added_to_watchlist_at ?? entry?.last_watched_at ?? '') || 0 });
  }
  for (const entry of Array.isArray(data?.shows) ? data.shows : []) {
    if (entry?.status !== 'plantowatch') continue;
    const mapped = metaIdFor(entry?.show?.ids ?? {}, 'show');
    if (mapped) out.push({ ...mapped, addedAt: Date.parse(entry?.added_to_watchlist_at ?? '') || 0 });
  }
  const idMapper: any = require('../id-mapper');
  for (const entry of Array.isArray(data?.anime) ? data.anime : []) {
    if (entry?.status !== 'plantowatch') continue;
    const ids = { ...(entry?.show?.ids ?? {}) };
    if (!ids.kitsu && ids.mal) ids.kitsu = idMapper.getMappingByMalId(Number(ids.mal))?.kitsu_id;
    const mapped = metaIdFor(ids, entry?.anime_type === 'movie' ? 'movie' : 'show', true);
    if (mapped) out.push({ ...mapped, addedAt: Date.parse(entry?.added_to_watchlist_at ?? '') || 0 });
  }
  return out;
}

async function traktEntries(tokenId: string): Promise<WatchlistEntry[]> {
  const { getTraktToken } = require('../../utils/traktUtils');
  const token = await getTraktToken(tokenId);
  const accessToken = token?.access_token ?? token;
  if (!accessToken) return [];
  const response = await httpGet('https://api.trakt.tv/sync/watchlist?extended=min', {
    timeout: envInt('JELLYFIN_RESUME_TIMEOUT_MS', 10000, 1000),
    headers: { 'trakt-api-version': '2', 'trakt-api-key': process.env.TRAKT_CLIENT_ID || '', Authorization: `Bearer ${accessToken}` },
  });
  const out: WatchlistEntry[] = [];
  for (const item of Array.isArray(response?.data) ? response.data : []) {
    const kind = item?.type === 'movie' ? 'movie' : item?.type === 'show' ? 'show' : null;
    if (!kind) continue;
    const mapped = metaIdFor(item?.[kind]?.ids ?? {}, kind);
    if (mapped) out.push({ ...mapped, addedAt: Date.parse(item?.listed_at ?? '') || 0 });
  }
  return out;
}

export type WatchlistService = 'mdblist' | 'trakt' | 'simkl' | 'anilist' | 'mal';
export const WATCHLIST_SERVICES: WatchlistService[] = ['mdblist', 'trakt', 'simkl', 'anilist', 'mal'];
export const SERVICE_KINDS: Record<WatchlistService, WatchlistKind[]> = {
  mdblist: ['movies', 'series'],
  trakt: ['movies', 'series'],
  simkl: ['movies', 'series', 'anime'],
  anilist: ['anime'],
  mal: ['anime'],
};

function connected(config: any, service: WatchlistService): boolean {
  switch (service) {
    case 'anilist': return Boolean(config?.apiKeys?.anilistTokenId) && config?.anilistWatchTracking !== false;
    case 'mal': return Boolean(config?.apiKeys?.malTokenId) && config?.malWatchTracking !== false;
    default: return Boolean(credentialFor(config, service));
  }
}

/**
 * What the configuration's watchlist reads and writes, per service and shelf.
 * A pick is `service` for every shelf or `service:shelf`; none means every
 * connected service in full.
 */
export function watchlistPicks(config: any): Map<WatchlistService, Set<WatchlistKind>> {
  const out = new Map<WatchlistService, Set<WatchlistKind>>();
  if ((config?.jellyfinResumeSource ?? 'auto') === 'off') return out;
  const picked: string[] = Array.isArray(config?.jellyfinWatchlistServices) ? config.jellyfinWatchlistServices.map(String) : [];
  for (const service of WATCHLIST_SERVICES) {
    if (!connected(config, service)) continue;
    const kinds = new Set<WatchlistKind>();
    for (const token of picked) {
      const [name, shelf] = token.split(':');
      if (name !== service) continue;
      for (const kind of SERVICE_KINDS[service]) {
        if (!shelf || shelf === kind) kinds.add(kind);
      }
    }
    if (!picked.length) for (const kind of SERVICE_KINDS[service]) kinds.add(kind);
    if (kinds.size) out.set(service, kinds);
  }
  return out;
}

export function watchlistServices(config: any): WatchlistService[] {
  return [...watchlistPicks(config).keys()];
}

async function anilistEntries(userUUID: string): Promise<WatchlistEntry[]> {
  const anilist = require('../anilistTracker');
  const idMapper: any = require('../id-mapper');
  const accessToken = await anilist.getValidAccessToken(userUUID);
  if (!accessToken) return [];
  const out: WatchlistEntry[] = [];
  for (const anilistId of await anilist.fetchPlanningIds(accessToken)) {
    const mapping = idMapper.getMappingByAnilistId(anilistId);
    const entry = mapping ? metaIdFor({ imdb: mapping.imdb_id, kitsu: mapping.kitsu_id, tvdb: mapping.tvdb_id, tmdb: mapping.themoviedb_id }, mapping.type?.toLowerCase() === 'movie' ? 'movie' : 'show', true) : null;
    if (entry) out.push(entry);
  }
  return out;
}

async function malEntries(userUUID: string): Promise<WatchlistEntry[]> {
  const mal = require('../malTracker');
  const idMapper: any = require('../id-mapper');
  const accessToken = await mal.getValidAccessToken(userUUID);
  if (!accessToken) return [];
  const out: WatchlistEntry[] = [];
  for (const malId of await mal.fetchPlanToWatchIds(accessToken)) {
    const mapping = idMapper.getMappingByMalId(malId);
    const entry = mapping ? metaIdFor({ imdb: mapping.imdb_id, kitsu: mapping.kitsu_id, tvdb: mapping.tvdb_id, tmdb: mapping.themoviedb_id }, mapping.type?.toLowerCase() === 'movie' ? 'movie' : 'show', true) : null;
    if (entry) out.push(entry);
  }
  return out;
}

const cache = new Map<string, { at: number; rows: WatchlistEntry[] }>();

function serviceKey(config: any, userUUID: string, service: WatchlistService): string {
  const seed = service === 'anilist' ? `${userUUID}:${config?.apiKeys?.anilistTokenId}` : service === 'mal' ? `${userUUID}:${config?.apiKeys?.malTokenId}` : String(credentialFor(config, service));
  return `${service}:${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`;
}

async function serviceEntries(config: any, userUUID: string, service: WatchlistService): Promise<WatchlistEntry[]> {
  const key = serviceKey(config, userUUID, service);
  const ttl = envInt('JELLYFIN_WATCHLIST_TTL', 300, 10) * 1000;
  const held = cache.get(key);
  if (held && Date.now() - held.at < ttl) return held.rows;
  try {
    const credential = service === 'anilist' || service === 'mal' ? '' : String(credentialFor(config, service) || '');
    const rows =
      service === 'mdblist' ? await mdblistEntries(credential)
      : service === 'simkl' ? await simklEntries(credential)
      : service === 'trakt' ? await traktEntries(credential)
      : service === 'anilist' ? await anilistEntries(userUUID)
      : await malEntries(userUUID);
    cache.set(key, { at: Date.now(), rows });
    return rows;
  } catch (error: any) {
    logger.warn(`Watchlist from ${service} failed: ${error?.message || error}`);
    return held?.rows ?? [];
  }
}

export async function trackerWatchlist(config: any, userUUID: string): Promise<WatchlistEntry[]> {
  const picks = watchlistPicks(config);
  const parts = await Promise.all([...picks].map(async ([service, kinds]) =>
    (await serviceEntries(config, userUUID, service)).filter((row) => kinds.has(row.kind))
  ));
  const merged = new Map<string, WatchlistEntry>();
  for (const row of parts.flat()) {
    const held = merged.get(row.metaId);
    if (!held || row.addedAt > held.addedAt) merged.set(row.metaId, row);
  }
  return [...merged.values()].sort((a, b) => b.addedAt - a.addedAt);
}

export function invalidateWatchlist(config: any, userUUID: string): void {
  for (const service of watchlistServices(config)) cache.delete(serviceKey(config, userUUID, service));
}

function traktHeaders(accessToken: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': process.env.TRAKT_CLIENT_ID || '', Authorization: `Bearer ${accessToken}` };
}

export async function writeWatchlist(config: any, userUUID: string, ids: WatchlistIds, kind: 'movie' | 'show', listed: boolean): Promise<void> {
  const { shouldTrackServiceMediaType } = require('../watchTracking');
  const mediaType = kind === 'movie' ? 'movie' : 'series';
  const body = kind === 'movie' ? { movies: [{ ids }] } : { shows: [{ ids }] };
  const picks = watchlistPicks(config);
  const anime = Boolean(ids.kitsu || ids.mal);
  const shelf: WatchlistKind = kind === 'movie' ? 'movies' : 'series';
  // MDBList and Trakt file anime with films and shows; Simkl, AniList and MAL keep it apart.
  const takes = (service: WatchlistService, own: WatchlistKind) => picks.get(service)?.has(own) ?? false;

  if (takes('mdblist', shelf) && shouldTrackServiceMediaType(config, 'mdblist', mediaType) && config?.apiKeys?.mdblist) {
    try {
      const { makeRateLimitedMDBListPost } = require('../../utils/mdbList');
      await makeRateLimitedMDBListPost(`https://api.mdblist.com/watchlist/items/${listed ? 'add' : 'remove'}?apikey=${config.apiKeys.mdblist}`, body, config.apiKeys.mdblist, `MDBList watchlist ${listed ? 'add' : 'remove'}`);
    } catch (error: any) {
      logger.warn(`MDBList watchlist ${listed ? 'add' : 'remove'} failed: ${error?.message || error}`);
    }
  }

  if (takes('trakt', shelf) && shouldTrackServiceMediaType(config, 'trakt', mediaType) && config?.apiKeys?.traktTokenId) {
    try {
      const { getTraktToken } = require('../../utils/traktUtils');
      const token = await getTraktToken(config.apiKeys.traktTokenId);
      const accessToken = token?.access_token ?? token;
      if (accessToken) {
        await httpPost(`https://api.trakt.tv/sync/watchlist${listed ? '' : '/remove'}`, body, { headers: traktHeaders(accessToken), timeout: 10000 });
      }
    } catch (error: any) {
      logger.warn(`Trakt watchlist ${listed ? 'add' : 'remove'} failed: ${error?.message || error}`);
    }
  }

  if (takes('simkl', anime ? 'anime' : shelf) && shouldTrackServiceMediaType(config, 'simkl', mediaType) && config?.apiKeys?.simklTokenId) {
    try {
      const { getSimklToken, fetchSimklAllItems, makeAuthenticatedSimklRequest } = require('../../utils/simklUtils');
      const token = await getSimklToken(config.apiKeys.simklTokenId);
      if (token?.access_token) {
        if (listed) {
          const planned = kind === 'movie' ? { movies: [{ ids, to: 'plantowatch' }] } : { shows: [{ ids, to: 'plantowatch' }] };
          await makeAuthenticatedSimklRequest('https://api.simkl.com/sync/add-to-list', token.access_token, 'Simkl watchlist add', 'POST', planned);
        } else {
          // Simkl's removal drops the whole entry, history included.
          const all = await fetchSimklAllItems(token.access_token);
          const lists = kind === 'movie' ? [all?.movies] : [all?.shows, all?.anime];
          const planned = lists.flat().some((entry: any) => entry?.status === 'plantowatch' && matches(entry?.movie?.ids ?? entry?.show?.ids ?? {}, ids));
          if (planned) await makeAuthenticatedSimklRequest('https://api.simkl.com/sync/history/remove', token.access_token, 'Simkl watchlist remove', 'POST', body);
        }
      }
    } catch (error: any) {
      logger.warn(`Simkl watchlist ${listed ? 'add' : 'remove'} failed: ${error?.message || error}`);
    }
  }

  if (takes('anilist', 'anime') && ids.kitsu) {
    try {
      const anilist = require('../anilistTracker');
      const idMapper: any = require('../id-mapper');
      const accessToken = await anilist.getValidAccessToken(userUUID);
      const anilistId = idMapper.getMappingByKitsuId(Number(ids.kitsu))?.anilist_id;
      if (accessToken && anilistId) await anilist.setPlanning(anilistId, listed, accessToken);
    } catch (error: any) {
      logger.warn(`AniList watchlist ${listed ? 'add' : 'remove'} failed: ${error?.message || error}`);
    }
  }

  if (takes('mal', 'anime') && ids.mal) {
    try {
      const mal = require('../malTracker');
      const accessToken = await mal.getValidAccessToken(userUUID);
      if (accessToken) await mal.setPlanToWatch(Number(ids.mal), listed, accessToken);
    } catch (error: any) {
      logger.warn(`MAL watchlist ${listed ? 'add' : 'remove'} failed: ${error?.message || error}`);
    }
  }

  invalidateWatchlist(config, userUUID);
}

function matches(have: Record<string, any>, want: WatchlistIds): boolean {
  return Object.entries(want).some(([key, value]) => value != null && have[key] != null && String(have[key]) === String(value));
}
