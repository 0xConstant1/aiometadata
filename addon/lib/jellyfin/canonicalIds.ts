import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';

type Kind = 'movie' | 'series';

const memo = new LRUCache<string, Record<string, any>>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1) * 10,
  ttl: envInt('JELLYFIN_ID_RESOLUTION_DAYS', 30, 1) * 24 * 60 * 60 * 1000,
});

async function resolve(id: string, kind: Kind, config: any, targets: string[]): Promise<Record<string, any>> {
  const key = `${kind}:${id}:${targets.join(',')}`;
  const held = memo.get(key);
  if (held) return held;
  try {
    const { resolveAllIds } = require('../id-resolver');
    const all = await resolveAllIds(id, kind, config, {}, targets);
    const found = { imdb: all?.imdbId, tmdb: all?.tmdbId, tvdb: all?.tvdbId };
    if (found.imdb || found.tmdb || found.tvdb) memo.set(key, found);
    return found;
  } catch {
    return {};
  }
}

/** The tracker's ids, with the IMDb id the resolver gives its TVDB or TMDB id. */
export async function canonicalIds(ids: Record<string, any>, kind: Kind, config: any): Promise<Record<string, any>> {
  const anchor = kind === 'movie'
    ? (ids?.tmdb ? `tmdb:${ids.tmdb}` : null)
    : (ids?.tvdb ? `tvdb:${ids.tvdb}` : ids?.tmdb ? `tmdb:${ids.tmdb}` : null);
  if (!anchor) return ids ?? {};
  const resolved = await resolve(anchor, kind, config, ['imdb']);
  return {
    ...ids,
    ...(resolved.imdb ? { imdb: resolved.imdb } : {}),
    ...(!ids?.tmdb && resolved.tmdb ? { tmdb: resolved.tmdb } : {}),
    ...(!ids?.tvdb && resolved.tvdb ? { tvdb: resolved.tvdb } : {}),
  };
}

const ANIME_ID_TYPES = ['kitsu', 'mal', 'anilist', 'anidb'];

export function isAnimeTitle(id: string, kind: 'movie' | 'series'): boolean {
  const { parseStremioId } = require('./ids');
  const base = String(parseStremioId(id)?.base ?? id);
  const [prefix, value] = base.split(':');
  if (ANIME_ID_TYPES.includes(prefix)) return true;
  const idMapper = require('../id-mapper');
  if (base.startsWith('tt')) return Boolean(idMapper.getMappingByImdbId(base));
  if (prefix === 'tvdb') return Boolean(idMapper.getMappingByTvdbId(Number(value)));
  if (prefix === 'tmdb') return Boolean(idMapper.getMappingByTmdbId(Number(value), kind));
  return false;
}

/** A show's identity across spellings; anime keeps its own ids. */
export async function showIdentity(metaId: string, config: any): Promise<string> {
  const { parseStremioId } = require('./ids');
  const parsed = parseStremioId(metaId);
  const base = parsed?.base ?? metaId;
  if (!parsed || ANIME_ID_TYPES.includes(parsed.idType)) return base;
  const all = await resolve(base, 'series', config, ['tvdb', 'tmdb']);
  return all.tvdb ? `tvdb:${all.tvdb}` : all.tmdb ? `tmdb:${all.tmdb}` : base;
}

/** A video's identity across spellings; anime keeps its own ids. */
export async function titleIdentity(videoId: string, config: any): Promise<string> {
  const { parseStremioId } = require('./ids');
  const parsed = parseStremioId(videoId);
  if (!parsed) return videoId;
  if (ANIME_ID_TYPES.includes(parsed.idType)) return videoId;
  const isEpisode = parsed.episode !== null && parsed.episode !== undefined;
  if (isEpisode) return `${await showIdentity(parsed.base, config)}:${parsed.season ?? ''}:${parsed.episode}`;
  const all = await resolve(parsed.base, 'movie', config, ['tmdb']);
  return all.tmdb ? `tmdb:${all.tmdb}` : parsed.base;
}
