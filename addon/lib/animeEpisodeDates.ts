import { withEpisodeOrder } from '../utils/episodeOrder';
import { anilistIdForMal, anilistReleaseTimes, hasAnime, isStale, releaseTime } from './animeAiringSchedule';
import type { ScheduleKind } from './animeAiringSchedule';

export type AnimeEpisodeDates = 'provider' | 'earliest' | 'dub';

interface Target {
  anilistId: number;
  episode: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Dubs trail the original by months, so the window reaches well back.
const LOOKBACK_MS = 365 * DAY_MS;

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function anilistIdOf(mapping: any): number | null {
  return positive(mapping?.anilist_id) ?? anilistIdForMal(mapping?.mal_id);
}

/** The AniList anime and episode a video belongs to, or null when the mapping is not certain. */
async function resolveTarget(meta: any, video: any, config: any): Promise<Target | null> {
  const season = positive(video?.season);
  const episode = positive(video?.episode);
  if (!season || !episode) return null;

  if (meta._metaProvider === 'tvdb') {
    const tvdbId = positive(meta._tvdbId);
    if (!tvdbId) return null;
    const order = withEpisodeOrder(config, String(tvdbId)).tvdbSeasonType || 'default';
    if (order !== 'default' && order !== 'official') return null;
    const animeList = require('./anime-list-mapper');
    const anidb = await animeList.resolveAnidbEpisodeFromTvdbEpisode(tvdbId, season, episode);
    if (!positive(anidb?.anidbId) || !positive(anidb?.anidbEpisode) || Number(anidb.anidbSeason) !== 1) return null;
    // Only a mapping that leads back to the same episode is trusted.
    const back = animeList.resolveTvdbEpisodeFromAnidbEpisode(anidb.anidbId, 1, anidb.anidbEpisode);
    if (Number(back?.tvdbId) !== tvdbId || Number(back?.tvdbSeason) !== season || Number(back?.tvdbEpisode) !== episode) return null;
    const anilistId = anilistIdOf(require('./id-mapper').getMappingByAnidbId(anidb.anidbId));
    return anilistId ? { anilistId, episode: anidb.anidbEpisode } : null;
  }

  // Kitsu and MAL describe one anime entry, numbered from 1 in a single season.
  if ((meta._metaProvider === 'kitsu' || meta._metaProvider === 'mal') && season === 1) {
    const mapper = require('./id-mapper');
    const anilistId = positive(meta._anilistId)
      ?? anilistIdForMal(meta._malId)
      ?? (meta._malId ? anilistIdOf(mapper.getMappingByMalId(meta._malId)) : null)
      ?? (meta._kitsuId ? anilistIdOf(mapper.getMappingByKitsuId(meta._kitsuId)) : null);
    return anilistId ? { anilistId, episode } : null;
  }

  return null;
}

function releasedMs(video: any): number | null {
  if (!video?.released) return null;
  const ms = video.released instanceof Date ? video.released.getTime() : new Date(video.released).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Replaces anime episode dates with the earliest release anywhere or the English dub release, as
 * the user chose. Applied when a meta is served, so the cached meta keeps the provider's dates.
 */
export async function applyAnimeEpisodeDatesProjection(meta: any, config: any): Promise<void> {
  const choice: AnimeEpisodeDates = config?.animeEpisodeDates || 'provider';
  if (choice === 'provider' || !Array.isArray(meta?.videos) || !meta.videos.length) return;
  if (!['tvdb', 'kitsu', 'mal'].includes(meta._metaProvider)) return;
  const kind: ScheduleKind = choice === 'dub' ? 'dub' : 'earliest';

  try {
    const now = Date.now();
    const candidates = meta.videos.filter((video: any) => {
      const ms = releasedMs(video);
      return ms === null || ms >= now - LOOKBACK_MS;
    });
    const targets = new Map<any, Target>();
    for (const video of candidates) {
      const target = await resolveTarget(meta, video, config).catch(() => null);
      if (target) targets.set(video, target);
    }
    if (!targets.size) return;

    const anilistIds = [...new Set([...targets.values()].map((target) => target.anilistId))];
    const fromAnilist = kind === 'earliest' && isStale() ? await anilistReleaseTimes(anilistIds) : null;
    if (!fromAnilist && !anilistIds.some((id) => hasAnime(kind, id))) return;

    const dates = new Map<any, number>();
    for (const [video, target] of targets) {
      const scheduled = fromAnilist
        ? fromAnilist.get(target.anilistId)?.get(target.episode) ?? null
        : releaseTime(kind, target.anilistId, target.episode);
      if (scheduled === null) continue;
      const provider = releasedMs(video);
      // The earliest release never moves an episode later than its provider date.
      const chosen = kind === 'earliest' && provider !== null ? Math.min(provider, scheduled) : scheduled;
      if (chosen !== provider) dates.set(video, chosen);
    }
    if (!dates.size) return;

    meta.videos = meta.videos.map((video: any) => {
      const chosen = dates.get(video);
      if (chosen === undefined) return video;
      const updated = { ...video, released: new Date(chosen).toISOString() };
      if (Object.prototype.hasOwnProperty.call(video, 'available')) updated.available = chosen <= now;
      return updated;
    });
  } catch {
    // The provider's dates stand when anything about the schedule fails.
  }
}
