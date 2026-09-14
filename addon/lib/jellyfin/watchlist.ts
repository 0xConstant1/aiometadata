import { fetchMeta, metaToBaseItem } from './items';
import { profileKey, readsTrackers, writesTrackers } from './profiles';
import { trackerWatchlist, writeWatchlist, type WatchlistEntry, type WatchlistIds } from './watchlistSources';
import { mapWithConcurrency } from '../../utils/concurrency';

const database: any = require('../database');
const idMapper: any = require('../id-mapper');

// The table wins over a tracker, as for the resume shelf.
export async function watchlistEntries(userUUID: string, config: any): Promise<WatchlistEntry[]> {
  const profile = profileKey(config);
  const local: any[] = await database.listWatchlist(userUUID, profile).catch(() => []);
  const tracker = readsTrackers(config) ? await trackerWatchlist(config, userUUID) : [];

  const out = new Map<string, WatchlistEntry>();
  for (const row of tracker) out.set(row.metaId, row);
  for (const row of local) {
    const metaId = String(row.meta_id);
    if (Number(row.listed)) {
      const mediaType = row.media_type === 'movie' ? 'movie' : row.media_type === 'anime' ? 'anime' : 'series';
      out.set(metaId, { metaId, mediaType, kind: mediaType === 'movie' ? 'movies' : mediaType, addedAt: Number(row.updated_at) || 0 });
    } else if (out.has(metaId)) {
      out.delete(metaId);
    }
  }
  return [...out.values()].sort((a, b) => b.addedAt - a.addedAt);
}

export async function watchlistItems(userUUID: string, config: any, serverId: string, entries: WatchlistEntry[], concurrency: number): Promise<any[]> {
  const built = await mapWithConcurrency(entries, concurrency, async (entry: WatchlistEntry) => {
    const meta = await fetchMeta(userUUID, entry.mediaType === 'movie' ? 'movie' : 'series', entry.metaId);
    if (!meta) return null;
    const item = metaToBaseItem(meta, entry.mediaType, serverId, null);
    item.UserData = { ...item.UserData, IsFavorite: true };
    return item;
  });
  return built.filter(Boolean);
}

const PROVIDER_PREFIX: Record<string, string> = { Imdb: '', Tmdb: 'tmdb:', Tvdb: 'tvdb:', Kitsu: 'kitsu:' };

function listedKeys(item: any): string[] {
  const keys: string[] = [];
  for (const [provider, prefix] of Object.entries(PROVIDER_PREFIX)) {
    const value = item?.ProviderIds?.[provider];
    if (value) keys.push(`${prefix}${value}`);
  }
  return keys;
}

export async function applyWatchlistState(items: any[], userUUID: string, config: any, descriptors: Map<string, any>): Promise<void> {
  const titles = items.filter((item: any) => {
    const kind = descriptors.get(String(item?.Id))?.k;
    return item?.UserData && (kind === 'movie' || kind === 'series');
  });
  if (!titles.length) return;

  const listed = new Set((await watchlistEntries(userUUID, config)).map((entry) => entry.metaId));
  for (const item of titles) {
    const own = String(descriptors.get(String(item.Id)).i);
    if (listed.has(own) || listedKeys(item).some((key) => listed.has(key))) {
      item.UserData = { ...item.UserData, IsFavorite: true };
    }
  }
}

export function idsFor(meta: any, stremioType: 'movie' | 'series'): WatchlistIds {
  const ids: WatchlistIds = {};
  const base = String(meta?.id || '');
  if (meta?._imdbId || /^tt\d+$/.test(base)) ids.imdb = meta?._imdbId || base;
  if (meta?._tmdbId) ids.tmdb = meta._tmdbId;
  if (meta?._tvdbId) ids.tvdb = meta._tvdbId;
  if (/^kitsu:\d+$/.test(base)) {
    const mapping = idMapper.getMappingByKitsuId(parseInt(base.split(':')[1], 10));
    ids.kitsu = base.split(':')[1];
    if (!ids.imdb && mapping?.imdb_id) ids.imdb = mapping.imdb_id;
    if (!ids.tmdb && mapping?.themoviedb_id) ids.tmdb = mapping.themoviedb_id;
    if (!ids.tvdb && mapping?.tvdb_id && stremioType === 'series') ids.tvdb = mapping.tvdb_id;
    if (mapping?.mal_id) ids.mal = mapping.mal_id;
  } else if (ids.imdb) {
    const mapping = idMapper.getMappingByImdbId(ids.imdb);
    if (mapping && idMapper.mappingIsType(mapping, stremioType)) {
      if (mapping.kitsu_id) ids.kitsu = mapping.kitsu_id;
      if (mapping.mal_id) ids.mal = mapping.mal_id;
    }
  }
  return ids;
}

export async function setWatchlisted(userUUID: string, config: any, descriptor: any, listed: boolean): Promise<boolean> {
  if (!descriptor || (descriptor.k !== 'movie' && descriptor.k !== 'series')) return false;
  const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
  const meta = await fetchMeta(userUUID, stremioType, descriptor.i);
  if (!meta) return false;

  await database.setWatchlisted(userUUID, profileKey(config), String(meta.id), descriptor.t, listed);
  if (writesTrackers(config)) {
    writeWatchlist(config, userUUID, idsFor(meta, stremioType), stremioType === 'movie' ? 'movie' : 'show', listed).catch(() => undefined);
  }
  return true;
}
