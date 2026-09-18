import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { encodeJellyfinId } from './ids';
import { collectionFolder, EMPTY_USER_DATA } from './dto';
import { fetchWindow, includeTypesFilter, knownCatalogLength, metaToBaseItem, rememberImages } from './items';
import { getCatalogs, type CatalogRef } from './views';
import { profileTags } from './profiles';
import type { CollectionDraft, FolderDraft, SourceDraft } from '../collectionBuilder/types';

// A builder collection is a library of box sets; a folder is one box set whose sources are its members.

const IMAGE_URL = /^https?:\/\//i;

function imageOf(value: unknown): string | undefined {
  return typeof value === 'string' && IMAGE_URL.test(value.trim()) ? value.trim() : undefined;
}

/** An entry with tags is for the users holding one of them; the unrestricted user sees every entry. */
export function entryVisible(entry: any, config: any): boolean {
  const wanted = Array.isArray(entry?.tags) ? entry.tags.filter(Boolean) : [];
  if (!wanted.length) return true;
  const held = new Set(profileTags(config).map((t) => t.toLowerCase()));
  if (!held.size) return true;
  return wanted.some((t: string) => held.has(String(t).toLowerCase()));
}

export function builderCollections(config: any): CollectionDraft[] {
  const entries = Array.isArray(config?.collections) ? config.collections : [];
  return entries.filter((e: any) =>
    e?.kind === 'collection' && typeof e.id === 'string' && e.id && typeof e.title === 'string' && entryVisible(e, config)
  );
}

export function collectionById(config: any, id: string): CollectionDraft | null {
  return builderCollections(config).find((c) => c.id === id) ?? null;
}

export function collectionViewId(collection: CollectionDraft): string {
  return encodeJellyfinId({ k: 'collection', c: collection.id });
}


export function boxSetId(collection: CollectionDraft, folder: FolderDraft): string {
  return encodeJellyfinId({ k: 'boxset', c: collection.id, f: folder.id });
}

/** A source names a catalog by manifest id and type; one outside the user's catalogs is not shown. */
function catalogFor(catalogs: CatalogRef[], source: SourceDraft): CatalogRef | null {
  const id = String(source?.catalogId ?? '').trim();
  const type = String(source?.type ?? '').trim().toLowerCase();
  if (!id || !type) return null;
  return catalogs.find((c) => c.id === id && c.type.toLowerCase() === type) ?? null;
}

function visibleSources(catalogs: CatalogRef[], folder: FolderDraft): Array<{ source: SourceDraft; catalog: CatalogRef }> {
  const out: Array<{ source: SourceDraft; catalog: CatalogRef }> = [];
  for (const source of Array.isArray(folder?.sources) ? folder.sources : []) {
    const catalog = catalogFor(catalogs, source);
    if (catalog) out.push({ source, catalog });
  }
  return out;
}

export function collectionView(serverId: string, collection: CollectionDraft, folderCount: number | null): any {
  const id = collectionViewId(collection);
  const backdrop = imageOf(collection.backdropImageUrl);
  if (backdrop) rememberImages(serverId, id, { primary: backdrop, backdrop });
  const view = collectionFolder(id, serverId, collection.title, 'boxsets', folderCount);
  if (backdrop) {
    view.ImageTags = { Primary: 'p' };
    view.BackdropImageTags = ['b'];
  }
  return view;
}

function boxSetItem(serverId: string, collection: CollectionDraft, folder: FolderDraft, sourceCount: number): any {
  const id = boxSetId(collection, folder);
  const cover = imageOf(folder.coverImageUrl);
  const backdrop = imageOf(folder.heroBackdropUrl);
  const logo = imageOf(folder.titleLogoUrl);
  if (cover || backdrop || logo) rememberImages(serverId, id, { primary: cover, backdrop, logo });

  return {
    Name: folder.title,
    ServerId: serverId,
    Id: id,
    Etag: id,
    DateCreated: new Date(0).toISOString(),
    CanDelete: false,
    CanDownload: false,
    SortName: folder.title,
    ExternalUrls: [],
    Path: `/${id}`,
    EnableMediaSourceDisplay: false,
    Taglines: [],
    RemoteTrailers: [],
    ProviderIds: {},
    IsFolder: true,
    ParentId: collectionViewId(collection),
    Type: 'BoxSet',
    People: [],
    Studios: [],
    GenreItems: [],
    Genres: [],
    LocalTrailerCount: 0,
    UserData: { ...EMPTY_USER_DATA, Key: id, ItemId: id },
    ChildCount: sourceCount,
    RecursiveItemCount: null,
    DisplayPreferencesId: id,
    Tags: [],
    PrimaryImageAspectRatio: folder.shape === 'LANDSCAPE' ? 1.7777777777777777 : folder.shape === 'SQUARE' ? 1 : 0.6666666666666666,
    ImageTags: cover ? { Primary: 'p', ...(logo ? { Logo: 'l' } : {}) } : logo ? { Logo: 'l' } : {},
    BackdropImageTags: backdrop ? ['b'] : [],
    ImageBlurHashes: {},
    LocationType: 'FileSystem',
    MediaType: 'Unknown',
    LockedFields: [],
    LockData: false,
  };
}

/** The folders of a collection this user can see anything in. */
export async function boxSetsFor(userUUID: string, config: any, serverId: string, collection: CollectionDraft): Promise<any[]> {
  const catalogs = await getCatalogs(userUUID, config);
  const out: any[] = [];
  for (const folder of Array.isArray(collection.folders) ? collection.folders : []) {
    if (!folder?.id || typeof folder.title !== 'string') continue;
    const sources = visibleSources(catalogs, folder);
    if (!sources.length) continue;
    out.push(boxSetItem(serverId, collection, folder, sources.length));
  }
  return out;
}

export async function allBoxSets(userUUID: string, config: any, serverId: string): Promise<any[]> {
  const out: any[] = [];
  for (const collection of builderCollections(config)) {
    out.push(...(await boxSetsFor(userUUID, config, serverId, collection)));
  }
  return out;
}

/** Every collection as a library, with only the folders the user can see. */
export async function collectionViews(userUUID: string, config: any, serverId: string): Promise<any[]> {
  const views: any[] = [];
  for (const collection of builderCollections(config)) {
    const folders = await boxSetsFor(userUUID, config, serverId, collection);
    if (!folders.length) continue;
    views.push(collectionView(serverId, collection, folders.length));
  }
  return views;
}

export interface MembersPage {
  items: any[];
  hasMore: boolean;
}

interface MemberCursor {
  nextIndex: number;
  sourceIndex: number;
  sourceOffset: number;
  seen: Set<string>;
}

const memberCursors = new LRUCache<string, MemberCursor>({
  max: 50,
  ttl: envInt('JELLYFIN_FOLDER_CURSOR_TTL', 600, 30) * 1000,
});
const MEMBER_CURSOR_MAX_IDS = 25000;

export async function boxSetMembers(
  userUUID: string,
  config: any,
  serverId: string,
  collection: CollectionDraft,
  folder: FolderDraft,
  startIndex: number,
  limit: number,
  includeItemTypes?: string
): Promise<MembersPage> {
  const sources = visibleSources(await getCatalogs(userUUID, config), folder);
  const parentId = boxSetId(collection, folder);
  const tags = profileTags(config);
  const extrasOf = (source: SourceDraft): Record<string, string> =>
    typeof source.genre === 'string' && source.genre && source.genre !== 'None' ? { genre: source.genre } : {};

  const cursorKey = JSON.stringify([
    userUUID, collection.id, folder.id, includeItemTypes ?? '', tags,
    sources.map(({ source, catalog }) => [catalog.type, catalog.id, String(source.genre ?? '')]),
  ]);
  const held = memberCursors.get(cursorKey);

  let sourceIndex = 0;
  let from = 0;
  let seen: Set<string>;
  let toSkip = 0;
  if (held && held.nextIndex === startIndex) {
    sourceIndex = held.sourceIndex;
    from = held.sourceOffset;
    seen = new Set(held.seen);
  } else if (sources.length > 1) {
    seen = new Set<string>();
    toSkip = startIndex;
  } else {
    seen = new Set<string>();
    let passed = 0;
    while (sourceIndex < sources.length) {
      const { source, catalog } = sources[sourceIndex];
      const known = knownCatalogLength(userUUID, catalog, extrasOf(source), tags, includeItemTypes ?? '');
      if (known === undefined || passed + known > startIndex) break;
      passed += known;
      sourceIndex += 1;
    }
    from = Math.max(0, startIndex - passed);
  }

  const collected: any[] = [];
  let nextIndex = startIndex;

  while (sourceIndex < sources.length && collected.length < limit) {
    const { source, catalog } = sources[sourceIndex];
    const extras = extrasOf(source);
    const keep = includeTypesFilter(catalog.type, includeItemTypes);
    const page = await fetchWindow(userUUID, catalog, from, toSkip + limit - collected.length, extras, keep, tags, includeItemTypes ?? '')
      .catch(() => ({ items: [] as any[], hasMore: false }));

    for (const meta of page.items) {
      if (!meta?.id || seen.has(String(meta.id))) continue;
      seen.add(String(meta.id));
      if (toSkip > 0) {
        toSkip -= 1;
        continue;
      }
      collected.push(metaToBaseItem(meta, catalog.type, serverId, parentId));
      nextIndex += 1;
    }
    from += page.items.length;

    if (!page.hasMore || page.items.length === 0) {
      sourceIndex += 1;
      from = 0;
    }
  }

  const more = sourceIndex < sources.length;
  if (more && collected.length > 0 && seen.size <= MEMBER_CURSOR_MAX_IDS) {
    memberCursors.set(cursorKey, { nextIndex, sourceIndex, sourceOffset: from, seen });
  } else {
    memberCursors.delete(cursorKey);
  }

  return { items: collected, hasMore: more };
}

/** The pixel box a folder's cover is cropped to, matching the tile shape a client draws. */
export function folderCoverSize(config: any, collectionId: string, folderId: string): { width: number; height: number } {
  const folder = (collectionById(config, collectionId)?.folders ?? []).find((f: any) => f?.id === folderId);
  const shape = folder?.shape;
  if (shape === 'LANDSCAPE') return { width: 960, height: 540 };
  if (shape === 'SQUARE') return { width: 600, height: 600 };
  return { width: 600, height: 900 };
}
