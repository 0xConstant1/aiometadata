import { fetchMeta, metaToBaseItem } from './items';
import { clientHasOwnWatchlist } from './context';
import { profileKey, writesTrackers } from './profiles';
import { invalidateDatedShelves } from './resume';
import { dedupeWatchlist, keepsServerWatchlist, shelfCacheWindowMs, trackerWatchlist, watchlistPicks, watchlistSlot, type WatchlistEntry, type WatchlistIds } from './watchlistSources';
import { mapWithConcurrency } from '../../utils/concurrency';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';

const database: any = require('../database');
const idMapper: any = require('../id-mapper');

interface HeldWatchlist {
  rows: WatchlistEntry[];
  exhausted: boolean;
  complete: boolean;
}

const trackerMemo = new LRUCache<string, HeldWatchlist>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_WATCHLIST_MEMO_TTL', 60, 1) * 1000,
});
const trackerInFlight = new Map<string, Promise<HeldWatchlist>>();

function trackerMemoKey(config: any, userUUID: string): string {
  return `${userUUID}:${profileKey(config)}:${JSON.stringify(config?.jellyfinWatchlistServices ?? null)}`;
}

/** A shelf is read only as far as the caller needs; a held read serves any smaller window. */
function trackerWatchlistShared(config: any, userUUID: string, need: number): Promise<HeldWatchlist> {
  const key = `${trackerMemoKey(config, userUUID)}:${need}`;
  for (const [candidate, held] of trackerMemo.entries()) {
    if (!candidate.startsWith(`${trackerMemoKey(config, userUUID)}:`)) continue;
    if (held.exhausted || held.rows.length >= need) return Promise.resolve(held);
  }
  const running = trackerInFlight.get(key);
  if (running) return running;
  const work = trackerWatchlist(config, userUUID, need)
    .then((built) => {
      const held = { rows: built.rows, exhausted: built.exhausted, complete: built.complete };
      if (built.complete) trackerMemo.set(key, held);
      return held;
    })
    .finally(() => {
      if (trackerInFlight.get(key) === work) trackerInFlight.delete(key);
    });
  trackerInFlight.set(key, work);
  return work;
}

const identityMemo = new LRUCache<string, { key: string; anime: boolean }>({
  max: envInt('JELLYFIN_WATCHLIST_IDENTITY_MAX', 5000, 1),
  ttl: envInt('JELLYFIN_WATCHLIST_IDENTITY_TTL', 6 * 60 * 60, 60) * 1000,
});

async function identityOf(metaId: string, mediaType: 'movie' | 'series' | 'anime', config: any): Promise<string> {
  const memoKey = `${metaId}|${mediaType}`;
  let identity = identityMemo.get(memoKey);
  if (!identity) {
    const { watchlistIdentity } = require('./canonicalIds');
    identity = (await watchlistIdentity(metaId, mediaType, config).catch(() => null)) ?? { key: metaId, anime: false };
    identityMemo.set(memoKey, identity);
  }
  return watchlistSlot(identity, metaId, config);
}

const showOf = (identity: string): string => identity.split('#')[0];

export function invalidateWatchlist(userUUID: string): void {
  for (const key of [...trackerMemo.keys()]) {
    if (String(key).startsWith(`${userUUID}:`)) trackerMemo.delete(key);
  }
}

async function fillMetaTypes(table: 'jellyfin_watchlist', userUUID: string, profile: string, rows: any[]): Promise<void> {
  const untyped = rows.filter((row) => row.media_type === 'anime' && !row.meta_type);
  await mapWithConcurrency(untyped, 4, async (row: any) => {
    const meta = await fetchMeta(userUUID, 'series', String(row.meta_id)).catch(() => null);
    if (!meta?.type) return;
    row.meta_type = meta.type === 'movie' ? 'movie' : 'series';
    await database.setMetaType(table, userUUID, profile, String(row.meta_id), row.meta_type).catch(() => undefined);
  });
}

// Picked shelves are the favourites; a change made here stands only until their caches catch up.
export async function watchlistEntries(userUUID: string, config: any, need = Number.MAX_SAFE_INTEGER): Promise<{ entries: WatchlistEntry[]; exhausted: boolean; complete: boolean }> {
  const profile = profileKey(config);
  const rows: any[] = await database.listWatchlist(userUUID, profile).catch(() => []);
  const held = await trackerWatchlistShared(config, userUUID, need);
  const tracker = held.rows;

  const since = watchlistPicks(config).size ? Date.now() - (await shelfCacheWindowMs(config)) : -Infinity;
  const keepsServer = keepsServerWatchlist(config);
  const local = rows.filter((row) => (Number(row.updated_at) || 0) >= since || (keepsServer && Number(row.listed)));
  await fillMetaTypes('jellyfin_watchlist', userUUID, profile, local.filter((row) => Number(row.listed)));

  const out = new Map<string, WatchlistEntry>();
  for (const row of tracker) out.set(row.metaId, row);
  for (const row of local) {
    const metaId = String(row.meta_id);
    if (Number(row.listed)) {
      const mediaType = row.media_type === 'movie' ? 'movie' : row.media_type === 'anime' ? 'anime' : 'series';
      out.set(metaId, { metaId, mediaType, kind: mediaType === 'movie' ? 'movies' : mediaType, addedAt: Number(row.updated_at) || 0, ...(row.meta_type === 'movie' ? { film: true } : {}) });
    } else if (out.has(metaId)) {
      out.delete(metaId);
    }
  }
  const deduped = local.some((row) => Number(row.listed)) ? await dedupeWatchlist([...out.values()], config) : [...out.values()];
  const entries = await withoutRemoved(deduped, local.filter((row) => !Number(row.listed)), config);
  return { entries: entries.sort((a, b) => b.addedAt - a.addedAt), exhausted: held.exhausted, complete: held.complete };
}

async function withoutRemoved(entries: WatchlistEntry[], removed: any[], config: any): Promise<WatchlistEntry[]> {
  const oldest = Math.min(...entries.map((entry) => entry.addedAt));
  const recent = removed.filter((row) => (Number(row.updated_at) || 0) >= oldest);
  if (!entries.length || !recent.length) return entries;
  const at = new Map<string, number>();
  const note = (key: string, when: number) => at.set(key, Math.max(when, at.get(key) ?? -Infinity));
  await mapWithConcurrency(recent, 4, async (row: any) => {
    const mediaType = row.media_type === 'movie' ? 'movie' : row.media_type === 'anime' ? 'anime' : 'series';
    const identity = await identityOf(String(row.meta_id), mediaType, config);
    const when = Number(row.updated_at) || 0;
    note(identity, when);
    if (identity !== showOf(identity)) note(`${showOf(identity)}#show`, when);
  });
  return entries.filter((entry) => {
    if (!entry.identity) return true;
    const show = showOf(entry.identity);
    const removedAt = Math.max(
      at.get(entry.identity) ?? -Infinity,
      at.get(show) ?? -Infinity,
      entry.identity === show ? at.get(`${show}#show`) ?? -Infinity : -Infinity,
    );
    return entry.addedAt > removedAt;
  });
}

export function entryItemType(entry: WatchlistEntry): 'Movie' | 'Series' {
  return entry.mediaType === 'movie' || entry.film ? 'Movie' : 'Series';
}

export async function watchlistItems(userUUID: string, config: any, serverId: string, entries: WatchlistEntry[], concurrency: number): Promise<any[]> {
  const likes = clientHasOwnWatchlist();
  const built = await mapWithConcurrency(entries, concurrency, async (entry: WatchlistEntry) => {
    const meta = await fetchMeta(userUUID, entryItemType(entry) === 'Movie' ? 'movie' : 'series', entry.metaId);
    if (!meta) return null;
    const item = metaToBaseItem(meta, entry.mediaType, serverId, null);
    item.UserData = { ...item.UserData, IsFavorite: true, ...(likes ? { Likes: true } : {}) };
    if (entry.addedAt > 0) item.DateCreated = new Date(entry.addedAt).toISOString();
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

async function itemIdentity(item: any, descriptor: any, config: any): Promise<string | null> {
  const id = String(descriptor?.i ?? '');
  if (/^(kitsu|mal|anilist|anidb):/.test(id)) return identityOf(id, 'anime', config);
  const ids = item?.ProviderIds ?? {};
  if (descriptor?.k === 'movie') return ids.Tmdb ? `m|tmdb:${ids.Tmdb}` : null;
  return ids.Tvdb ? `s|tvdb:${ids.Tvdb}` : ids.Tmdb ? `s|tmdb:${ids.Tmdb}` : null;
}

export async function applyWatchlistState(items: any[], userUUID: string, config: any, descriptors: Map<string, any>): Promise<void> {
  const titles = items.filter((item: any) => {
    const kind = descriptors.get(String(item?.Id))?.k;
    return item?.UserData && (kind === 'movie' || kind === 'series');
  });
  if (!titles.length) return;

  const entries = (await watchlistEntries(userUUID, config)).entries;
  const listed = new Set(entries.map((entry) => entry.metaId));
  const identities = new Set(entries.flatMap((entry) => (entry.identity ? [entry.identity] : [])));
  const shows = new Set([...identities].map(showOf));
  const inSet = (set: Set<string>, item: any) =>
    set.has(String(descriptors.get(String(item.Id)).i)) || listedKeys(item).some((key) => set.has(key));
  const listedAsTitle = async (item: any): Promise<boolean> => {
    if (!identities.size) return false;
    const descriptor = descriptors.get(String(item.Id));
    const identity = await itemIdentity(item, descriptor, config);
    if (!identity) return false;
    const show = showOf(identity);
    return identities.has(identity) || identities.has(show) || (identity === show && shows.has(show));
  };

  const likes = clientHasOwnWatchlist();
  for (const item of titles) {
    if (!inSet(listed, item) && !(await listedAsTitle(item))) continue;
    item.UserData = { ...item.UserData, IsFavorite: true };
    // A dropped show keeps its dislike over the watchlist's like.
    if (likes && item.UserData.Likes !== false) item.UserData = { ...item.UserData, Likes: true };
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

  await database.setWatchlisted(userUUID, profileKey(config), String(meta.id), descriptor.t, listed, meta.type === 'movie' ? 'movie' : 'series');
  invalidateWatchlist(userUUID);
  invalidateDatedShelves(userUUID);
  if (writesTrackers(config)) {
    const { enqueueTrackerWrites, hasCredential } = require('../trackerOutbox');
    const services = (['mdblist', 'simkl', 'publicmetadb', 'anilist', 'mal'] as const).filter((service) => hasCredential(config, service));
    const payload = { ids: idsFor(meta, stremioType), kind: stremioType === 'movie' ? 'movie' : 'show', listed };
    await enqueueTrackerWrites(userUUID, config, services.map((service) => ({
      service, op: 'watchlist', item: String(meta.id), coalesce: `watchlist:${meta.id}`, payload,
    })));
  }
  return true;
}
