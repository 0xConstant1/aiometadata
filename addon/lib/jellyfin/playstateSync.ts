import consola from 'consola';
import { envInt } from '../../utils/envNumber';
import { sourceFor } from './trackerSource';
import { getPlaystatesAcross, upsertPlaystateEverywhere } from './aliases';

const logger = consola.withTag('Jellyfin');

const database: any = require('../database');
const { runWithRequestContext }: any = require('../logBuffer');

// Pulls tracker state into the playstate table. The table wins on anything it
// already holds; only titles it has never seen are taken from the tracker.
export async function syncPlaystateFor(userUUID: string, config: any): Promise<{ added: number; skipped: number; unchanged?: boolean }> {
  const { trackerSnapshot } = require('./resume');
  const { watchedSnapshot, allWatched } = require('./watched');

  let added = 0;
  let skipped = 0;

  const resume = await trackerSnapshot(userUUID, config);
  const snapshot = await watchedSnapshot(userUUID, config);

  // A pass only takes in what the tracker says, and the table wins over anything it has
  // already seen, so a tracker unchanged since the last pass has nothing new to give.
  const { createHash } = require('crypto');
  const { readGlobalCache, writeGlobalCache } = require('../getCache');
  const digest = snapshot.fingerprint
    ? createHash('sha256').update(`${snapshot.fingerprint}|${resume.map((row: any) => `${row.videoId}:${row.progress}:${row.updatedAt}`).join(',')}`).digest('hex').substring(0, 16)
    : '';
  const passKey = `jellyfin_playstate_pass_v1:${userUUID}`;
  if (digest && (await readGlobalCache(passKey))?.digest === digest) return { added, skipped, unchanged: true };
  for (const row of resume) {
    // The most recent action wins: a point the tracker set after this row's last
    // change replaces it, whether the row is a point, a mark or a rewatch; an
    // older one is what the row already replaced.
    const existing = await database.getPlaystate(userUUID, row.videoId);
    if (existing && !((row.updatedAt || 0) > Number(existing.updated_at))) {
      skipped += 1;
      continue;
    }
    if (row.progress <= 0) continue;

    // Simkl sends a percentage and no runtime, so the runtime comes from the meta.
    const runtimeMs = (row.runtimeMinutes ?? 0) * 60000 || (await runtimeFromMeta(userUUID, row));
    if (runtimeMs <= 0) continue;

    await upsertPlaystateEverywhere(userUUID, row.videoId, {
      positionMs: Math.round((runtimeMs * row.progress) / 100),
      runtimeMs,
      lastPlayedAt: row.updatedAt || null,
    });
    added += 1;
  }

  // A row holding a resume point the tracker no longer has, on a title its
  // history lists as watched after that point, was finished elsewhere: the
  // tracker's last word on it is the watch. A watch older than the point, or
  // one the tracker cannot date, is the earlier viewing this row is a rewatch of.
  const paused = new Set(resume.map((row) => row.videoId));
  const watched = await allWatched(snapshot);
  const finished = [...watched.episodes, ...watched.movies];
  const known = await getPlaystatesAcross(userUUID, finished);
  for (const videoId of finished) {
    const row = known.get(videoId);
    // An import written without a date takes the tracker's once it has one.
    if (row && row.played && !row.last_played_at && !Number(row.position_ms) && watched.at.get(videoId)) {
      await upsertPlaystateEverywhere(userUUID, videoId, { lastPlayedAt: watched.at.get(videoId) });
      added += 1;
      continue;
    }
    if (row && (row.played || paused.has(videoId))) {
      skipped += 1;
      continue;
    }
    // An unplayed row, part-played or marked so here, keeps its state unless
    // the tracker dates the watch after it; an undated watch cannot outrank it.
    if (row && !((watched.at.get(videoId) ?? 0) > Number(row.updated_at))) {
      skipped += 1;
      continue;
    }
    await upsertPlaystateEverywhere(userUUID, videoId, row ? { positionMs: 0, played: true } : { positionMs: 0, played: true, lastPlayedAt: watched.at.get(videoId) ?? null });
    added += 1;
  }

  // Passed again at least this often, whatever the tracker says, in case a pass was cut short.
  if (digest) await writeGlobalCache(passKey, { digest }, envInt('JELLYFIN_PLAYSTATE_SYNC_RECHECK_HOURS', 24, 1) * 60 * 60);
  return { added, skipped };
}

export async function runtimeFromMeta(userUUID: string, row: any): Promise<number> {
  const { fetchMeta } = require('./items');
  const { parseStremioId } = require('./ids');
  try {
    const meta = await fetchMeta(userUUID, row.kind === 'movie' ? 'movie' : 'series', row.metaId);
    if (!meta) return 0;

    let runtime: any = meta.runtime;
    if (row.kind === 'episode') {
      const parsed = parseStremioId(row.videoId);
      const video = (meta.videos || []).find((v: any) => String(v.id) === row.videoId)
        || (parsed && (meta.videos || []).find((v: any) => v.season === parsed.season && v.episode === parsed.episode));
      runtime = video?.runtime || runtime;
    }

    const text = String(runtime || '');
    const hours = /(\d+)\s*h/.exec(text);
    const minutes = /(\d+)\s*min/.exec(text);
    const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
    return total > 0 ? total * 60000 : 0;
  } catch {
    return 0;
  }
}

let running = false;
const lastSync = { startedAt: 0, finishedAt: 0, configurations: 0, added: 0, reached: 0, total: 0, timedOut: 0, complete: true };
// Where the last run stopped, so one cut short by its budget carries on from there.
let cursor = 0;
let followUp: NodeJS.Timeout | null = null;

const TIMED_OUT = Symbol('timed out');

export function syncStatus() {
  return { ...lastSync, running };
}

/** What the sync is doing, for a note beside an event loop stall. */
export function syncActivity(): string | null {
  return running ? `playstate sync running (${lastSync.reached} of ${lastSync.total} configurations reached)` : null;
}

function withinTime<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** One configuration's tracker positions and watches, then its Next Up index. */
async function syncConfiguration(userUUID: string): Promise<{ added: number } | null> {
  let config: any;
  try {
    config = await database.getUserConfig(userUUID);
  } catch {
    return null;
  }
  if (!config || !sourceFor(config)) return null;

  let added = 0;
  try {
    const result = await runWithRequestContext(userUUID, () => syncPlaystateFor(userUUID, config));
    added = result.added;
  } catch (error: any) {
    logger.debug(`Playstate sync failed for ${userUUID}: ${error?.message || error}`);
  }
  // Keeps the Next Up episode index warm off the request path.
  try {
    const { warmNextUpIndex } = require('./episodeIndex');
    const built = await runWithRequestContext(userUUID, () => warmNextUpIndex(userUUID, config));
    if (built) logger.debug(`Episode index built for ${built} show(s) of ${userUUID}`);
  } catch (error: any) {
    logger.debug(`Episode index warm failed for ${userUUID}: ${error?.message || error}`);
  }
  return { added };
}

/**
 * Configurations used lately, a few at a time, within a budget. What a run does not reach
 * goes first in the next, which comes a minute later rather than a whole interval; one
 * configuration whose tracker hangs gives up its place after a while.
 */
export async function syncAllPlaystate(): Promise<void> {
  if (running) return;
  running = true;
  const started = Date.now();
  const deadline = started + envInt('JELLYFIN_PLAYSTATE_SYNC_BUDGET', 600, 30) * 1000;
  const concurrency = envInt('JELLYFIN_PLAYSTATE_SYNC_CONCURRENCY', 3, 1);
  const perConfigurationMs = envInt('JELLYFIN_PLAYSTATE_SYNC_USER_TIMEOUT', 120, 10) * 1000;
  const activeHours = envInt('JELLYFIN_PLAYSTATE_SYNC_ACTIVE_HOURS', 48, 0);
  Object.assign(lastSync, { startedAt: started, reached: 0, total: 0, timedOut: 0 });

  try {
    const { seenConfigurations, seenConfigurationsSince } = require('./context');
    const seen: string[] | null = activeHours > 0
      ? await seenConfigurationsSince(started - activeHours * 60 * 60 * 1000)
      : await seenConfigurations();
    const uuids: string[] = seen ?? (await database.getAllUserUUIDs());
    const from = uuids.length ? cursor % uuids.length : 0;
    const order = [...uuids.slice(from), ...uuids.slice(0, from)];
    lastSync.total = order.length;

    let next = 0;
    let users = 0;
    let added = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, order.length) }, async () => {
        while (next < order.length && Date.now() < deadline) {
          const userUUID = order[next++];
          lastSync.reached = next;
          await new Promise((resolve) => setImmediate(resolve));
          const outcome = await withinTime(syncConfiguration(userUUID), perConfigurationMs);
          if (outcome === TIMED_OUT) {
            lastSync.timedOut += 1;
            logger.warn(`Playstate sync gave up waiting on ${userUUID} after ${Math.round(perConfigurationMs / 1000)}s`);
          } else if (outcome) {
            users += 1;
            added += outcome.added;
          }
        }
      })
    );

    const complete = next >= order.length;
    cursor = complete ? 0 : (from + next) % Math.max(1, uuids.length);
    const seconds = Math.round((Date.now() - started) / 1000);
    if (!complete) {
      logger.info(`Playstate sync reached ${next} of ${order.length} configuration(s) in its ${seconds}s budget; the rest follow in a minute`);
      if (followUp) clearTimeout(followUp);
      followUp = setTimeout(() => {
        followUp = null;
        syncAllPlaystate().catch(() => undefined);
      }, 60 * 1000);
      followUp.unref?.();
    } else if (added) {
      logger.info(`Playstate sync: ${added} title(s) taken from trackers across ${users} configuration(s) in ${seconds}s`);
    }
    Object.assign(lastSync, { finishedAt: Date.now(), configurations: users, added, complete });
  } finally {
    running = false;
  }
}

export function startPlaystateSync(): void {
  const { registerStallActivity } = require('../eventLoopLag');
  registerStallActivity(syncActivity);
  const intervalMs = envInt('JELLYFIN_PLAYSTATE_SYNC_INTERVAL', 30 * 60, 60) * 1000;
  const initialDelayMs = envInt('JELLYFIN_PLAYSTATE_SYNC_DELAY', 2 * 60, 0) * 1000;

  setTimeout(() => {
    syncAllPlaystate().catch(() => undefined);
    setInterval(() => syncAllPlaystate().catch(() => undefined), intervalMs).unref?.();
  }, initialDelayMs).unref?.();
}
