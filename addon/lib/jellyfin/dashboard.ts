import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { parseStremioId } from './idsCodec';
import { decodeJellyfinId, stremioIdFor } from './ids';
import { liveSessions, type LiveSession } from './playstate';
import { syncStatus } from './playstateSync';
import { seenConfigurations } from './context';
import { seriesIndex } from './episodeIndex';
import { fetchMeta } from './items';
import { defaultUserName, listProfiles } from './profiles';
import { mapWithConcurrency } from '../../utils/concurrency';

const database: any = require('../database');

export interface PlayRow {
  profile: string;
  videoId: string;
  imageUrl: string | null;
  posterUrl: string | null;
  title: string;
  episode: string | null;
  seriesId: string | null;
  season: number | null;
  number: number | null;
  episodeTitle: string | null;
  positionMs: number;
  runtimeMs: number;
  played: boolean;
  lastPlayedAt: number | null;
  updatedAt: number;
}

export interface SessionRow {
  profile: string;
  profileKey: string;
  /** The profile signed in, when it plays into another profile's history. */
  viewer: string | null;
  imageUrl: string | null;
  title: string;
  episode: string | null;
  positionMs: number;
  paused: boolean;
  at: number;
}

const titles = new LRUCache<string, Named>({
  max: 5000,
  ttl: envInt('JELLYFIN_DASHBOARD_TITLE_TTL', 24 * 60 * 60, 60) * 1000,
});

interface Named {
  /** Every identity the play answers to: its id spellings, the meta's ids, the episode it located. */
  keys: string[];
  title: string;
  episode: string | null;
  imageUrl: string | null;
  posterUrl: string | null;
  seriesId: string | null;
  season: number | null;
  number: number | null;
  episodeTitle: string | null;
}

async function withDeadline<T>(work: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), envInt('JELLYFIN_DASHBOARD_DESCRIBE_MS', 1500, 100)); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The meta's own images: an episode's still and its show's poster, a film's backdrop and poster.
async function describe(userUUID: string, videoId: string): Promise<Named> {
  const key = `${userUUID}:${videoId}`;
  const held = titles.get(key);
  if (held) return held;

  const parsed = parseStremioId(videoId);
  let out: Named = { keys: [videoId], title: videoId, episode: null, imageUrl: null, posterUrl: null, seriesId: null, season: null, number: null, episodeTitle: null };
  try {
    if (parsed && parsed.episode !== null && parsed.episode !== undefined) {
      const index = await seriesIndex(userUUID, parsed.base, { held: true });
      const video = index?.videos.find((v) => v.id === videoId)
        ?? index?.videos.find((v) => v.episode === parsed.episode && (parsed.season === null ? v.season === null : v.season === parsed.season));
      const number = parsed.season === null || parsed.season === undefined ? `E${parsed.episode}` : `S${parsed.season}E${parsed.episode}`;
      const { videoIdAliases } = require('./aliases');
      const keys = [videoId, ...(await videoIdAliases(videoId))];
      if (video?.id) keys.push(video.id, ...(await videoIdAliases(video.id)));
      out = {
        keys,
        title: index?.name ?? videoId,
        episode: video?.title ? `${number} ${video.title}` : number,
        imageUrl: video?.thumbnail ?? index?.background ?? null,
        posterUrl: index?.poster ?? null,
        seriesId: index?.id ?? parsed.base,
        season: parsed.season ?? null,
        number: parsed.episode,
        episodeTitle: video?.title ?? null,
      };
    } else if (parsed) {
      const meta = await withDeadline(fetchMeta(userUUID, 'movie', parsed.base));
      const keys = [videoId];
      for (const id of [meta?.id, meta?._imdbId, meta?.imdb_id, meta?._tmdbId && `tmdb:${meta._tmdbId}`]) if (id) keys.push(String(id));
      out = {
        keys,
        title: meta?.name ?? videoId,
        episode: null,
        imageUrl: meta?.background ?? meta?.poster ?? null,
        posterUrl: meta?.poster ?? null,
        seriesId: null,
        season: null,
        number: null,
        episodeTitle: null,
      };
    }
  } catch {
    // The id stands in for the name.
  }
  if (out.title !== videoId) titles.set(key, out);
  return out;
}

function profileNames(config: any, userUUID: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const profile of listProfiles(config, userUUID)) names.set(profile.id ?? '', profile.name);
  return names;
}

// A profile that writes to the trackers plays into the account's history, under the main key.
function historyProfiles(config: any, userUUID: string): Array<{ key: string; name: string; sharedWith: string[] }> {
  const out: Array<{ key: string; name: string; sharedWith: string[] }> = [];
  for (const profile of listProfiles(config, userUUID)) {
    if (profile.id && profile.sharesHistory) out[0]?.sharedWith.push(profile.name);
    else out.push({ key: profile.id ?? '', name: profile.name, sharedWith: [] });
  }
  return out;
}

const profileLabel = (names: Map<string, string>, key: string): string =>
  names.get(key) ?? (key ? key.slice(0, 8) : 'Main');

async function playRows(userUUID: string, rows: any[], names: Map<string, string>): Promise<PlayRow[]> {
  const described = await mapWithConcurrency(rows, envInt('JELLYFIN_DASHBOARD_DESCRIBE_CONCURRENCY', 8, 1), (row: any) => describe(userUUID, String(row.video_id)));
  const seen = new Set<string>();
  const out: PlayRow[] = [];
  rows.forEach((row, i) => {
    const videoId = String(row.video_id);
    const named = described[i];
    // One title, one card: the same play is stored under every spelling, and a rewatch shows as the newest.
    const keys = named.keys.map((id) => `${row.profile}|${id}`);
    if (keys.some((key) => seen.has(key))) return;
    for (const key of keys) seen.add(key);
    out.push({
      profile: profileLabel(names, String(row.profile ?? '')),
      videoId,
      imageUrl: named.imageUrl,
      posterUrl: named.posterUrl,
      title: named.title,
      episode: named.episode,
      seriesId: named.seriesId,
      season: named.season,
      number: named.number,
      episodeTitle: named.episodeTitle,
      positionMs: Number(row.position_ms) || 0,
      runtimeMs: Number(row.runtime_ms) || 0,
      played: Boolean(row.played),
      lastPlayedAt: row.last_played_at ? Number(row.last_played_at) : null,
      updatedAt: Number(row.updated_at) || 0,
    });
  });
  return out;
}
async function sessionRows(userUUID: string, names: Map<string, string>): Promise<SessionRow[]> {
  const own = (await liveSessions()).filter((s) => s.userUUID === userUUID);
  return mapWithConcurrency(own, 2, async (s) => {
    const descriptor = await decodeJellyfinId(s.itemId);
    const videoId = descriptor ? stremioIdFor(descriptor) : null;
    const named: Named = videoId ? await describe(userUUID, videoId) : { keys: [s.itemId], title: s.itemId, episode: null, imageUrl: null, posterUrl: null, seriesId: null, season: null, number: null, episodeTitle: null };
    const viewer = s.viewer && s.viewer !== s.profile ? names.get(s.viewer) ?? s.viewer.slice(0, 8) : null;
    return { profile: profileLabel(names, s.profile), profileKey: s.profile, viewer, imageUrl: named.imageUrl, title: named.title, episode: named.episode, positionMs: s.positionMs, paused: s.paused, at: s.at };
  });
}

let overviewMemo: { at: number; value: any } | null = null;

/** Instance signals that cost nothing that grows with the table. */
export async function dashboardOverview(): Promise<any> {
  const ttl = envInt('JELLYFIN_DASHBOARD_TOTALS_TTL', 60, 1) * 1000;
  const now = Date.now();
  const sessions = await liveSessions();
  if (overviewMemo && now - overviewMemo.at < ttl) {
    return { ...overviewMemo.value, ...liveCounts(sessions, now), sync: syncStatus() };
  }
  const [playedDay, playedWeek, seen] = await Promise.all([
    database.countPlayedSince(now - 24 * 60 * 60 * 1000),
    database.countPlayedSince(now - 7 * 24 * 60 * 60 * 1000),
    seenConfigurations(),
  ]);
  const value = {
    playedDay,
    playedWeek,
    activeConfigurations: seen ? seen.length : null,
    activeDays: envInt('JELLYFIN_ACTIVE_DAYS', 7, 1),
  };
  overviewMemo = { at: now, value };
  return { ...value, ...liveCounts(sessions, now), sync: syncStatus() };
}

function liveCounts(sessions: LiveSession[], now: number): { playingNow: number; pausedNow: number; sessions: number } {
  const window = envInt('JELLYFIN_DASHBOARD_LIVE_SECONDS', 120, 10) * 1000;
  const fresh = sessions.filter((s) => now - s.at <= window);
  return {
    playingNow: fresh.filter((s) => !s.paused).length,
    pausedNow: fresh.filter((s) => s.paused).length,
    sessions: sessions.length,
  };
}

export interface SearchRow {
  userUUID: string;
  label: string;
  profiles: Array<{ key: string; name: string }>;
  lastActivity: number | null;
}

/** Configurations matching an id prefix, or a user name among the active ones. */
export async function dashboardSearch(query: string): Promise<{ query: string; results: SearchRow[] }> {
  const limit = envInt('JELLYFIN_DASHBOARD_SEARCH_LIMIT', 30, 1);
  const q = query.trim();
  if (!q) return { query: q, results: [] };

  const candidates = new Set<string>();
  if (/^[0-9a-f-]{2,36}$/i.test(q)) {
    for (const uuid of await database.findUserUUIDsByPrefix(q.toLowerCase(), limit)) candidates.add(uuid);
  }
  if (candidates.size === 0) {
    const needle = q.toLowerCase();
    const seen = ((await seenConfigurations()) ?? []).slice(0, envInt('JELLYFIN_DASHBOARD_NAME_SCAN_MAX', 200, 1));
    const matched = await mapWithConcurrency(seen, envInt('JELLYFIN_DASHBOARD_SEARCH_CONCURRENCY', 8, 1), async (uuid: string) => {
      const config = await database.getUserConfig(uuid).catch(() => null);
      return config && listProfiles(config, uuid).some((p) => p.name.toLowerCase().includes(needle)) ? uuid : null;
    });
    for (const uuid of matched) if (uuid && candidates.size < limit) candidates.add(uuid);
  }

  const results = (await mapWithConcurrency([...candidates].slice(0, limit), 4, async (uuid: string): Promise<SearchRow | null> => {
    const config = await database.getUserConfig(uuid).catch(() => null);
    if (!config) return null;
    const byProfile: any[] = await database.playstateForConfiguration(uuid);
    const lastActivity = byProfile.reduce((at: number, p: any) => Math.max(at, Number(p.last_played_at) || 0, Number(p.updated_at) || 0), 0) || null;
    return { userUUID: uuid, label: defaultUserName(config, uuid), profiles: [...profileNames(config, uuid).entries()].map(([key, name]) => ({ key, name })), lastActivity };
  })).filter((r): r is SearchRow => r !== null);
  return { query: q, results: results.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)) };
}

/** One configuration: its profiles with counts, and the sessions, positions and recent plays of one profile or all. */
export async function dashboardConfiguration(userUUID: string, profile: string | null, rows?: number): Promise<any> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  if (!config) return null;
  const names = profileNames(config, userUUID);
  const limit = Math.min(500, Math.max(1, rows || envInt('JELLYFIN_DASHBOARD_ROWS', 50, 1)));
  const byProfile: any[] = await database.playstateForConfiguration(userUUID);
  const profiles = historyProfiles(config, userUUID).map(({ key, name, sharedWith }) => {
    const p = byProfile.find((row: any) => String(row.profile ?? '') === key);
    return {
      key,
      name,
      sharedWith,
      inProgress: Number(p?.in_progress) || 0,
      played: Number(p?.played) || 0,
      lastActivity: Math.max(Number(p?.last_played_at) || 0, Number(p?.updated_at) || 0) || null,
    };
  });
  const folded = async (fetch: (n: number) => Promise<any[]>): Promise<PlayRow[]> => {
    let want = limit * 2;
    for (;;) {
      const rows = await fetch(want);
      const out = await playRows(userUUID, rows, names);
      if (out.length >= limit || rows.length < want || want >= limit * 16) return out.slice(0, limit);
      want *= 2;
    }
  };
  const [inProgress, recentlyPlayed] = await Promise.all([
    folded((n) => database.listPlaystateInProgressFor(userUUID, n, profile)),
    folded((n) => database.listPlaystatePlayedFor(userUUID, n, profile)),
  ]);
  const sessions = (await sessionRows(userUUID, names)).filter((s) => profile === null || s.profileKey === profile);
  return {
    userUUID,
    label: defaultUserName(config, userUUID),
    profile,
    rows: limit,
    profiles,
    sessions,
    inProgress,
    recentlyPlayed,
  };
}

/** Every row the table holds for a configuration, as stored. */
export async function dashboardExport(userUUID: string): Promise<any> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  const names = config ? profileNames(config, userUUID) : new Map<string, string>();
  const rows: any[] = await database.listPlaystateFor(userUUID);
  return {
    userUUID,
    label: config ? defaultUserName(config, userUUID) : userUUID.slice(0, 8),
    exportedAt: new Date().toISOString(),
    profiles: [...names.entries()].map(([key, name]) => ({ key, name })),
    rows: rows.map((row) => ({
      profile: String(row.profile ?? ''),
      videoId: String(row.video_id),
      positionMs: Number(row.position_ms) || 0,
      runtimeMs: Number(row.runtime_ms) || 0,
      played: Boolean(row.played),
      playCount: Number(row.play_count) || 0,
      lastPlayedAt: row.last_played_at ? new Date(Number(row.last_played_at)).toISOString() : null,
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
    })),
  };
}
