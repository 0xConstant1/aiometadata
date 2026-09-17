import consola from 'consola';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { encodeJellyfinId } from './ids';
import { collectionFolder } from './dto';
import { profileTags } from './profiles';

const { getManifest } = require('../getManifest');

const logger = consola.withTag('Jellyfin');

export interface CatalogRef {
  id: string;
  type: string;
  name: string;
  pageSize: number;
  extra: any[];
  showInHome?: boolean;
}

function viewsTtlSeconds(): number {
  return envInt('JELLYFIN_VIEWS_TTL', 300, 0);
}

const catalogCache = new LRUCache<string, CatalogRef[]>({
  max: envInt('JELLYFIN_VIEWS_CACHE_MAX', 500, 1),
  ttl: Math.max(1, viewsTtlSeconds()) * 1000,
});

// Types outside movies and shows are left without a CollectionType, which
// renders as a mixed library rather than one wearing the wrong chrome.
export function collectionTypeFor(type: string): string | null {
  switch (String(type).toLowerCase()) {
    case 'movie':
    case 'anime.movie':
      return 'movies';
    case 'series':
    case 'anime.series':
      return 'tvshows';
    default:
      return null;
  }
}

// Clients build home rows only from views of one kind.
const sniffed = new LRUCache<string, string | null>({
  max: envInt('JELLYFIN_VIEWS_CACHE_MAX', 500, 1),
  ttl: Math.max(1, viewsTtlSeconds()) * 1000,
});
const sniffing = new Set<string>();

export function viewCollectionType(userUUID: string, catalog: CatalogRef, config: any): string | null {
  const declared = collectionTypeFor(catalog.type);
  if (declared) return declared;
  if (String(catalog.type).toLowerCase() === 'anime') return 'tvshows';

  const tags = profileTags(config);
  const key = `${catalog.type}|${catalog.id}|${tags.join(',')}`;
  if (sniffed.has(key)) return sniffed.get(key) ?? null;
  if (!sniffing.has(key)) {
    sniffing.add(key);
    const { fetchWindow } = require('./items');
    fetchWindow(userUUID, catalog, 0, 20, {}, undefined, tags)
      .then((window: any) => {
        const kinds = new Set<string>((window?.items ?? []).filter((m: any) => m?.id).map((m: any) => (m.type === 'movie' ? 'movies' : 'tvshows')));
        sniffed.set(key, kinds.size === 1 ? [...kinds][0] : null);
      })
      .catch(() => sniffed.set(key, null))
      .finally(() => sniffing.delete(key));
  }
  return null;
}

export async function getCatalogs(userUUID: string, config: any): Promise<CatalogRef[]> {
  const tags = profileTags(config);
  const shape = createHash('md5').update(JSON.stringify(config?.catalogs ?? null)).digest('hex').slice(0, 12);
  const key = `${userUUID}:${tags.map((t) => t.toLowerCase()).sort().join(',')}:${shape}`;
  const cached = catalogCache.get(key);
  if (cached) return cached;

  try {
    const manifest = await getManifest(config, { tags });
    const catalogs: CatalogRef[] = Array.isArray(manifest?.catalogs) ? manifest.catalogs : [];
    catalogCache.set(key, catalogs);
    return catalogs;
  } catch (error: any) {
    logger.warn(`Failed to build catalogs for ${userUUID}: ${error?.message || error}`);
    return [];
  }
}

// A catalog with a required extra cannot be listed, only queried, so it would
// make an empty library.
export function isBrowsable(catalog: CatalogRef): boolean {
  return !(catalog.extra ?? []).some((e: any) => e?.isRequired);
}

export function requiredExtras(catalog: CatalogRef): string[] {
  return (catalog.extra ?? []).filter((e: any) => e?.isRequired).map((e: any) => e.name);
}

export function getSearchCatalogs(catalogs: CatalogRef[]): CatalogRef[] {
  return catalogs.filter((c) => {
    const required = requiredExtras(c);
    return required.length === 1 && required[0] === 'search';
  });
}

// Everything accepting a search term, not only the catalogs that demand one.
export function getSearchableCatalogs(catalogs: CatalogRef[]): CatalogRef[] {
  return catalogs.filter((c) =>
    (c.extra ?? []).some((e: any) => e?.name === 'search')
  );
}

export function viewIdFor(catalog: CatalogRef): string {
  return encodeJellyfinId({ k: 'view', t: catalog.type, c: catalog.id });
}

// Builder entries first, in their order; then every catalog they never named.
export async function buildViews(
  userUUID: string,
  serverId: string,
  config: any
): Promise<any[]> {
  const { boxSetsFor, collectionView, entryVisible } = require('./collections');
  const catalogs = (await getCatalogs(userUUID, config)).filter(isBrowsable);
  const catalogView = (catalog: CatalogRef) =>
    collectionFolder(viewIdFor(catalog), serverId, catalog.name, viewCollectionType(userUUID, catalog, config), null);

  const views: any[] = [];
  const placed = new Set<CatalogRef>();
  for (const entry of Array.isArray(config?.collections) ? config.collections : []) {
    if (!entryVisible(entry, config)) continue;
    if (entry?.kind === 'classicRow') {
      const source = entry.source;
      const catalog = catalogs.find(
        (c) => c.id === String(source?.catalogId ?? '') && c.type.toLowerCase() === String(source?.type ?? '').toLowerCase()
      );
      if (catalog && !placed.has(catalog)) {
        placed.add(catalog);
        views.push(catalogView(catalog));
      }
    } else if (entry?.kind === 'collection' && entry.id && typeof entry.title === 'string') {
      const folders = await boxSetsFor(userUUID, config, serverId, entry);
      if (folders.length) views.push(collectionView(serverId, entry, folders.length));
    }
  }
  for (const catalog of catalogs) {
    if (!placed.has(catalog)) views.push(catalogView(catalog));
  }
  return views;
}

export async function findCatalogByViewId(
  userUUID: string,
  config: any,
  type: string,
  catalogId: string
): Promise<CatalogRef | null> {
  const catalogs = await getCatalogs(userUUID, config);
  return catalogs.find((c) => c.type === type && c.id === catalogId) ?? null;
}
