import consola from 'consola';
import { envInt } from '../../utils/envNumber';
import { httpPost } from '../../utils/httpClient';
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


export type WatchlistService = 'mdblist' | 'trakt' | 'simkl' | 'anilist' | 'mal' | 'publicmetadb';
/** The pick that says a client's favourites are the hearts set here, and nothing else. */
export const WATCHLIST_NONE = 'none';
export const WATCHLIST_SERVICES: WatchlistService[] = ['mdblist', 'trakt', 'simkl', 'anilist', 'mal', 'publicmetadb'];
export const SERVICE_KINDS: Record<WatchlistService, WatchlistKind[]> = {
  mdblist: ['movies', 'series'],
  trakt: ['movies', 'series'],
  simkl: ['movies', 'series', 'anime'],
  anilist: ['anime'],
  mal: ['anime'],
  publicmetadb: ['movies', 'series'],
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
  const picked: string[] = Array.isArray(config?.jellyfinWatchlistServices) ? config.jellyfinWatchlistServices.map(String) : [];
  if (picked.includes(WATCHLIST_NONE)) return out;
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

const SHELF_CATALOGS: Record<WatchlistService, Partial<Record<WatchlistKind, { type: string; id: string }>>> = {
  mdblist: { movies: { type: 'movie', id: 'mdblist.watchlist.movies' }, series: { type: 'series', id: 'mdblist.watchlist.series' } },
  trakt: { movies: { type: 'movie', id: 'trakt.watchlist.movies' }, series: { type: 'series', id: 'trakt.watchlist.series' } },
  simkl: {
    movies: { type: 'movie', id: 'simkl.watchlist.movies.plantowatch' },
    series: { type: 'series', id: 'simkl.watchlist.shows.plantowatch' },
    anime: { type: 'anime', id: 'simkl.watchlist.anime.plantowatch' },
  },
  anilist: { anime: { type: 'anime', id: 'anilist.Planning' } },
  mal: { anime: { type: 'anime', id: 'mal.userlist.plan_to_watch' } },
  publicmetadb: {},
};

async function shelfCatalog(config: any, service: WatchlistService, kind: WatchlistKind): Promise<{ type: string; id: string; keep?: (meta: any) => boolean } | null> {
  if (service !== 'publicmetadb') return SHELF_CATALOGS[service][kind] ?? null;
  const { publicMetaDBWatchlistCatalog } = require('../../utils/publicmetadbUtils');
  const catalog = await publicMetaDBWatchlistCatalog(config);
  if (!catalog) return null;
  const wanted = kind === 'movies' ? 'movie' : 'series';
  return { type: catalog.type, id: catalog.id, keep: (meta: any) => meta?.type === wanted };
}

export async function shelfCacheWindowMs(config: any): Promise<number> {
  const { getSetting } = require('../settingsService');
  const fallback = Number(getSetting('CATALOG_TTL')) || 24 * 60 * 60;
  let longest = 0;
  for (const [service, kinds] of watchlistPicks(config)) {
    for (const kind of kinds) {
      const catalog = await shelfCatalog(config, service, kind);
      if (!catalog) continue;
      const own = (config?.catalogs ?? []).find((c: any) => c?.id === catalog.id)?.cacheTTL;
      const ttl = Number.isFinite(own) && own >= 0 ? own : fallback;
      longest = Math.max(longest, ttl);
    }
  }
  return longest * 1000;
}

async function shelfEntries(userUUID: string, config: any, service: WatchlistService, kind: WatchlistKind, need: number): Promise<{ rows: WatchlistEntry[]; ok: boolean; exhausted: boolean }> {
  const catalog = await shelfCatalog(config, service, kind);
  if (!catalog) return { rows: [], ok: true, exhausted: true };
  const { fetchWindow } = require('./items');
  const { profileTags } = require('./profiles');
  const max = Math.min(envInt('JELLYFIN_WATCHLIST_MAX_ITEMS', 5000, 100), Math.max(1, need));
  try {
    const window = await fetchWindow(userUUID, { id: catalog.id, type: catalog.type, name: catalog.id, pageSize: 0, extra: [] }, 0, max, {}, catalog.keep, profileTags(config));
    const rows: WatchlistEntry[] = [];
    window.items.forEach((meta: any, rank: number) => {
      if (!meta?.id) return;
      const mediaType: WatchlistEntry['mediaType'] = kind === 'anime' ? 'anime' : meta.type === 'movie' ? 'movie' : 'series';
      rows.push({ metaId: String(meta.id), mediaType, kind, addedAt: Date.parse(meta._listedAt ?? '') || -rank });
    });
    return { rows, ok: !window.failed, exhausted: !window.hasMore };
  } catch (error: any) {
    logger.warn(`Watchlist ${catalog.id} failed: ${error?.message || error}`);
    return { rows: [], ok: false, exhausted: false };
  }
}

export interface TrackerWatchlist {
  rows: WatchlistEntry[];
  complete: boolean;
  /** Every shelf ended inside the window, so the rows are the whole watchlist. */
  exhausted: boolean;
}

export async function trackerWatchlist(config: any, userUUID: string, need = Number.MAX_SAFE_INTEGER): Promise<TrackerWatchlist> {
  const picks = watchlistPicks(config);
  const parts = await Promise.all(
    [...picks].flatMap(([service, kinds]) => [...kinds].map((kind) => shelfEntries(userUUID, config, service, kind, need)))
  );
  const merged = new Map<string, WatchlistEntry>();
  for (const row of parts.flatMap((part) => part.rows)) {
    const held = merged.get(row.metaId);
    if (!held || row.addedAt > held.addedAt) merged.set(row.metaId, row);
  }
  return {
    rows: [...merged.values()].sort((a, b) => b.addedAt - a.addedAt),
    complete: parts.every((part) => part.ok),
    exhausted: parts.every((part) => part.exhausted),
  };
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

  if (takes('publicmetadb', shelf) && shouldTrackServiceMediaType(config, 'publicmetadb', mediaType) && config?.apiKeys?.publicmetadb && ids.tmdb) {
    try {
      const { publicMetaDBWatchlistCatalog, setListItem } = require('../../utils/publicmetadbUtils');
      const catalog = await publicMetaDBWatchlistCatalog(config);
      if (catalog) {
        await setListItem(config.apiKeys.publicmetadb, catalog.id.slice('publicmetadb.list.'.length), ids.tmdb, kind === 'movie' ? 'movie' : 'tv', listed);
      }
    } catch (error: any) {
      logger.warn(`PublicMetaDB watchlist ${listed ? 'add' : 'remove'} failed: ${error?.message || error}`);
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

}

function matches(have: Record<string, any>, want: WatchlistIds): boolean {
  return Object.entries(want).some(([key, value]) => value != null && have[key] != null && String(have[key]) === String(value));
}
