import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { httpPost } from '../../utils/httpClient';
import { credentialFor, sourceFor } from './trackerSource';

const logger = consola.withTag('Jellyfin');
const database: any = require('../database');

const held = new LRUCache<string, Set<string>>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_RESUME_TTL', 60, 1) * 1000,
});

// Simkl, MDBList and PublicMetaDB report their dropped shows back; Trakt's is never read.
export function dropsKeptHere(config: any): boolean {
  const { readsTrackers } = require('./profiles');
  const source = readsTrackers(config) ? sourceFor(config) : null;
  return source !== 'simkl' && source !== 'mdblist' && source !== 'publicmetadb';
}

export async function localDrops(userUUID: string, config: any): Promise<Set<string>> {
  const { profileKey } = require('./profiles');
  const key = `${userUUID}:${profileKey(config)}`;
  const cached = held.get(key);
  if (cached) return cached;
  const rows: any[] = await database.listDropped(userUUID, profileKey(config)).catch(() => []);
  const drops = new Set(rows.map((row) => String(row.meta_id)));
  held.set(key, drops);
  return drops;
}

function showKeys(metaId: string, ids: Record<string, any>): string[] {
  const keys = new Set<string>([metaId]);
  if (ids.imdb) keys.add(String(ids.imdb));
  if (ids.tvdb) keys.add(`tvdb:${ids.tvdb}`);
  if (ids.tmdb) keys.add(`tmdb:${ids.tmdb}`);
  if (ids.kitsu) keys.add(`kitsu:${ids.kitsu}`);
  if (ids.mal) keys.add(`mal:${ids.mal}`);
  return [...keys];
}

export function itemKeys(item: any, metaId: string): string[] {
  const ids = item?.ProviderIds ?? {};
  return showKeys(metaId, { imdb: ids.Imdb, tvdb: ids.Tvdb, tmdb: ids.Tmdb, kitsu: ids.Kitsu, mal: ids.MyAnimeList });
}

async function writeDropped(config: any, ids: Record<string, any>, dropped: boolean): Promise<void> {
  const showIds = { ...(ids.imdb ? { imdb: ids.imdb } : {}), ...(ids.tmdb ? { tmdb: Number(ids.tmdb) } : {}), ...(ids.tvdb ? { tvdb: Number(ids.tvdb) } : {}) };
  const verb = dropped ? 'drop' : 'undrop';

  const simklToken = credentialFor(config, 'simkl');
  if (simklToken) {
    try {
      const { getSimklToken, makeAuthenticatedSimklRequest } = require('../../utils/simklUtils');
      const token = await getSimklToken(simklToken);
      const simklIds = { ...showIds, ...(ids.mal ? { mal: Number(ids.mal) } : {}), ...(ids.kitsu ? { kitsu: Number(ids.kitsu) } : {}) };
      // Simkl has no undrop.
      if (token?.access_token) {
        await makeAuthenticatedSimklRequest('https://api.simkl.com/sync/add-to-list', token.access_token, `Simkl ${verb}`, 'POST', { shows: [{ ids: simklIds, to: dropped ? 'dropped' : 'watching' }] });
      }
    } catch (error: any) {
      logger.warn(`Simkl ${verb} failed: ${error?.message || error}`);
    }
  }

  const mdblistKey = credentialFor(config, 'mdblist');
  if (mdblistKey && Object.keys(showIds).length) {
    try {
      const { makeRateLimitedMDBListPost } = require('../../utils/mdbList');
      const show = dropped ? { ids: showIds, dropped_at: new Date().toISOString() } : { ids: showIds };
      await makeRateLimitedMDBListPost(`https://api.mdblist.com/sync/dropped${dropped ? '' : '/remove'}?apikey=${mdblistKey}`, { shows: [show] }, mdblistKey, `MDBList ${verb}`);
    } catch (error: any) {
      logger.warn(`MDBList ${verb} failed: ${error?.message || error}`);
    }
  }

  const traktTokenId = credentialFor(config, 'trakt');
  if (traktTokenId && Object.keys(showIds).length) {
    try {
      const { getTraktToken } = require('../../utils/traktUtils');
      const { traktHeaders } = require('./watchlistSources');
      const token = await getTraktToken(traktTokenId);
      const accessToken = token?.access_token ?? token;
      if (accessToken) {
        await httpPost(`https://api.trakt.tv/users/hidden/dropped${dropped ? '' : '/remove'}`, { shows: [{ ids: showIds }] }, { headers: traktHeaders(accessToken), timeout: 10000 });
      }
    } catch (error: any) {
      logger.warn(`Trakt ${verb} failed: ${error?.message || error}`);
    }
  }

  const pmdbKey = credentialFor(config, 'publicmetadb');
  if (pmdbKey && ids.tmdb) {
    try {
      const { setDropped } = require('../../utils/publicmetadbUtils');
      await setDropped(pmdbKey, ids.tmdb, dropped);
    } catch (error: any) {
      logger.warn(`PublicMetaDB ${verb} failed: ${error?.message || error}`);
    }
  }
}

export function undropOnWatch(userUUID: string, config: any, seriesIds: string[]): void {
  const unique = [...new Set(seriesIds.filter(Boolean).map(String))];
  if (!unique.length) return;
  (async () => {
    const { watchedSnapshot } = require('./watched');
    const snapshot = await watchedSnapshot(userUUID, config);
    for (const id of unique) {
      if (snapshot.dropped.has(id)) await rateSeries(userUUID, config, { k: 'series', i: id }, true);
    }
  })().catch((error: any) => logger.debug(`Undrop on watch failed: ${error?.message || error}`));
}

// Likes false drops the show; true or a cleared rating undrops it.
export async function rateSeries(userUUID: string, config: any, descriptor: any, likes: boolean | null): Promise<boolean> {
  if (descriptor?.k !== 'series') return false;
  const { fetchMeta } = require('./items');
  const { idsFor } = require('./watchlist');
  const { profileKey, writesTrackers } = require('./profiles');
  const { watchedSnapshot, invalidateWatched } = require('./watched');

  const meta = await fetchMeta(userUUID, 'series', descriptor.i);
  if (!meta) return false;
  const ids = idsFor(meta, 'series');
  const keys = showKeys(String(meta.id), ids);
  const dropping = likes === false;
  if (!dropping) {
    const snapshot = await watchedSnapshot(userUUID, config);
    if (!keys.some((key) => snapshot.dropped.has(key))) return false;
  }

  await database.setDropped(userUUID, profileKey(config), keys, dropping);
  held.delete(`${userUUID}:${profileKey(config)}`);
  if (writesTrackers(config)) {
    await writeDropped(config, ids, dropping);
    await invalidateWatched(config).catch(() => undefined);
  }
  const { invalidateResume } = require('./resume');
  invalidateResume(userUUID);
  logger.info(`${dropping ? 'Dropped' : 'Undropped'} ${meta.name || meta.id} for ${userUUID}`);
  return dropping;
}
