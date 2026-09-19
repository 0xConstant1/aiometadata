import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import redis from '../redisClient';
import { decodeJellyfinId, encodeJellyfinId, normaliseJellyfinId, parseStremioId, stremioIdFor } from './ids';
import { mapWithConcurrency } from '../../utils/concurrency';
import { fetchMeta } from './items';
import { upsertPlaystateEverywhere } from './aliases';

const logger = consola.withTag('JellyfinPlaystate');

const TICKS_PER_MS = 10000;

function watchedAtPercent(): number {
  return envInt('JELLYFIN_PLAYED_THRESHOLD', 80, 1);
}

interface SessionPosition {
  positionMs: number;
  at: number;
  writtenAt?: number;
  writtenMs?: number;
  /** Last reported pause state, so only the change is acted on. */
  paused?: boolean;
  /** The profile signed in, which may be playing into the account's shared history. */
  viewer?: string | null;
}

// A client that dies never sends a stop, so the last tick is kept and a stop
// arriving without a position can still say where it got to. Kept in Redis so
// a session survives this process restarting under it: otherwise the resume
// after a restart reads as the first event and is swallowed as no transition.
const positions = new LRUCache<string, SessionPosition>({
  max: envInt('JELLYFIN_SESSION_CACHE_MAX', 5000, 1),
  ttl: envInt('JELLYFIN_SESSION_CACHE_TTL', 12 * 60 * 60, 60) * 1000,
});

function sessionTtlSeconds(): number {
  return envInt('JELLYFIN_SESSION_CACHE_TTL', 12 * 60 * 60, 60);
}

async function getPosition(key: string): Promise<SessionPosition | undefined> {
  const local = positions.get(key);
  if (local) return local;
  if (!redis) return undefined;
  try {
    const stored = await redis.get(`jf:pos:${key}`);
    if (!stored) return undefined;
    const parsed = JSON.parse(stored) as SessionPosition;
    positions.set(key, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

function setPosition(key: string, value: SessionPosition): void {
  positions.set(key, value);
  if (redis) redis.set(`jf:pos:${key}`, JSON.stringify(value), 'EX', sessionTtlSeconds()).catch(() => undefined);
}

function deletePosition(key: string): void {
  positions.delete(key);
  if (redis) redis.del(`jf:pos:${key}`).catch(() => undefined);
}

/** Sessions this process has heard from, newest first, for the dashboard. */
export function liveSessions(): Array<{ userUUID: string; profile: string; viewer: string | null; itemId: string; positionMs: number; at: number; paused: boolean }> {
  const out: Array<{ userUUID: string; profile: string; viewer: string | null; itemId: string; positionMs: number; at: number; paused: boolean }> = [];
  for (const [key, value] of positions.entries()) {
    const [userUUID, profile, itemId] = key.split(':');
    if (!userUUID || !itemId) continue;
    out.push({ userUUID, profile: profile || '', viewer: value.viewer ?? null, itemId, positionMs: value.positionMs, at: value.at, paused: value.paused === true });
  }
  return out.sort((a, b) => b.at - a.at);
}

function ticksToMs(value: any): number | null {
  const ticks = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isFinite(ticks) ? Math.round(ticks / TICKS_PER_MS) : null;
}

function bodyItemId(req: any, body: any): string | null {
  const raw = body?.ItemId ?? body?.itemId ?? req.params?.itemId;
  return raw ? normaliseJellyfinId(String(raw)) : null;
}

export interface ResolvedSession {
  stremioType: 'movie' | 'series';
  videoId: string;
  descriptor: any;
  runtimeMs: number | null;
  runtimeFrom?: 'client' | 'file';
  /** The same film under the ids the meta carries, written alongside so any spelling reads back. */
  aliases: string[];
}

// The runtime is not in any playstate payload, so it comes from the meta.
async function resolveSession(userUUID: string, itemId: string, known?: any): Promise<ResolvedSession | null> {
  const descriptor = await decodeJellyfinId(itemId);
  if (!descriptor) return null;
  if (descriptor.k !== 'movie' && descriptor.k !== 'episode') return null;

  const videoId = stremioIdFor(descriptor);
  if (!videoId) return null;

  const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
  const meta = known ?? (await fetchMeta(userUUID, stremioType, descriptor.i));

  let runtimeMs: number | null = null;
  const aliases: string[] = [];
  if (meta) {
    let runtime = meta.runtime;
    if (descriptor.k === 'episode' && Array.isArray(meta.videos)) {
      const video = meta.videos.find((v: any) => String(v?.id) === videoId);
      if (video?.runtime) runtime = video.runtime;
    }
    runtimeMs = parseRuntimeMs(runtime);
    if (descriptor.k === 'movie') {
      const imdb = meta._imdbId || meta.imdb_id;
      if (imdb) aliases.push(String(imdb));
      if (meta._tmdbId) aliases.push(`tmdb:${meta._tmdbId}`);
    }
  }

  return { stremioType, videoId, descriptor, runtimeMs, aliases: aliases.filter((id) => id !== videoId) };
}

// The percentage is over the file's own length: the player's if the client
// sends one, else what the stream addon reported, else the metadata's.
async function resolvePlaying(userUUID: string, itemId: string, body: any): Promise<ResolvedSession | null> {
  const session = await resolveSession(userUUID, itemId);
  if (!session) return null;
  const reported = ticksToMs(body?.Item?.RunTimeTicks ?? body?.NowPlayingItem?.RunTimeTicks ?? body?.RunTimeTicks);
  if (reported && reported > 0) return { ...session, runtimeMs: reported, runtimeFrom: 'client' };
  const { recallDuration } = require('./streams');
  const fileDuration = await recallDuration(body?.MediaSourceId ?? body?.mediaSourceId);
  return fileDuration ? { ...session, runtimeMs: fileDuration, runtimeFrom: 'file' } : session;
}

function parseRuntimeMs(runtime: any): number | null {
  if (typeof runtime !== 'string') return null;
  const hours = /(\d+)\s*h/.exec(runtime);
  const minutes = /(\d+)\s*min/.exec(runtime);
  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  return total > 0 ? total * 60 * 1000 : null;
}

function reportFor(
  session: ResolvedSession,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed',
  positionMs: number | null,
  played: boolean | null,
  resumedFrom: number | null = null
): any {
  const d = session.descriptor;
  return {
    // Keyed on position, not a clock bucket: pausing and resuming inside a
    // minute are real transitions a time bucket would collapse into one.
    // A mark carries no position, so keying on it alone made every later mark of
    // the same title read as the first one being retried and it was dropped.
    // Nothing retries on this path, a client calls once, so each mark is its own
    // event and repeats are caught by the decision it carries instead.
    id:
      event === 'played' || event === 'unplayed'
        ? `jellyfin|${session.videoId}|${event}|${Date.now()}`
        : `jellyfin|${session.videoId}|${event}|${positionMs ?? 0}${resumedFrom ? `|r${resumedFrom}` : ''}`,
    event,
    at: Math.floor(Date.now() / 1000),
    metaId: d.i,
    videoId: session.videoId,
    positionMs: positionMs ?? 0,
    durationMs: session.runtimeMs ?? 0,
    played,
    season: d.k === 'episode' ? d.s : null,
    episode: d.k === 'episode' ? d.e : null,
    ids: {},
  };
}

async function recordPlaystate(
  userUUID: string,
  profile: string,
  session: ResolvedSession,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed',
  positionMs: number,
  played: boolean | null
): Promise<void> {
  const database: any = require('../database');
  const videoId = session.videoId;
  const runtimeMs = session.runtimeMs ?? 0;

  try {
    if (event === 'unplayed') {
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, played: false, lastPlayedAt: null }, profile, session.aliases);
      return;
    }
    if (event === 'played') {
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, runtimeMs, played: true, lastPlayedAt: Date.now() }, profile, session.aliases);
      return;
    }
    if (event === 'stop' && played === true) {
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, runtimeMs, played: true, lastPlayedAt: Date.now() }, profile, session.aliases);
      return;
    }
    await upsertPlaystateEverywhere(userUUID, videoId, { positionMs, runtimeMs, lastPlayedAt: Date.now() }, profile, session.aliases);
  } catch (error: any) {
    logger.warn(`Playstate write failed for ${videoId}: ${error?.message || error}`);
  }
}

async function report(
  req: any,
  body: any,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed'
): Promise<void> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  if (!userUUID || !itemId) return;

  const { loadConfig } = require('./context');
  const config = await loadConfig(req);
  if (!config?.playbackReporting) return;

  const session = await resolvePlaying(userUUID, itemId, body);
  if (!session) {
    logger.debug(`No playable session for ${itemId}`);
    return;
  }
  logger.debug(`${event} from ${String(req.get?.('user-agent') || '').split(' ')[0] || 'unknown client'} for ${session.videoId} source ${body?.MediaSourceId ?? '?'}: runtime ${session.runtimeMs ?? 0}ms from the ${session.runtimeFrom ?? 'metadata'}`);

  const { profileKey, writesTrackers } = require('./profiles');
  const profile = profileKey(config);
  const key = `${userUUID}:${profile}:${itemId}`;
  const known = await getPosition(key);
  const reported = ticksToMs(body?.PositionTicks ?? body?.positionTicks);
  // A resume reported at zero is the client's habit, not a seek to the start.
  const resumedFrom = event === 'start' && known?.paused ? known.at : null;
  const positionMs = (resumedFrom && !reported ? known?.positionMs : reported) ?? known?.positionMs ?? 0;
  logger.debug(`${event} ${session.videoId}: client sent ${reported ?? 'no'} position, held ${known?.positionMs ?? 'none'}, using ${positionMs}ms`);

  // A client re-sends Playing while it runs; reopening an already-playing
  // session is noise. A resume comes through the pause edge instead.
  if (event === 'start' && known && known.paused === false) {
    setPosition(key, { positionMs, at: Date.now(), paused: false, viewer: req.jellyfin?.profileId ?? null });
    return;
  }

  let played: boolean | null = null;
  if (event === 'played') played = true;
  if (event === 'stop') {
    played =
      session.runtimeMs && session.runtimeMs > 0
        ? (positionMs / session.runtimeMs) * 100 >= watchedAtPercent()
        : false;
    deletePosition(key);
  } else {
    // Recorded as playing, not unknown: a following tick reporting the same
    // state would otherwise read as a change and reopen the session.
    setPosition(key, { positionMs, at: Date.now(), paused: event === 'pause', viewer: req.jellyfin?.profileId ?? null });
  }

  // The table is written before any tracker is told, so a read never waits on one.
  await recordPlaystate(userUUID, profile, session, event, positionMs, played);
  if (played === true && session.descriptor.k === 'episode') {
    const { undropOnWatch } = require('./dropped');
    undropOnWatch(userUUID, config, [session.descriptor.i]);
  }

  // A separate viewer's plays are not the account's history.
  if (!writesTrackers(config)) return;

  // A pause at zero is what a collapsed position looks like, and a real one says
  // nothing a tracker can use, so it is remembered without writing a resume
  // point every service would then show as continue-watching from the start.
  if (event === 'pause' && positionMs <= 0) {
    logger.debug(`Not reporting a pause at zero for ${session.videoId}`);
    return;
  }

  await tellTrackers(userUUID, config, session, event, positionMs, played, true, resumedFrom);
}

async function tellTrackers(
  userUUID: string,
  config: any,
  session: ResolvedSession,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed',
  positionMs: number,
  played: boolean | null,
  refreshWatched = true,
  resumedFrom: number | null = null
): Promise<void> {
  const { handlePlaybackReport } = require('../playbackHandler');
  await handlePlaybackReport(
    session.stremioType,
    session.videoId,
    reportFor(session, event, positionMs, played, resumedFrom),
    config,
    userUUID
  );

  // The trackers now hold state this server just changed, so the snapshots the
  // resume shelf and the watched ticks read from are dropped rather than left
  // serving what they cached before the event.
  const { invalidateResume } = require('./resume');
  const { invalidateWatched } = require('./watched');
  invalidateResume(userUUID);

  // A finished stop or a mark changes what the tracker holds, such as a show's
  // next episode; a batch of marks drops the snapshot once, after the batch.
  if ((event === 'stop' && played === true) || (refreshWatched && (event === 'played' || event === 'unplayed'))) {
    await invalidateWatched(config).catch(() => undefined);
  }
}

export async function recordPlaying(req: any, body: any): Promise<void> {
  await report(req, body, 'start');
}

export async function recordStopped(req: any, body: any): Promise<void> {
  await report(req, body, 'stop');
}

/** The mark-watched a client offers on an item, taken without it being played. */
// A client marks a season or a whole series with one call on that item's id;
// the mark applies to each aired episode in it. The table is written for all
// of them before this returns, since the client reads the item back straight
// after and a half-marked season shows no tick; the trackers are told after.
async function markEach(req: any, body: any, event: 'played' | 'unplayed'): Promise<void> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  if (!userUUID || !itemId) return;

  const { loadConfig } = require('./context');
  const config = await loadConfig(req);
  if (!config?.playbackReporting) return;

  const { profileKey, writesTrackers } = require('./profiles');
  const profile = profileKey(config);
  const played = event === 'played';

  // A mark on a title the server still holds as playing is the stop that never arrived.
  const open = await getPosition(`${userUUID}:${profile}:${itemId}`);
  if (open && !open.paused && isPlayable(await decodeJellyfinId(itemId))) {
    const session = await resolveSession(userUUID, itemId);
    deletePosition(`${userUUID}:${profile}:${itemId}`);
    if (session && writesTrackers(config)) {
      const at = played ? (session.runtimeMs ?? open.positionMs) : open.positionMs;
      await tellTrackers(userUUID, config, session, 'stop', at, played, false).catch((error: any) =>
        logger.debug(`Closing the open session before a mark failed for ${itemId}: ${error?.message || error}`)
      );
    }
  }

  const marked = await markedItemIds(userUUID, itemId);
  const sessions = (await mapWithConcurrency(marked.ids, 8, async (id: string) => {
    const session = await resolveSession(userUUID, id, marked.meta);
    if (!session) {
      logger.debug(`No playable session for ${id}`);
      return null;
    }
    deletePosition(`${userUUID}:${profile}:${id}`);
    await recordPlaystate(userUUID, profile, session, event, 0, played);
    return session;
  })).filter((s): s is ResolvedSession => s !== null);

  if (played) {
    const { undropOnWatch } = require('./dropped');
    undropOnWatch(userUUID, config, sessions.filter((session) => session.descriptor.k === 'episode').map((session) => session.descriptor.i));
  }
  if (!writesTrackers(config)) return;
  // A season or series goes to the trackers as one batch, not an event per episode.
  if (marked.scope) {
    const { handlePlaybackReport } = require('../playbackHandler');
    const { invalidateResume } = require('./resume');
    invalidateResume(userUUID);
    handlePlaybackReport('series', marked.metaId, {
      scope: marked.scope,
      event,
      metaId: marked.metaId,
      videos: sessions.map((session) => ({ videoId: session.videoId })),
    }, config, userUUID).catch((error: any) => logger.debug(`Mark report failed for ${itemId}: ${error?.message || error}`));
    return;
  }
  const { invalidateWatched } = require('./watched');
  mapWithConcurrency(sessions, 3, (session: ResolvedSession) => tellTrackers(userUUID, config, session, event, 0, played, false))
    .then(() => invalidateWatched(config))
    .catch((error: any) => logger.debug(`Mark report failed for ${itemId}: ${error?.message || error}`));
}

const isPlayable = (descriptor: any): boolean => descriptor?.k === 'movie' || descriptor?.k === 'episode';

/** The item itself, or each aired episode of the season or series it names, with the meta they share. */
async function markedItemIds(
  userUUID: string,
  itemId: string
): Promise<{ ids: string[]; meta?: any; scope?: 'season' | 'series'; metaId?: string }> {
  const descriptor = await decodeJellyfinId(itemId);
  if (!descriptor || (descriptor.k !== 'season' && descriptor.k !== 'series')) return { ids: [itemId] };

  const meta = await fetchMeta(userUUID, 'series', descriptor.i);
  const videos: any[] = Array.isArray(meta?.videos) ? meta.videos : [];
  const now = Date.now();
  const ids: string[] = [];
  for (const video of videos) {
    if (descriptor.k === 'season' ? video.season !== descriptor.s : video.season === 0) continue;
    const aired = Date.parse(video.released || '');
    if (Number.isFinite(aired) && aired > now) continue;
    const parsed = parseStremioId(String(video.id ?? ''));
    if (parsed) ids.push(encodeJellyfinId({ k: 'episode', t: descriptor.t, i: parsed.base, s: parsed.season, e: parsed.episode as number }));
  }
  return { ids, meta, scope: descriptor.k, metaId: descriptor.i };
}

export async function recordPlayed(req: any, body: any): Promise<void> {
  await markEach(req, body, 'played');
}

export async function recordUnplayed(req: any, body: any): Promise<void> {
  await markEach(req, body, 'unplayed');
}

/**
 * Progress is not forwarded anywhere: no tracker has an endpoint for it. It is
 * only remembered, so a stop that arrives without a position still has one.
 */
export async function recordProgress(req: any, body: any): Promise<void> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  const positionMs = ticksToMs(body?.PositionTicks ?? body?.positionTicks);
  if (!userUUID || !itemId) return;
  if (positionMs === null) {
    logger.debug(`Progress for ${itemId} carries no position`);
    return;
  }

  const { loadConfig } = require('./context');
  const { profileKey } = require('./profiles');
  const key = `${userUUID}:${profileKey(await loadConfig(req))}:${itemId}`;
  const previous = await getPosition(key);
  const paused = body?.IsPaused === true || body?.isPaused === true;

  // A client keeps reporting every few seconds while paused, so only the change
  // is worth acting on: pausing stores a resume point, resuming reopens the
  // session at the position it left off. The state is left for report() to
  // write, since it decides against what the session was, not what it is.
  const changed = previous !== undefined && previous.paused !== paused;
  const startsPaused = previous === undefined && paused;
  if (!changed && !startsPaused) {
    const now = Date.now();
    const next: SessionPosition = { positionMs, at: now, paused, writtenAt: previous?.writtenAt, writtenMs: previous?.writtenMs, viewer: req.jellyfin?.profileId ?? previous?.viewer ?? null };
    // Table only; a tracker still hears edges alone.
    const interval = envInt('JELLYFIN_PROGRESS_WRITE_INTERVAL', 60, 0) * 1000;
    const moved = positionMs !== (previous?.writtenMs ?? -1);
    if (interval > 0 && !paused && moved && now - (previous?.writtenAt ?? 0) >= interval) {
      const config = await loadConfig(req);
      const session = config ? await resolvePlaying(userUUID, itemId, body) : null;
      if (session) {
        logger.debug(`Progress ${session.videoId} at ${positionMs}ms`);
        await recordPlaystate(userUUID, profileKey(config), session, 'start', positionMs, null);
        next.writtenAt = now;
        next.writtenMs = positionMs;
      }
    }
    setPosition(key, next);
    return;
  }

  await report(req, body, paused ? 'pause' : 'start');
}

/**
 * The one-call edit of an item's state a client offers next to mark-watched: a
 * played flag, or a resume position, which cleared is what drops the item from
 * continue watching. Answers the state the item is now in.
 */
export async function recordUserData(req: any, body: any): Promise<{ played: boolean; positionMs: number } | null> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  if (!userUUID || !itemId) return null;

  const played = body?.Played ?? body?.played;
  if (played === true || played === false) {
    await markEach(req, { ItemId: itemId }, played ? 'played' : 'unplayed');
    return { played, positionMs: 0 };
  }

  const positionMs = ticksToMs(body?.PlaybackPositionTicks ?? body?.playbackPositionTicks);
  if (positionMs === null) {
    logger.debug(`User data for ${itemId} carries neither Played nor a position: ${Object.keys(body || {}).join(',') || 'empty body'} (${req.get?.('content-type') || 'no content type'})`);
    return null;
  }

  const { loadConfig } = require('./context');
  const config = await loadConfig(req);
  if (!config?.playbackReporting) {
    logger.debug(`User data for ${itemId} ignored: playback reporting is off`);
    return null;
  }

  const session = await resolveSession(userUUID, itemId);
  if (!session) {
    logger.debug(`No playable session for ${itemId}`);
    return null;
  }

  const { profileKey } = require('./profiles');
  const profile = profileKey(config);
  deletePosition(`${userUUID}:${profile}:${itemId}`);
  await upsertPlaystateEverywhere(userUUID, session.videoId, { positionMs, runtimeMs: session.runtimeMs ?? 0 }, profile, session.aliases);

  const { invalidateResume } = require('./resume');
  invalidateResume(userUUID);

  // Cleared here means cleared on the trackers too, or their copy would come
  // back through the shelf on any device reading them directly.
  const { writesTrackers } = require('./profiles');
  if (positionMs === 0 && writesTrackers(config)) {
    const { parseMediaId, clearResumePoint } = require('../subtitleHandler');
    const parsed = parseMediaId(session.videoId);
    if (parsed) {
      clearResumePoint(parsed, config).catch((error: any) =>
        logger.debug(`Clearing the resume point on trackers failed for ${session.videoId}: ${error?.message || error}`)
      );
    }
  }

  const database: any = require('../database');
  const row = await database.getPlaystate(userUUID, session.videoId, profile);
  return { played: Boolean(row?.played), positionMs };
}
