import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { encodeJellyfinId, parseStremioId } from './ids';
import { normaliseJellyfinId } from './idsCodec';
import { EMPTY_USER_DATA } from './dto';
import { placeholderSources } from './streams';
import redis from '../redisClient';
import type { CatalogRef } from './views';

const logger = consola.withTag('Jellyfin');

const TICKS_PER_MS = 10000;

export interface ItemImages {
  primary?: string;
  backdrop?: string;
  logo?: string;
  thumb?: string;
}

const imageCache = new LRUCache<string, ItemImages>({
  max: envInt('JELLYFIN_IMAGE_CACHE_MAX', 20000, 1),
  ttl: envInt('JELLYFIN_IMAGE_MEMO_TTL', 6 * 60 * 60, 60) * 1000,
});

/**
 * Scoped per server id, which is derived from the configuration: art depends on
 * a user's providers and language, so two configurations must not read each
 * other's. Held in Redis as well as in process, because a client keeps its item
 * ids across a restart and asks for their art before anything has rebuilt them.
 */
function imageKey(scope: string, itemId: string): string {
  return `${scope}|${normaliseJellyfinId(itemId)}`;
}

const imageHash = (scope: string): string => `jf:img:${scope}`;
const imageField = (itemId: string): string => normaliseJellyfinId(itemId);

function imageTtl(): number {
  return envInt('JELLYFIN_IMAGE_URL_TTL', 7 * 24 * 60 * 60, 60);
}

// A listing remembers art item by item, so the writes are held back and sent
// as one command per scope rather than five per item.
const pendingImages = new Map<string, Map<string, string>>();
let imageFlushTimer: NodeJS.Timeout | null = null;

function scheduleImageFlush(): void {
  if (imageFlushTimer) return;
  imageFlushTimer = setTimeout(() => {
    imageFlushTimer = null;
    void flushRememberedImages();
  }, envInt('JELLYFIN_IMAGE_FLUSH_DELAY_MS', 250, 0));
  imageFlushTimer.unref?.();
}

export async function flushRememberedImages(): Promise<void> {
  if (imageFlushTimer) {
    clearTimeout(imageFlushTimer);
    imageFlushTimer = null;
  }
  if (!redis || pendingImages.size === 0) return;

  const batches = [...pendingImages.entries()];
  pendingImages.clear();

  const ttl = imageTtl();
  await Promise.all(
    batches.map(async ([scope, fields]) => {
      const flat: string[] = [];
      for (const [field, value] of fields) flat.push(field, value);
      try {
        // One hash per scope rather than a key per item: a key each grew to six
        // figures on a busy instance and slowed every scan of the keyspace.
        await redis
          .multi()
          .hsetex(imageHash(scope), 'EX', ttl, 'FIELDS', fields.size, ...flat)
          .expire(imageHash(scope), ttl, 'NX')
          .expire(imageHash(scope), ttl, 'GT')
          .exec();
      } catch {
        // Art is a cache; a lost write is read from the meta again.
      }
    })
  );
}

export function rememberImages(scope: string, itemId: string, images: ItemImages): void {
  if (!images.primary && !images.backdrop && !images.logo && !images.thumb) return;

  const key = imageKey(scope, itemId);
  const held = imageCache.get(key);
  if (held && held.primary === images.primary && held.backdrop === images.backdrop && held.logo === images.logo && held.thumb === images.thumb) return;
  imageCache.set(key, images);

  if (!redis) return;

  let fields = pendingImages.get(scope);
  if (!fields) {
    fields = new Map<string, string>();
    pendingImages.set(scope, fields);
  }
  fields.set(imageField(itemId), JSON.stringify(images));
  scheduleImageFlush();
}

export async function recallImages(scope: string, itemId: string): Promise<ItemImages | undefined> {
  const key = imageKey(scope, itemId);
  const local = imageCache.get(key);
  if (local) return local;

  if (!redis) return undefined;

  try {
    const stored = await redis.hget(imageHash(scope), imageField(itemId));
    if (!stored) return undefined;
    const images = JSON.parse(stored) as ItemImages;
    imageCache.set(key, images);
    return images;
  } catch {
    return undefined;
  }
}

function localBase(): string {
  return `http://127.0.0.1:${process.env.PORT || '3232'}`;
}

// Past the cap, loopback calls queue rather than fail on the socket.
let loopbackActive = 0;
const loopbackQueue: Array<() => void> = [];
async function loopbackFetch(url: string): Promise<Response> {
  const cap = envInt('JELLYFIN_LOOPBACK_CONCURRENCY', 16, 1);
  if (loopbackActive >= cap) await new Promise<void>((resolve) => loopbackQueue.push(resolve));
  loopbackActive += 1;
  try {
    return await fetch(url, { headers: { accept: 'application/json', 'accept-encoding': 'identity' } });
  } finally {
    loopbackActive -= 1;
    loopbackQueue.shift()?.();
  }
}

/**
 * The catalog route owns id normalisation, per-source dispatch, cursors and
 * poster resolution. Going through it over loopback keeps the Jellyfin surface
 * and the Stremio surface on identical data instead of a second copy of that
 * dispatch drifting out of step.
 */
export async function fetchCatalogPage(
  userUUID: string,
  type: string,
  catalogId: string,
  extras: Record<string, string> = {},
  tags: string[] = []
): Promise<any[] | null> {
  const parts = Object.entries(extras)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  const extraSegment = parts.length ? `/${parts.join('&')}` : '';
  const profile = tags.length ? `?${tags.map((t) => `tag=${encodeURIComponent(t)}`).join('&')}` : '';
  const url = `${localBase()}/stremio/${encodeURIComponent(userUUID)}/catalog/${encodeURIComponent(type)}/${encodeURIComponent(catalogId)}${extraSegment}.json${profile}`;

  if (failedPages.has(url)) return null;
  try {
    const response = await loopbackFetch(url);
    if (!response.ok) {
      failedPages.set(url, true);
      logger.debug(`Catalog ${type}/${catalogId} returned ${response.status}`);
      return null;
    }
    const body: any = await response.json();
    return Array.isArray(body?.metas) ? body.metas : [];
  } catch (error: any) {
    failedPages.set(url, true);
    logger.warn(`Catalog ${type}/${catalogId} failed: ${error?.message || error}; not asked again for ${envInt('JELLYFIN_CATALOG_RETRY', 60, 1)}s`);
    return null;
  }
}

// A page that failed is not asked again on the next open of the same row.
const failedPages = new LRUCache<string, true>({
  max: envInt('JELLYFIN_PAGE_LENGTH_CACHE_MAX', 2000, 1),
  ttl: envInt('JELLYFIN_CATALOG_RETRY', 60, 1) * 1000,
});

export interface Window {
  items: any[];
  hasMore: boolean;
  failed?: boolean;
}

/**
 * A flat ceiling silently truncates a window: a client asking for 200 with a
 * page of 20 needs ten pages before a single duplicate or filtered entry is
 * accounted for, and comes up short, which reads as the end of the list. The
 * budget follows what was asked for, with room for what gets dropped.
 */
function maxPages(needed = 0, pageLength = 0): number {
  const floor = envInt('JELLYFIN_CATALOG_MAX_PAGES', 10, 1);
  if (!needed || !pageLength) return floor;

  const slack = envInt('JELLYFIN_CATALOG_PAGE_SLACK', 5, 0);
  return Math.max(floor, Math.ceil(needed / pageLength) + slack);
}

const pageLengths = new LRUCache<string, number>({
  max: envInt('JELLYFIN_PAGE_LENGTH_CACHE_MAX', 2000, 1),
});

const catalogLengths = new LRUCache<string, number>({
  max: envInt('JELLYFIN_PAGE_LENGTH_CACHE_MAX', 2000, 1),
  ttl: envInt('JELLYFIN_CATALOG_LENGTH_TTL', 3600, 60) * 1000,
});

function lengthKeyFor(userUUID: string, catalog: CatalogRef, extras: Record<string, string>, tags: string[], keepKey = ''): string {
  return `${userUUID}|${catalog.type}|${catalog.id}|${extras.genre ?? ''}|${extras.search ?? ''}|${tags.join(',')}|${keepKey}`;
}

export function knownCatalogLength(userUUID: string, catalog: CatalogRef, extras: Record<string, string> = {}, tags: string[] = [], keepKey = ''): number | undefined {
  return catalogLengths.get(lengthKeyFor(userUUID, catalog, extras, tags, keepKey));
}

const walkConcurrency = (): number => envInt('JELLYFIN_CATALOG_WALK_CONCURRENCY', 4, 1);
const lengthTtl = (): number => envInt('JELLYFIN_CATALOG_LENGTH_TTL', 3600, 60);
const catalogLengthRedisKey = (key: string): string => `jf:len:catalog:${key}`;
const pageLengthRedisKey = (key: string): string => `jf:len:page:${key}`;

function rememberLength(kind: 'catalog' | 'page', key: string, value: number): void {
  (kind === 'catalog' ? catalogLengths : pageLengths).set(key, value);
  if (!redis) return;
  const at = kind === 'catalog' ? catalogLengthRedisKey(key) : pageLengthRedisKey(key);
  redis.set(at, String(value), 'EX', lengthTtl()).catch(() => undefined);
}

export async function warmCatalogLengths(userUUID: string, catalogs: CatalogRef[], extras: Record<string, string> = {}, tags: string[] = [], keepKey = ''): Promise<void> {
  if (!redis || catalogs.length === 0) return;
  const wanted: Array<{ kind: 'catalog' | 'page'; key: string; at: string }> = [];
  for (const catalog of catalogs) {
    const lengthKey = lengthKeyFor(userUUID, catalog, extras, tags, keepKey);
    const pageKey = lengthKeyFor(userUUID, catalog, extras, tags);
    if (!catalogLengths.has(lengthKey)) wanted.push({ kind: 'catalog', key: lengthKey, at: catalogLengthRedisKey(lengthKey) });
    if (!pageLengths.has(pageKey)) wanted.push({ kind: 'page', key: pageKey, at: pageLengthRedisKey(pageKey) });
  }
  if (wanted.length === 0) return;
  try {
    const stored: Array<string | null> = await redis.mget(...wanted.map((w) => w.at));
    wanted.forEach((w, i) => {
      const value = Number(stored[i]);
      if (Number.isFinite(value) && value >= 0) (w.kind === 'catalog' ? catalogLengths : pageLengths).set(w.key, value);
    });
  } catch {
  }
}

/**
 * `skip` is an absolute offset, but the catalog route rounds it up to a whole
 * page for a stable cache key, so an offset landing mid-page silently loses the
 * items before the next boundary. Stremio never hits that because it advances
 * skip by what it was handed; a Jellyfin client picks offsets from its own grid.
 *
 * Asking only on boundaries and trimming the remainder here keeps every request
 * on the page numbers the warmer already wrote.
 */
export async function fetchWindow(
  userUUID: string,
  catalog: CatalogRef,
  startIndex: number,
  limit: number,
  extras: Record<string, string> = {},
  keep?: (meta: any) => boolean,
  tags: string[] = [],
  keepKey = ''
): Promise<Window> {
  const lengthKey = lengthKeyFor(userUUID, catalog, extras, tags, keepKey);
  const pageKey = lengthKeyFor(userUUID, catalog, extras, tags);
  let pageLength = pageLengths.get(pageKey);

  if (!pageLength && startIndex > 0 && !keep) {
    const probe = await fetchCatalogPage(userUUID, catalog.type, catalog.id, extras, tags);
    if (probe && probe.length > 0) {
      pageLength = probe.length;
      rememberLength('page', pageKey, pageLength);
    }
  }

  const alignedSkip = keep ? 0 : pageLength ? Math.floor(startIndex / pageLength) * pageLength : startIndex;
  let offset = startIndex - alignedSkip;

  const collected: any[] = [];
  const seen = new Set<string>();
  let skip = alignedSkip;
  let pages = 0;
  let exhausted = false;
  let failed = false;
  const budget = maxPages((offset + limit) * (keep ? 2 : 1), pageLength || 0);

  const knownLength = keep ? undefined : catalogLengths.get(lengthKey);
  const minPage = envInt('JELLYFIN_CATALOG_MIN_PAGE', 10, 1);
  let stop = false;

  while (!stop && collected.length < offset + limit && pages < budget) {
    if (knownLength !== undefined && skip >= knownLength) {
      exhausted = true;
      break;
    }

    const wanted = offset + limit - collected.length;
    const ahead = pageLength
      ? Math.max(1, Math.min(walkConcurrency(), Math.ceil(wanted / pageLength), budget - pages))
      : 1;
    const skips: number[] = [];
    for (let i = 0; i < ahead; i++) skips.push(skip + i * (pageLength || 0));

    const first = pages === 0;
    const fetched = await Promise.all(skips.map((at) => fetchCatalogPage(userUUID, catalog.type, catalog.id, {
      ...extras,
      ...(at > 0 ? { skip: String(at) } : {}),
    }, tags)));
    pages += skips.length;

    for (let i = 0; i < fetched.length; i++) {
      const page = fetched[i];
      if (!page) {
        failed = true;
        stop = true;
        break;
      }
      if (page.length === 0) {
        exhausted = true;
        stop = true;
        break;
      }

      if (first && i === 0 && !pageLength && page.length >= minPage) {
        pageLength = page.length;
        rememberLength('page', pageKey, pageLength);
      }

      for (const meta of page) {
        const key = meta?.id ? String(meta.id) : null;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (keep && !keep(meta)) continue;
        collected.push(meta);
      }

      skip = skips[i] + page.length;
      if (page.length < (pageLength || minPage)) {
        exhausted = true;
        stop = true;
        break;
      }
    }
  }

  if (exhausted && !failed) rememberLength('catalog', lengthKey, alignedSkip + collected.length);

  // Duplicates are dropped above, so trimming by count would cut into the window
  // itself; the offset only ever covers items that came before startIndex.
  if (offset > collected.length) offset = collected.length;

  return {
    items: collected.slice(offset, offset + limit),
    hasMore: collected.length > offset + limit || (!exhausted && !failed && collected.length >= offset + limit),
    ...(failed ? { failed: true } : {}),
  };
}

function parseRuntimeTicks(runtime: any): number | null {
  if (typeof runtime !== 'string') return null;
  const hours = /(\d+)\s*h/.exec(runtime);
  const minutes = /(\d+)\s*min/.exec(runtime);
  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  return total > 0 ? total * 60 * 1000 * TICKS_PER_MS : null;
}

function parseRating(value: any): number | null {
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

const PER_ENTRY_ANIME = /^(kitsu|mal|anilist|anidb):/i;

// A season-per-entry anime shares the series' IMDb, TMDB and TVDB ids with its
// siblings, and a client folds items with the same provider ids into one.
function providerIds(meta: any): Record<string, string> {
  const ids: Record<string, string> = {};
  if (PER_ENTRY_ANIME.test(String(meta.id ?? ''))) {
    if (meta._malId) ids.MyAnimeList = String(meta._malId);
    if (meta._kitsuId) ids.Kitsu = String(meta._kitsuId);
    if (meta._anilistId) ids.AniList = String(meta._anilistId);
    if (meta._anidbId) ids.AniDB = String(meta._anidbId);
    return ids;
  }
  if (meta._imdbId || meta.imdb_id) ids.Imdb = String(meta._imdbId || meta.imdb_id);
  if (meta._tmdbId) ids.Tmdb = String(meta._tmdbId);
  if (meta._tvdbId) ids.Tvdb = String(meta._tvdbId);
  return ids;
}

function peopleFrom(meta: any, serverId: string): any[] {
  const extras = meta.app_extras || {};
  const person = (member: any, type: string, role: string) => {
    const id = encodeJellyfinId({ k: 'person', n: String(member?.name || '') });
    // A client only asks for a portrait when the tag is present, so registering
    // the photo and setting it have to happen together.
    if (member?.photo) rememberImages(serverId, id, { primary: member.photo });
    return { Name: member?.name, Id: id, Role: role, Type: type, PrimaryImageTag: member?.photo ? 'p' : undefined };
  };
  const list = (value: unknown) => (Array.isArray(value) ? value : []);

  const people = list(extras.cast).slice(0, 20).map((m: any) => person(m, 'Actor', m?.character || m?.role || ''));
  const directors = list(extras.directors).length ? list(extras.directors) : list(meta.director).map((name: any) => ({ name }));
  for (const d of directors) people.push(person(d, 'Director', ''));
  for (const w of list(extras.writers)) people.push(person(w, 'Writer', ''));

  const seen = new Set<string>();
  return people.filter((p: any) => p.Name && !seen.has(`${p.Type}|${p.Id}`) && seen.add(`${p.Type}|${p.Id}`));
}

// A direct video link plays in the client's own player, so those go first.
function remoteTrailers(meta: any): any[] {
  const streams = Array.isArray(meta.trailerStreams) ? meta.trailerStreams : [];
  const direct = streams
    .filter((t: any) => typeof t?.url === 'string' && /^https?:\/\//i.test(t.url))
    .map((t: any) => ({ Name: t.title || 'Trailer', Url: t.url }));
  const youtube = streams
    .filter((t: any) => typeof t?.ytId === 'string' && t.ytId)
    .map((t: any) => ({ Name: t.title || 'Trailer', Url: `https://www.youtube.com/watch?v=${t.ytId}` }));
  return [...direct, ...youtube].slice(0, envInt('JELLYFIN_MAX_TRAILERS', 8, 1));
}

const EPOCH_DATE = new Date(0).toISOString();

/** Jellyfin's sort key: the name lowercased with a leading article dropped. */
export function sortNameFor(name: any): string {
  return String(name ?? '').trim().toLowerCase().replace(/^(the|a|an)\s+/, '');
}

function isoDate(value: any): string | null {
  const at = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function premiereDate(meta: any): string | null {
  const released = isoDate(meta.released);
  if (released) return released;
  const year = parseInt(String(meta.year || meta.releaseInfo || ''), 10);
  return Number.isFinite(year) ? new Date(Date.UTC(year, 0, 1)).toISOString() : null;
}

function productionYear(meta: any): number | null {
  const raw = String(meta.year || meta.releaseInfo || '').slice(0, 4);
  const year = parseInt(raw, 10);
  return Number.isFinite(year) ? year : null;
}

export function jellyfinTypeFor(metaType: string): 'Movie' | 'Series' {
  return metaType === 'movie' || metaType === 'anime.movie' ? 'Movie' : 'Series';
}

export function metaToBaseItem(
  meta: any,
  mediaType: string,
  serverId: string,
  parentId: string | null
): any {
  const itemType = jellyfinTypeFor(meta.type || mediaType);
  const kind = itemType === 'Movie' ? 'movie' : 'series';
  const id = encodeJellyfinId({ k: kind, t: mediaType, i: String(meta.id) });

  const images: ItemImages = {
    primary: meta.poster || undefined,
    backdrop: meta.background || undefined,
    logo: meta.logo || undefined,
    thumb: meta.landscapePoster || undefined,
  };
  rememberImages(serverId, id, images);

  const imageTags: Record<string, string> = {};
  if (images.primary) imageTags.Primary = 'p';
  if (images.logo) imageTags.Logo = 'l';
  if (images.thumb) imageTags.Thumb = 't';

  return {
    Name: meta.name,
    SortName: sortNameFor(meta.name),
    Id: id,
    ServerId: serverId,
    Etag: id,
    Type: itemType,
    MediaType: itemType === 'Movie' ? 'Video' : 'Unknown',
    IsFolder: itemType === 'Series',
    ParentId: parentId,
    Overview: meta.description || null,
    ProductionYear: productionYear(meta),
    PremiereDate: premiereDate(meta),
    DateCreated: premiereDate(meta) ?? EPOCH_DATE,
    Genres: Array.isArray(meta.genres) ? meta.genres : [],
    GenreItems: (Array.isArray(meta.genres) ? meta.genres : []).map((g: string) => ({
      Name: g,
      Id: encodeJellyfinId({ k: 'genre', t: mediaType, c: 'all', g }),
    })),
    CommunityRating: parseRating(meta.imdbRating),
    OfficialRating: meta.app_extras?.certification || null,
    RunTimeTicks: parseRuntimeTicks(meta.runtime),
    ProviderIds: providerIds(meta),
    People: peopleFrom(meta, serverId),
    Studios: [],
    Taglines: [],
    RemoteTrailers: remoteTrailers(meta),
    ImageTags: imageTags,
    BackdropImageTags: images.backdrop ? ['b'] : [],
    ImageBlurHashes: {},
    UserData: { ...EMPTY_USER_DATA, Key: id, ItemId: id },
    LocationType: 'FileSystem',
    PrimaryImageAspectRatio: itemType === 'Movie' ? 0.6666666666666666 : 0.6666666666666666,
    CanDelete: false,
    CanDownload: false,
    PlayAccess: 'Full',
    LockedFields: [],
    LockData: false,
    ChildCount: null,
    ...(itemType === 'Movie'
      ? { EnableMediaSourceDisplay: true, MediaSources: placeholderSources(id) }
      : {}),
  };
}

export interface ChildPageOptions {
  filters: string[];
  sortBy: string;
  descending: boolean;
  startIndex: number;
  limit: number;
}

/**
 * Watched state is owed to the page a client asked for, not to every episode of
 * a long show. A client filtering on played is the exception: each child has to
 * be judged before it can be left out.
 */
export async function pageChildren(
  children: any[],
  options: ChildPageOptions,
  applyState: (items: any[]) => Promise<void>
): Promise<{ page: any[]; total: number }> {
  const wantsPlayed = options.filters.includes('IsPlayed');
  const wantsUnplayed = options.filters.includes('IsUnplayed');

  let kept = children;
  if (wantsPlayed || wantsUnplayed) {
    await applyState(kept);
    if (wantsPlayed) kept = kept.filter((child: any) => child.UserData?.Played === true);
    if (wantsUnplayed) kept = kept.filter((child: any) => child.UserData?.Played !== true);
  }

  if (options.sortBy.includes('IndexNumber')) {
    kept = [...kept].sort((a: any, b: any) =>
      ((a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0)) || ((a.IndexNumber ?? 0) - (b.IndexNumber ?? 0))
    );
    if (options.descending) kept.reverse();
  }

  const page = kept.slice(options.startIndex, options.startIndex + options.limit);
  if (!wantsPlayed && !wantsUnplayed) await applyState(page);

  return { page, total: kept.length };
}

/** The same decision filterByIncludeTypes makes, taken on a meta. */
export function includeTypesFilter(
  mediaType: string,
  includeItemTypes: string | undefined
): ((meta: any) => boolean) | undefined {
  if (!includeItemTypes) return undefined;

  const wanted = new Set(includeItemTypes.split(',').map((t) => t.trim()).filter(Boolean));
  if (!wanted.size || (!wanted.has('Movie') && !wanted.has('Series'))) return undefined;

  return (meta: any) => wanted.has(jellyfinTypeFor(meta?.type || mediaType));
}

export function filterByIncludeTypes(items: any[], includeItemTypes: string | undefined): any[] {
  if (!includeItemTypes) return items;
  const wanted = new Set(
    includeItemTypes.split(',').map((t) => t.trim()).filter(Boolean)
  );
  if (wanted.size === 0) return items;
  return items.filter((item) => wanted.has(item.Type));
}

const metaMemo = new LRUCache<string, any>({
  max: envInt('JELLYFIN_META_MEMO_MAX', 300, 1),
  ttl: envInt('JELLYFIN_META_MEMO_TTL', 60, 1) * 1000,
});
const metaInFlight = new Map<string, Promise<any | null>>();

export async function fetchMeta(
  userUUID: string,
  stremioType: string,
  id: string
): Promise<any | null> {
  const key = `${userUUID}|${stremioType}|${id}`;
  const held = metaMemo.get(key);
  if (held) return held;
  const running = metaInFlight.get(key);
  if (running) return running;

  const url = `${localBase()}/stremio/${encodeURIComponent(userUUID)}/meta/${encodeURIComponent(stremioType)}/${encodeURIComponent(id)}.json`;
  const work = (async () => {
    try {
      const response = await loopbackFetch(url);
      if (!response.ok) {
        logger.debug(`Meta ${stremioType}/${id} returned ${response.status}`);
        return null;
      }
      const body: any = await response.json();
      const meta = body?.meta ?? null;
      if (meta) metaMemo.set(key, meta);
      return meta;
    } catch (error: any) {
      logger.warn(`Meta ${stremioType}/${id} failed: ${error?.message || error}`);
      return null;
    } finally {
      metaInFlight.delete(key);
    }
  })();
  metaInFlight.set(key, work);
  return work;
}

function seasonNumbersFrom(videos: any[]): number[] {
  const seasons = new Set<number>();
  for (const video of videos) {
    if (Number.isInteger(video?.season)) seasons.add(video.season);
  }
  return [...seasons].sort((a, b) => a - b);
}

function parentArt(meta: any, seriesId: string, serverId: string): Record<string, any> {
  const images: ItemImages = {
    primary: meta.poster || undefined,
    backdrop: meta.background || undefined,
    logo: meta.logo || undefined,
    thumb: meta.landscapePoster || undefined,
  };
  if (serverId && seriesId) rememberImages(serverId, seriesId, images);

  const art: Record<string, any> = {};
  if (images.primary) art.SeriesPrimaryImageTag = 'p';
  if (images.backdrop) {
    art.ParentBackdropItemId = seriesId;
    art.ParentBackdropImageTags = ['b'];
  }
  if (images.logo) {
    art.ParentLogoItemId = seriesId;
    art.ParentLogoImageTag = 'l';
  }
  if (images.thumb) {
    art.ParentThumbItemId = seriesId;
    art.ParentThumbImageTag = 't';
    art.SeriesThumbImageTag = 't';
  }
  return art;
}

export function buildSeasons(
  meta: any,
  mediaType: string,
  seriesId: string,
  serverId: string
): any[] {
  const videos = Array.isArray(meta?.videos) ? meta.videos : [];
  const numbers = seasonNumbersFrom(videos);

  // Keyed by season where the meta carries it. Older cached metas hold only the
  // bare list, which dropped the season numbers, so that is trusted only when
  // there is one poster per season published and otherwise falls back to the
  // series poster rather than hanging the wrong season's art on a season.
  const byNumber = meta?.app_extras?.seasonPosterByNumber;
  const posters = Array.isArray(meta?.app_extras?.seasonPosters) ? meta.app_extras.seasonPosters : [];
  const aligned = posters.length === numbers.length;

  const art = parentArt(meta, seriesId, serverId);
  return numbers.map((season, index) => {
    const id = encodeJellyfinId({ k: 'season', t: mediaType, i: String(meta.id), s: season });
    const episodes = videos.filter((v: any) => v.season === season);

    const primary = byNumber?.[season] || (aligned ? posters[index] : undefined) || meta.poster || undefined;
    if (primary) rememberImages(serverId, id, { primary, backdrop: meta.background || undefined });

    return {
      Name: season === 0 ? 'Specials' : `Season ${season}`,
      SortName: season === 0 ? 'specials' : `season ${String(season).padStart(3, '0')}`,
      Id: id,
      ServerId: serverId,
      Etag: id,
      Type: 'Season',
      MediaType: 'Unknown',
      IsFolder: true,
      ParentId: seriesId,
      SeriesId: seriesId,
      SeriesName: meta.name,
      IndexNumber: season,
      DateCreated: EPOCH_DATE,
      ChildCount: episodes.length,
      RecursiveItemCount: episodes.length,
      UserData: { ...EMPTY_USER_DATA, Key: id, ItemId: id },
      ImageTags: primary ? { Primary: 'p' } : {},
      BackdropImageTags: [],
      ImageBlurHashes: {},
      ...art,
      LocationType: 'FileSystem',
      PrimaryImageAspectRatio: 0.6666666666666666,
      CanDelete: false,
      CanDownload: false,
    };
  });
}

export function buildEpisodes(
  meta: any,
  mediaType: string,
  seriesId: string,
  serverId: string,
  season: number | null
): any[] {
  const wanted = episodeVideos(meta, season);
  const art = parentArt(meta, seriesId, serverId);
  return wanted.map((video: any) => buildEpisode(meta, video, mediaType, seriesId, serverId, art));
}

function episodeVideos(meta: any, season: number | null): any[] {
  const videos = Array.isArray(meta?.videos) ? meta.videos : [];
  return season === null ? videos : videos.filter((v: any) => v.season === season);
}

/** The season and episode an item's id is built from, as buildEpisode spells them. */
function episodeIdentity(meta: any, video: any): { base: string; season: number | null; episode: number } {
  const parsed = parseStremioId(String(video.id ?? ''));
  if (parsed) return { base: parsed.base, season: parsed.season, episode: parsed.episode as number };
  return {
    base: String(meta.id),
    season: Number.isInteger(video.season) ? video.season : null,
    episode: Number(video.episode),
  };
}

/** The video an episode descriptor names, without building the ones it does not. */
export function findEpisodeVideo(meta: any, descriptor: any): any | null {
  for (const video of episodeVideos(meta, null)) {
    const id = episodeIdentity(meta, video);
    if (id.base === descriptor.i && id.season === descriptor.s && id.episode === descriptor.e) return video;
  }
  return null;
}

const sortSeason = (video: any): number => (Number.isInteger(video.season) ? video.season : null) ?? 0;

/** A page of a series' episodes, built without constructing the ones it leaves out. */
export function pageEpisodes(
  meta: any,
  mediaType: string,
  seriesId: string,
  serverId: string,
  season: number | null,
  options: { sortBy: string; descending: boolean; startIndex: number; limit: number }
): { page: any[]; total: number } {
  let wanted = episodeVideos(meta, season);
  if (options.sortBy.includes('IndexNumber')) {
    wanted = [...wanted].sort(
      (a: any, b: any) => (sortSeason(a) - sortSeason(b)) || (Number(a.episode) - Number(b.episode))
    );
    if (options.descending) wanted.reverse();
  }
  const art = parentArt(meta, seriesId, serverId);
  const page = wanted
    .slice(options.startIndex, options.startIndex + options.limit)
    .map((video: any) => buildEpisode(meta, video, mediaType, seriesId, serverId, art));
  return { page, total: wanted.length };
}

export function buildEpisode(
  meta: any,
  video: any,
  mediaType: string,
  seriesId: string,
  serverId: string,
  parentImages?: Record<string, any>
): any {
  const art = parentImages ?? parentArt(meta, seriesId, serverId);
  {
    const hasSeason = Number.isInteger(video.season);

    // A video carries its own id, and it is not always built from the series
    // one: a MAL series (mal:52991) publishes kitsu:46474:1 episodes. Identity
    // comes from that id so it rebuilds to what a stream addon was given, while
    // season and episode numbering stay with the video for display.
    const parsed = parseStremioId(String(video.id ?? ''));
    const id = encodeJellyfinId(
      parsed
        ? { k: 'episode', t: mediaType, i: parsed.base, s: parsed.season, e: parsed.episode as number }
        : {
            k: 'episode',
            t: mediaType,
            i: String(meta.id),
            s: hasSeason ? video.season : null,
            e: Number(video.episode),
          }
    );
    const parentSeasonId = hasSeason
      ? encodeJellyfinId({ k: 'season', t: mediaType, i: String(meta.id), s: video.season })
      : seriesId;

    if (video.thumbnail) rememberImages(serverId, id, { primary: video.thumbnail });

    return {
      Name: video.title || `Episode ${video.episode}`,
      SortName: `${String(video.episode).padStart(4, '0')} - ${sortNameFor(video.title || `Episode ${video.episode}`)}`,
      Id: id,
      ServerId: serverId,
      Etag: id,
      Type: 'Episode',
      MediaType: 'Video',
      IsFolder: false,
      ParentId: parentSeasonId,
      SeasonId: hasSeason ? parentSeasonId : null,
      SeriesId: seriesId,
      SeriesName: meta.name,
      OfficialRating: meta.app_extras?.certification || null,
      ParentIndexNumber: hasSeason ? video.season : null,
      IndexNumber: Number(video.episode),
      Overview: video.overview || null,
      PremiereDate: isoDate(video.released),
      DateCreated: isoDate(video.released) || EPOCH_DATE,
      RunTimeTicks: parseRuntimeTicks(video.runtime),
      ProviderIds: {},
      ImageTags: video.thumbnail ? { Primary: 'p' } : {},
      BackdropImageTags: [],
      ImageBlurHashes: {},
      ...art,
      UserData: { ...EMPTY_USER_DATA, Key: id, ItemId: id },
      LocationType: 'FileSystem',
      PrimaryImageAspectRatio: 1.7777777777777777,
      CanDelete: false,
      CanDownload: false,
      LockedFields: [],
      LockData: false,
      EnableMediaSourceDisplay: true,
      MediaSources: placeholderSources(id),
    };
  }
}
