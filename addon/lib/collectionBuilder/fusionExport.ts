import {
  MANIFEST_PLACEHOLDER,
  folderSources,
  type AddonIdentity,
  type BuilderEntry,
  type ExportNote,
  type ExportResult,
  type FolderDraft,
  type FusionAddonCatalogSource,
  type FusionAspectRatio,
  type FusionCollectionItem,
  type FusionDataSource,
  type FusionNativeSource,
  type FusionWidget,
  type FusionWidgetsConfig,
  type SourceDraft,
  type TileShape,
} from './types';
import {
  createBlueprintWriter,
  isNativeSource,
  lookupKey,
  nativeOrigin,
  type BlueprintLookup,
} from './catalogReconstruction';

type AttachBlueprint = ReturnType<typeof createBlueprintWriter>;

function trimmed(value: unknown): string {
  return String(value ?? '').trim();
}

const ASPECT_BY_SHAPE: Record<TileShape, FusionAspectRatio> = {
  LANDSCAPE: 'wide',
  POSTER: 'poster',
  SQUARE: 'square',
};

/**
 * Fusion addresses a catalog as `<type>::<id>`, and its importers normalise both
 * halves before comparing. We reproduce that normalisation so an import leaves
 * our files untouched. The rules are behavioural requirements of the format, not
 * preferences: changing one silently breaks round-tripping, so they are kept as
 * data and covered by an equivalence test.
 */

/** Spellings of a media type that mean the same thing. */
const TYPE_ALIASES: Record<string, string> = {
  movies: 'movie',
  show: 'series',
  shows: 'series',
  tv: 'series',
};

function normalizeFusionCatalogType(value: unknown): string {
  const normalized = trimmed(value).toLowerCase();
  return TYPE_ALIASES[normalized] ?? normalized;
}

/** `<prefix>::` on an id already states the type. */
const PREFIX_TYPES: Record<string, string> = {
  movie: 'movie',
  movies: 'movie',
  series: 'series',
  shows: 'series',
};

/**
 * Combined-type catalogs that only ever yield series, so `all::` must not be
 * carried through for them.
 */
const SERIES_OVERRIDES: ((id: string) => boolean)[] = [
  id => id.startsWith('all::trakt.list.'),
  id => id.startsWith('all::mdblist.') && id.includes('.unified'),
  id => !id.startsWith('all::') && id.includes('mdblist.upnext'),
];

function resolveFusionCatalogType(catalogId: string, currentType?: string): string {
  const id = catalogId.toLowerCase();
  const declared = normalizeFusionCatalogType(currentType);

  if (SERIES_OVERRIDES.some(matches => matches(id))) return 'series';

  // A combined catalog keeps its breadth unless the caller says otherwise.
  if (id.startsWith('all::')) {
    return declared && declared !== 'all' ? declared : 'all';
  }

  const prefix = id.slice(0, Math.max(id.indexOf('::'), 0));
  return PREFIX_TYPES[prefix] ?? (declared || 'movie');
}

/**
 * Types Fusion will take on a classic row. Anything else, `anime` and `all` among
 * them, makes the whole file unimportable rather than just that row: the same
 * catalog inside a collection is accepted, so that is where it has to go.
 */
const CLASSIC_ROW_TYPES = new Set(['movie', 'series']);

/** Classic rows Fusion would reject, by title, so the editor can say which. */
export function unsupportedClassicRows(
  entries: BuilderEntry[]
): Array<{ id: string; title: string; type: string }> {
  const rows: Array<{ id: string; title: string; type: string }> = [];
  for (const entry of entries) {
    if (entry.kind !== 'classicRow' || !entry.source) continue;
    if (isNativeSource(entry.source)) continue;
    const plainId = trimmed(entry.source.catalogId);
    const manifestType = trimmed(entry.source.type);
    if (!plainId || !manifestType) continue;
    const type = resolveFusionCatalogType(`${manifestType}::${plainId}`, manifestType);
    if (CLASSIC_ROW_TYPES.has(type)) continue;
    rows.push({ id: entry.id, title: trimmed(entry.title) || 'Untitled row', type });
  }
  return rows;
}

function normalizeCatalogId(catalogId: string, catalogType: string): string {
  const value = catalogId.trim();
  if (!value) return '';

  const separator = value.indexOf('::');
  if (separator < 0) {
    const resolved = resolveFusionCatalogType(value, catalogType).toLowerCase();
    return `${resolved}::${value}`;
  }

  const declaredPrefix = value.slice(0, separator);
  const rest = value.slice(separator + 2);
  const prefix = normalizeFusionCatalogType(declaredPrefix) || declaredPrefix.toLowerCase();
  return `${prefix}::${rest}`;
}

function resolveAddonId(identity: AddonIdentity, usePlaceholder: boolean): string {
  if (usePlaceholder) return MANIFEST_PLACEHOLDER;
  return trimmed(identity.manifestUrl) || MANIFEST_PLACEHOLDER;
}

function toDataSource(
  source: SourceDraft,
  addonId: string,
  attach: AttachBlueprint
): FusionAddonCatalogSource | null {
  const plainId = trimmed(source.catalogId);
  const manifestType = trimmed(source.type);
  if (!plainId || !manifestType) return null;

  const composite = `${manifestType}::${plainId}`;
  const catalogType = resolveFusionCatalogType(composite, manifestType);
  const genre = trimmed(source.genre);
  return {
    kind: 'addonCatalog',
    payload: attach({
      addonId,
      catalogId: normalizeCatalogId(composite, catalogType),
      type: catalogType,
      ...(genre ? { genre } : {}),
    }, lookupKey(plainId, source.type)),
  };
}

function rowDataSource(
  source: SourceDraft | null,
  addonId: string,
  attach: AttachBlueprint
): FusionDataSource | null {
  if (!source) return null;
  if (isNativeSource(source)) {
    return nativeOrigin(source) === 'fusion' && source.native
      ? (source.native as FusionNativeSource)
      : null;
  }
  return toDataSource(source, addonId, attach);
}

function toCollectionItem(
  folder: FolderDraft,
  addonId: string,
  collectionTitle: string,
  notes: ExportNote[],
  attach: AttachBlueprint
): FusionCollectionItem | null {
  const id = trimmed(folder.id);
  const name = trimmed(folder.title);
  if (!id || !name) {
    notes.push({
      entryId: folder.id,
      entryTitle: collectionTitle,
      message: 'A folder without a title was skipped.',
      severity: 'warning',
    });
    return null;
  }

  const dataSources: FusionDataSource[] = [];
  let nativeSkipped = 0;
  for (const source of folderSources(folder)) {
    if (isNativeSource(source)) {
      if (nativeOrigin(source) === 'fusion' && source.native) {
        dataSources.push(source.native as FusionNativeSource);
        continue;
      }
      nativeSkipped += 1;
      continue;
    }
    const mapped = toDataSource(source, addonId, attach);
    if (!mapped) {
      notes.push({
        entryId: folder.id,
        entryTitle: name,
        message: `Source "${trimmed(source.name) || trimmed(source.catalogId) || 'unnamed'}" is missing a catalog id or type and was skipped.`,
        severity: 'warning',
      });
      continue;
    }
    dataSources.push(mapped);
  }

  // One note per folder rather than per source: a collection can hold hundreds.
  if (nativeSkipped > 0) {
    notes.push({
      entryId: folder.id,
      entryTitle: name,
      message: `"${name}": ${nativeSkipped} source${nativeSkipped === 1 ? ' is' : 's are'} resolved by Nuvio itself. Fusion has no equivalent, so ${nativeSkipped === 1 ? 'it is' : 'they are'} only in the Nuvio export.`,
      severity: 'info',
    });
  }

  if (dataSources.length === 0) {
    notes.push({
      entryId: folder.id,
      entryTitle: name,
      message: `Folder "${name}" has no sources. It is exported anyway, so its artwork survives, and it stays empty until you add one.`,
      severity: 'info',
    });
  }

  const imageURL = trimmed(folder.coverImageUrl);
  return {
    id,
    title: name,
    hideTitle: Boolean(folder.hideTitle),
    imageAspect: ASPECT_BY_SHAPE[folder.shape],
    ...(imageURL ? { imageURL } : {}),
    dataSources,
  };
}

/** The addons an importer has to have installed for the file to resolve. */
function requiredAddons(widgets: FusionWidget[]): string[] {
  const addons = new Set<string>();
  const take = (source: FusionDataSource) => {
    if (source.kind !== 'addonCatalog') return;
    const addonId = (source as FusionAddonCatalogSource).payload.addonId;
    if (addonId.startsWith('http')) addons.add(addonId);
  };

  for (const widget of widgets) {
    if (widget.type === 'collection.row') {
      for (const item of widget.dataSource.payload.items) item.dataSources.forEach(take);
      continue;
    }
    take(widget.dataSource);
  }

  return [...addons];
}

/** Fusion namespaces widget ids by kind: `collection.<id>` and `catalog.<id>`. */
function prefixedId(id: string, prefix: string): string {
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

export function toFusionWidgets(
  entries: BuilderEntry[],
  identity: AddonIdentity,
  options: { usePlaceholder?: boolean; blueprints?: BlueprintLookup } = {}
): ExportResult<FusionWidgetsConfig> {
  const notes: ExportNote[] = [];
  const widgets: FusionWidget[] = [];
  const addonId = resolveAddonId(identity, options.usePlaceholder === true);
  const attach = createBlueprintWriter(options.blueprints || {});

  for (const entry of entries) {
    const id = trimmed(entry.id);
    const title = trimmed(entry.title);
    if (!id || !title) {
      notes.push({
        entryId: entry.id,
        entryTitle: entry.title,
        message: 'An entry without a title was skipped.',
        severity: 'warning',
      });
      continue;
    }

    if (entry.kind === 'collection') {
      const items = entry.folders
        .map(folder => toCollectionItem(folder, addonId, title, notes, attach))
        .filter((item): item is FusionCollectionItem => item !== null);

      widgets.push({
        id: prefixedId(id, 'collection.'),
        title,
        ...(entry.hideTitle ? { hideTitle: true } : {}),
        type: 'collection.row',
        dataSource: { kind: 'collection', payload: { items } },
      });
      continue;
    }

    const dataSource = rowDataSource(entry.source, addonId, attach);
    if (!dataSource) {
      notes.push({
        entryId: entry.id,
        entryTitle: title,
        message: entry.source && isNativeSource(entry.source)
          ? `Row "${title}" is served by Nuvio, and Fusion has no equivalent, so it was skipped.`
          : `Row "${title}" has no catalog selected and was skipped.`,
        severity: 'warning',
      });
      continue;
    }
    widgets.push({
      id: prefixedId(id, 'catalog.'),
      title,
      ...(entry.hideTitle ? { hideTitle: true } : {}),
      type: entry.numbered ? 'row.classic.numbered' : 'row.classic',
      cacheTTL: entry.cacheTTL,
      limit: entry.limit,
      presentation: {
        aspectRatio: entry.aspectRatio,
        cardStyle: entry.cardStyle,
        badges: { providers: Boolean(entry.badges.providers), ratings: Boolean(entry.badges.ratings) },
        ...(trimmed(entry.backgroundImageURL) ? { backgroundImageURL: trimmed(entry.backgroundImageURL) } : {}),
      },
      dataSource,
    });
  }

  return {
    output: {
      exportType: 'fusionWidgets',
      exportVersion: 1,
      requiredAddons: requiredAddons(widgets),
      widgets,
    },
    notes,
  };
}
