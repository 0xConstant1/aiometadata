import type { CatalogConfig } from '@/contexts/config';

export type PosterShape = 'poster' | 'landscape';

export function mergedSourcesShape(catalog: CatalogConfig, catalogs: CatalogConfig[]): PosterShape {
  const entries = (catalog.metadata?.mergedSources || [])
    .map(s => catalogs.find(c => c.id === s.catalogId && c.type === s.catalogType))
    .filter(Boolean) as CatalogConfig[];
  return entries.length > 0 && entries.every(c => c.metadata?.posterShape === 'landscape') ? 'landscape' : 'poster';
}

export function resolvedPosterShape(catalog: CatalogConfig, catalogs: CatalogConfig[]): PosterShape {
  if (catalog.metadata?.posterShape) return catalog.metadata.posterShape;
  return catalog.source === 'merged' ? mergedSourcesShape(catalog, catalogs) : 'poster';
}
